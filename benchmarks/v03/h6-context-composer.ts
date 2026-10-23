import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type {
  ChoiceSelection,
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  DecisionState,
  PixelRect,
  RasterImage,
  RasterPort,
} from '../../src/entities/contracts.js'
import { limits } from '../../src/entities/contracts.js'
import { ClassifierError, assertActive } from '../../src/entities/errors.js'
import type { PackedBinaryMask } from '../../src/entities/object-proposals.js'
import type { RgbaRaster } from '../../src/entities/representation.js'
import { selection, validateDecision } from '../../src/features/choice.js'
import { unpackBinaryMask } from '../../src/features/segmentation/packed-mask.js'

const H6_FAMILIES = ['D', 'U'] as const
export type H6Family = (typeof H6_FAMILIES)[number]
export type H6DecisionStage = 'presence' | 'nominate-D' | 'nominate-U' | 'final-select'

export const H6_LIMITS = Object.freeze({
  familyCandidates: 36,
  totalCandidates: 72,
  packedMaskBytes: 19 * 1024 * 1024,
  presentationPngBytes: 20 * 1024 * 1024,
  presentationPagesPerFamily: 4,
  candidatesPerAtlasPage: 9,
  atlasWidth: 1440,
  atlasHeight: 1440,
  tileWidth: 480,
  tileHeight: 480,
  finalWidth: 900,
  finalHeight: 320,
  caseDeadlineMs: 240_000,
})

export interface H6ProposalCandidate {
  id: string
  mask: PackedBinaryMask
}

interface H6ComposerInput {
  image: RgbaRaster
  target: string
  exclusions: readonly string[]
  families: Readonly<Record<H6Family, readonly H6ProposalCandidate[]>>
  signal: AbortSignal
}

interface H6PresentedCandidate {
  family: H6Family
  alias: string
  sourceAlias: string
  mask: PackedBinaryMask
  bounds: PixelRect
}

interface H6PresentationPort {
  renderPresence(input: { image: RgbaRaster; signal: AbortSignal }): Promise<readonly RasterImage[]>
  renderNomination(input: {
    image: RgbaRaster
    candidates: readonly H6PresentedCandidate[]
    signal: AbortSignal
  }): Promise<readonly RasterImage[]>
  renderFinal(input: {
    image: RgbaRaster
    candidates: readonly H6PresentedCandidate[]
    signal: AbortSignal
  }): Promise<readonly RasterImage[]>
}

export interface H6DecisionBudgetRecordPort {
  admit(input: {
    stage: H6DecisionStage
    callOrdinal: number
    requestSha256: string
    signal: AbortSignal
  }): void | Promise<void>
  settle(input: {
    stage: H6DecisionStage
    requestSha256: string
    outcome: 'resolved' | 'failed'
    metadata?: DecisionResult['metadata']
    errorCode?: string
  }): void | Promise<void>
}

interface H6ComposerOptions {
  decision: DecisionPort
  imageState: RasterPort['imageState']
  presentation: H6PresentationPort
  budgetRecord: H6DecisionBudgetRecordPort
}

export interface H6PresenceEvidence {
  selection: ChoiceSelection
  metadata: DecisionResult['metadata']
}

export interface H6NominationEvidence {
  family: H6Family
  topFour: string[]
  nomineeAliases: string[]
  selection: ChoiceSelection
  metadata: DecisionResult['metadata']
}

type H6UnknownReason = 'target-absent' | 'presence-unresolved' | 'no-nominees' | 'none-selected'

type H6ComposerResult =
  | {
      status: 'located'
      family: H6Family
      alias: string
      sourceAlias: string
      region: PixelRect
      mask: PackedBinaryMask
      presence: H6PresenceEvidence
      finalSelection: ChoiceSelection
      finalMetadata: DecisionResult['metadata']
      nominations: H6NominationEvidence[]
    }
  | {
      status: 'unknown'
      reason: H6UnknownReason
      presence: H6PresenceEvidence
      finalSelection: ChoiceSelection | null
      finalMetadata: DecisionResult['metadata'] | null
      nominations: H6NominationEvidence[]
    }

interface H6PartialEvidence {
  presence: H6PresenceEvidence | null
  nominations: H6NominationEvidence[]
}

export class H6ComposerFailure extends ClassifierError {
  constructor(
    code: ConstructorParameters<typeof ClassifierError>[0],
    message: string,
    readonly partial: H6PartialEvidence,
    override readonly cause?: unknown,
  ) {
    super(code, message)
    this.name = 'H6ComposerFailure'
  }
}

interface OwnedCandidate extends H6PresentedCandidate {
  familyIndex: number
}

function invalid(message: string): ClassifierError {
  return new ClassifierError('INVALID_INPUT', message)
}

function boundsOfPacked(mask: PackedBinaryMask): PixelRect | undefined {
  let left = mask.width
  let top = mask.height
  let right = -1
  let bottom = -1
  const pixels = mask.width * mask.height
  for (let index = 0; index < pixels; index++) {
    if (((mask.data[index >> 3] ?? 0) & (1 << (index & 7))) === 0) continue
    const x = index % mask.width
    const y = Math.floor(index / mask.width)
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x)
    bottom = Math.max(bottom, y)
  }
  return right < left ? undefined : { left, top, width: right - left + 1, height: bottom - top + 1 }
}

function validatePacked(mask: PackedBinaryMask, width: number, height: number): number {
  if (
    !mask ||
    mask.format !== 'binary-lsb0' ||
    !(mask.data instanceof Uint8Array) ||
    mask.width !== width ||
    mask.height !== height
  )
    throw invalid('H6 candidate mask format or dimensions are invalid')
  const pixels = width * height
  const expected = Math.ceil(pixels / 8)
  if (mask.data.byteLength !== expected)
    throw invalid('H6 packed mask length does not match its dimensions')
  const unusedBits = expected * 8 - pixels
  const lastByte = mask.data[expected - 1]
  if (
    unusedBits > 0 &&
    (lastByte === undefined || (lastByte & ~((1 << (8 - unusedBits)) - 1)) !== 0)
  )
    throw invalid('H6 packed mask has nonzero padding bits')
  return expected
}

function clonePacked(mask: PackedBinaryMask): PackedBinaryMask {
  return {
    data: Uint8Array.from(mask.data),
    width: mask.width,
    height: mask.height,
    format: 'binary-lsb0',
  }
}

function copyInputs(value: H6ComposerInput): {
  image: RgbaRaster
  target: string
  exclusions: string[]
  candidates: OwnedCandidate[]
  callerSignal: AbortSignal
} {
  if (
    !value ||
    !value.image ||
    !(value.image.data instanceof Uint8Array) ||
    value.image.format !== 'rgba8' ||
    !Number.isSafeInteger(value.image.width) ||
    !Number.isSafeInteger(value.image.height) ||
    value.image.width < 1 ||
    value.image.height < 1 ||
    value.image.width > 16384 ||
    value.image.height > 16384 ||
    !(value.signal instanceof AbortSignal) ||
    typeof value.target !== 'string' ||
    value.target.trim().length === 0 ||
    value.target.length > 2000 ||
    !Array.isArray(value.exclusions) ||
    value.exclusions.length > 16 ||
    value.exclusions.some(
      (entry) => typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 500,
    ) ||
    !value.families ||
    !Array.isArray(value.families.D) ||
    !Array.isArray(value.families.U)
  )
    throw invalid('Invalid H6 composer input')

  const width = value.image.width
  const height = value.image.height
  const pixels = width * height
  if (
    !Number.isSafeInteger(pixels) ||
    pixels > 2_097_152 ||
    value.image.data.byteLength !== pixels * 4
  )
    throw invalid('H6 source dimensions exceed limits or do not match the RGBA bytes')
  const image: RgbaRaster = {
    data: Uint8Array.from(value.image.data),
    width,
    height,
    format: 'rgba8',
  }
  const candidates: OwnedCandidate[] = []
  const maskSnapshots: PackedBinaryMask[] = []
  try {
    const familyInputs = {
      D: [...value.families.D],
      U: [...value.families.U],
    }
    if (
      familyInputs.D.length > H6_LIMITS.familyCandidates ||
      familyInputs.U.length > H6_LIMITS.familyCandidates ||
      familyInputs.D.length + familyInputs.U.length > H6_LIMITS.totalCandidates
    )
      throw new ClassifierError('RESOURCE_LIMIT', 'H6 proposal candidate count exceeds its cap')

    const seenByFamily: Record<H6Family, Set<string>> = { D: new Set(), U: new Set() }
    const packedSnapshots: Record<H6Family, Array<{ id: string; mask: PackedBinaryMask }>> = {
      D: [],
      U: [],
    }
    let packedBytes = 0
    for (const family of H6_FAMILIES) {
      for (const candidate of familyInputs[family]) {
        if (
          !candidate ||
          typeof candidate.id !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(candidate.id) ||
          seenByFamily[family].has(candidate.id) ||
          !candidate.mask ||
          !(candidate.mask.data instanceof Uint8Array) ||
          candidate.mask.format !== 'binary-lsb0' ||
          candidate.mask.width !== width ||
          candidate.mask.height !== height
        )
          throw invalid(`H6 ${family} aliases or masks are invalid`)
        seenByFamily[family].add(candidate.id)
        const mask = clonePacked(candidate.mask)
        maskSnapshots.push(mask)
        packedSnapshots[family].push({ id: candidate.id, mask })
        packedBytes += validatePacked(mask, width, height)
      }
    }
    if (packedBytes > H6_LIMITS.packedMaskBytes)
      throw new ClassifierError('RESOURCE_LIMIT', 'H6 aggregate packed masks exceed 19 MiB')

    for (const family of H6_FAMILIES) {
      const familyCandidates = packedSnapshots[family]
      for (let familyIndex = 0; familyIndex < familyCandidates.length; familyIndex++) {
        const candidate = familyCandidates[familyIndex]
        if (!candidate) throw invalid('H6 candidate disappeared during snapshot')
        const mask = candidate.mask
        const bounds = boundsOfPacked(mask)
        if (!bounds) {
          mask.data.fill(0)
          throw invalid('H6 proposal mask has no actual foreground pixels')
        }
        candidates.push({
          family,
          familyIndex,
          alias: `${family}${String(familyIndex).padStart(2, '0')}`,
          sourceAlias: candidate.id,
          mask,
          bounds,
        })
      }
    }
  } catch (error) {
    image.data.fill(0)
    for (const candidate of candidates) candidate.mask.data.fill(0)
    for (const mask of maskSnapshots) mask.data.fill(0)
    throw error
  }
  return {
    image,
    target: value.target,
    exclusions: [...value.exclusions],
    candidates,
    callerSignal: value.signal,
  }
}

function imageCount(state: DecisionState): number {
  return state.filter((part) => typeof part !== 'string').length
}

function requestSha256(request: DecisionRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

function errorCode(error: unknown): ConstructorParameters<typeof ClassifierError>[0] {
  return error instanceof ClassifierError ? error.code : 'PROVIDER'
}

function sourceText(target: string, exclusions: readonly string[]): string {
  return `Authored target: ${JSON.stringify(target)}. Authored exclusions: ${JSON.stringify(exclusions)}.`
}

function presenceRequest(
  target: string,
  exclusions: readonly string[],
  state: DecisionState,
): DecisionRequest {
  return {
    state: [
      'Determine whether the described visible instance exists anywhere in this unmodified source. Do not judge any candidate mask or its completeness. Choose present, absent, or uncertain.',
      ...state,
      sourceText(target, exclusions),
    ],
    questions: {
      presence: {
        type: 'choice',
        rankingSize: 1,
        instructions: 'Choose the single best closed status for visible target presence.',
        criteria: {
          present: 'The described visible instance is present in the source.',
          absent: 'The described visible instance is absent from the source.',
          uncertain: 'The source does not allow a reliable presence decision.',
        },
      },
    },
  }
}

function nominationRequest(
  family: H6Family,
  candidates: readonly OwnedCandidate[],
  target: string,
  exclusions: readonly string[],
  state: DecisionState,
): DecisionRequest {
  const criteria: Record<string, string> = {}
  for (const candidate of candidates)
    criteria[candidate.alias] = `Highlighted region ${candidate.alias}.`
  criteria.none = 'No shown region depicts the requested visible instance.'
  return {
    state: [
      `Rank up to four candidate aliases from family ${family} by semantic identity and the authored relation. Judge the pictured visible instance; do not demand pixel-perfect contours or infer hidden parts. Use none if this family has no matching instance.`,
      ...state,
      sourceText(target, exclusions),
    ],
    questions: {
      selection: {
        type: 'choice',
        rankingSize: 4,
        instructions:
          'Rank the strongest shown candidate aliases by semantic identity and relation.',
        criteria,
      },
    },
  }
}

function finalRequest(
  candidates: readonly OwnedCandidate[],
  target: string,
  exclusions: readonly string[],
  state: DecisionState,
): DecisionRequest {
  const criteria: Record<string, string> = {}
  for (const candidate of candidates) criteria[candidate.alias] = `Actual mask ${candidate.alias}.`
  criteria.none = 'None of the shown masks is the requested visible instance with suitable extent.'
  return {
    state: [
      'Choose the best actual candidate mask for the requested visible instance. Prefer coverage of its whole visible extent and exclude substantial unrelated content. Occlusion gaps and disconnected visible pieces are allowed. Choose none if no candidate fits.',
      ...state,
      sourceText(target, exclusions),
    ],
    questions: {
      selection: {
        type: 'choice',
        rankingSize: 1,
        instructions: 'Choose the best actual mask alias, or none.',
        criteria,
      },
    },
  }
}

function orderedTopFour(
  result: DecisionResult,
  aliases: readonly string[],
): {
  selection: ChoiceSelection
  topFour: string[]
} {
  const keys = [...aliases, 'none']
  const selected = selection(result, keys, 4, 'selection')
  const answer = result.answers.selection
  if (!answer) throw new ClassifierError('INVALID_RESPONSE', 'H6 nomination answer is missing')
  let ordered: string[]
  if (answer.type === 'ranked-choice') ordered = [...answer.ranking]
  else if (answer.type === 'choice') {
    ordered = keys
      .map((key, index) => ({ key, index, score: answer.probabilities[key] ?? Number.NaN }))
      .sort((first, second) => second.score - first.score || first.index - second.index)
      .slice(0, Math.min(4, keys.length))
      .map(({ key }) => key)
  } else throw new ClassifierError('INVALID_RESPONSE', 'H6 nomination must be a Choice')
  return { selection: selected, topFour: ordered }
}

function containsAliases(
  candidates: readonly OwnedCandidate[],
  aliases: readonly string[],
): OwnedCandidate[] {
  const byAlias = new Map(candidates.map((candidate) => [candidate.alias, candidate]))
  return aliases.map((alias) => {
    const candidate = byAlias.get(alias)
    if (!candidate) throw new ClassifierError('INVALID_RESPONSE', 'H6 nominee has no source mask')
    return candidate
  })
}

function cloneCandidate(candidate: OwnedCandidate): H6PresentedCandidate {
  return { ...candidate, bounds: { ...candidate.bounds }, mask: clonePacked(candidate.mask) }
}

function validateImage(image: RasterImage): void {
  if (
    !(image.bytes instanceof Uint8Array) ||
    image.bytes.byteLength < 24 ||
    image.bytes.byteLength > limits.imageBytes ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width > 16384 ||
    image.height > 16384
  )
    throw new ClassifierError('RESOURCE_LIMIT', 'H6 rendered image exceeds its limits')
}

function decisionImageBytes(state: DecisionState): number {
  let total = 0
  for (const part of state) {
    if (typeof part === 'string') continue
    if (
      part.type !== 'image_url' ||
      typeof part.image_url?.url !== 'string' ||
      part.image_url.detail !== 'high'
    )
      throw invalid('H6 imageState returned a malformed image part')
    const prefix = 'data:image/png;base64,'
    const url = part.image_url.url
    if (!url.startsWith(prefix)) throw invalid('H6 imageState must prepare PNG data URLs')
    const encoded = url.slice(prefix.length)
    if (encoded.length < 32 || encoded.length > Math.ceil((limits.imageBytes * 4) / 3) + 4)
      throw new ClassifierError('RESOURCE_LIMIT', 'H6 prepared image exceeds its per-image cap')
    const bytes = Buffer.from(encoded, 'base64')
    if (
      bytes.byteLength < 24 ||
      bytes.byteLength > limits.imageBytes ||
      bytes.toString('base64') !== encoded
    )
      throw new ClassifierError('RESOURCE_LIMIT', 'H6 prepared image exceeds its per-image cap')
    total += bytes.byteLength
    bytes.fill(0)
  }
  return total
}

async function prepareImages(
  images: readonly RasterImage[],
  imageState: RasterPort['imageState'],
  signal: AbortSignal,
  expectedImages: number,
): Promise<DecisionState> {
  let renderedBytes = 0
  const prepared: DecisionState = []
  try {
    if (images.length !== expectedImages)
      throw new ClassifierError('RESOURCE_LIMIT', 'H6 presentation has an unexpected image count')
    for (const image of images) {
      assertActive(signal)
      validateImage(image)
      renderedBytes += image.bytes.byteLength
      if (renderedBytes > H6_LIMITS.presentationPngBytes)
        throw new ClassifierError('RESOURCE_LIMIT', 'H6 presentation exceeds its 20 MiB cap')
      const owned = {
        bytes: Uint8Array.from(image.bytes),
        width: image.width,
        height: image.height,
      }
      let state: DecisionState
      try {
        state = await imageState(owned, signal)
      } finally {
        owned.bytes.fill(0)
      }
      if (!Array.isArray(state) || imageCount(state) !== 1)
        throw new ClassifierError(
          'INVALID_RESPONSE',
          'H6 imageState must return one image per view',
        )
      prepared.push(...state)
    }
    if (imageCount(prepared) > limits.maxImages)
      throw new ClassifierError('RESOURCE_LIMIT', 'H6 request exceeds its image-part cap')
    if (decisionImageBytes(prepared) > H6_LIMITS.presentationPngBytes)
      throw new ClassifierError('RESOURCE_LIMIT', 'H6 prepared presentation exceeds its 20 MiB cap')
    return prepared
  } finally {
    for (const image of images) image.bytes.fill(0)
  }
}

export function createH6ContextComposer(options: H6ComposerOptions) {
  if (
    !options ||
    typeof options.decision?.decide !== 'function' ||
    typeof options.imageState !== 'function' ||
    typeof options.presentation?.renderPresence !== 'function' ||
    typeof options.presentation.renderNomination !== 'function' ||
    typeof options.presentation.renderFinal !== 'function' ||
    typeof options.budgetRecord?.admit !== 'function' ||
    typeof options.budgetRecord.settle !== 'function'
  )
    throw invalid(
      'H6 composer requires caller-owned decision, presentation, image, and budget ports',
    )

  return {
    async compose(value: H6ComposerInput): Promise<H6ComposerResult> {
      const deadline = new AbortController()
      const timer = setTimeout(
        () => deadline.abort(new ClassifierError('TIMEOUT', 'H6 case exceeded 240 seconds')),
        H6_LIMITS.caseDeadlineMs,
      )
      timer.unref?.()
      let owned: ReturnType<typeof copyInputs>
      try {
        owned = copyInputs(value)
      } catch (error) {
        clearTimeout(timer)
        throw error
      }
      const signal = AbortSignal.any([owned.callerSignal, deadline.signal])
      const nominations: H6NominationEvidence[] = []
      let presenceEvidence: H6PresenceEvidence | null = null
      let callOrdinal = 0
      try {
        const invoke = async (stage: H6DecisionStage, request: DecisionRequest) => {
          assertActive(signal)
          if (callOrdinal >= 4)
            throw new ClassifierError('RESOURCE_LIMIT', 'H6 per-case decision cap is four')
          callOrdinal++
          const requestHash = requestSha256(request)
          await options.budgetRecord.admit({
            stage,
            callOrdinal,
            requestSha256: requestHash,
            signal,
          })
          let raw: DecisionResult
          try {
            assertActive(signal)
            raw = await options.decision.decide(structuredClone(request), signal)
          } catch (error) {
            await options.budgetRecord.settle({
              stage,
              requestSha256: requestHash,
              outcome: 'failed',
              errorCode: errorCode(error),
            })
            throw error
          }
          await options.budgetRecord.settle({
            stage,
            requestSha256: requestHash,
            outcome: 'resolved',
            metadata: raw.metadata,
          })
          assertActive(signal)
          return validateDecision(request, raw)
        }

        assertActive(signal)
        const presenceInput = {
          image: { ...owned.image, data: Uint8Array.from(owned.image.data) },
          signal,
        }
        let presenceViews: readonly RasterImage[]
        try {
          presenceViews = await options.presentation.renderPresence(presenceInput)
        } finally {
          presenceInput.image.data.fill(0)
        }
        const presenceState = await prepareImages(presenceViews, options.imageState, signal, 1)
        const presenceRequestValue = presenceRequest(owned.target, owned.exclusions, presenceState)
        const presenceResult = await invoke('presence', presenceRequestValue)
        const presenceSelection = selection(
          presenceResult,
          ['present', 'absent', 'uncertain'],
          1,
          'presence',
        )
        const presenceMetadata = { ...presenceResult.metadata }
        presenceEvidence = { selection: presenceSelection, metadata: presenceMetadata }
        if (presenceSelection.choice === 'absent')
          return {
            status: 'unknown',
            reason: 'target-absent',
            presence: presenceEvidence,
            finalSelection: null,
            finalMetadata: null,
            nominations,
          }
        if (presenceSelection.choice === 'uncertain')
          return {
            status: 'unknown',
            reason: 'presence-unresolved',
            presence: presenceEvidence,
            finalSelection: null,
            finalMetadata: null,
            nominations,
          }

        for (const family of H6_FAMILIES) {
          assertActive(signal)
          const candidates = owned.candidates.filter((candidate) => candidate.family === family)
          if (candidates.length === 0) continue
          const presentationInput = {
            image: { ...owned.image, data: Uint8Array.from(owned.image.data) },
            candidates: candidates.map(cloneCandidate),
            signal,
          }
          let views: readonly RasterImage[]
          try {
            views = await options.presentation.renderNomination(presentationInput)
          } finally {
            presentationInput.image.data.fill(0)
            for (const candidate of presentationInput.candidates) candidate.mask.data.fill(0)
          }
          const expected = 1 + Math.ceil(candidates.length / H6_LIMITS.candidatesPerAtlasPage)
          const state = await prepareImages(views, options.imageState, signal, expected)
          if (expected > 5)
            throw new ClassifierError('RESOURCE_LIMIT', 'H6 nomination exceeds five image parts')
          const request = nominationRequest(
            family,
            candidates,
            owned.target,
            owned.exclusions,
            state,
          )
          const result = await invoke(family === 'D' ? 'nominate-D' : 'nominate-U', request)
          const order = orderedTopFour(
            result,
            candidates.map((candidate) => candidate.alias),
          )
          const nomineeAliases = order.topFour.filter((alias) => alias !== 'none')
          nominations.push({
            family,
            topFour: order.topFour,
            nomineeAliases,
            selection: order.selection,
            metadata: { ...result.metadata },
          })
        }

        const nominees = H6_FAMILIES.flatMap((family) => {
          const familyEvidence = nominations.find((item) => item.family === family)
          return familyEvidence
            ? containsAliases(owned.candidates, familyEvidence.nomineeAliases)
            : []
        })
        if (nominees.length === 0)
          return {
            status: 'unknown',
            reason: 'no-nominees',
            presence: presenceEvidence,
            finalSelection: null,
            finalMetadata: null,
            nominations,
          }
        if (nominees.length > 8)
          throw new ClassifierError('RESOURCE_LIMIT', 'H6 final nominee count exceeds eight')
        const finalInput = {
          image: { ...owned.image, data: Uint8Array.from(owned.image.data) },
          candidates: nominees.map(cloneCandidate),
          signal,
        }
        let finalViews: readonly RasterImage[]
        try {
          finalViews = await options.presentation.renderFinal(finalInput)
        } finally {
          finalInput.image.data.fill(0)
          for (const candidate of finalInput.candidates) candidate.mask.data.fill(0)
        }
        const finalState = await prepareImages(
          finalViews,
          options.imageState,
          signal,
          1 + nominees.length,
        )
        if (finalState.filter((part) => typeof part !== 'string').length > 9)
          throw new ClassifierError('RESOURCE_LIMIT', 'H6 final request exceeds nine image parts')
        const finalRequestValue = finalRequest(nominees, owned.target, owned.exclusions, finalState)
        const finalResult = await invoke('final-select', finalRequestValue)
        const finalSelection = selection(
          finalResult,
          [...nominees.map((candidate) => candidate.alias), 'none'],
          1,
          'selection',
        )
        if (finalSelection.choice === 'none')
          return {
            status: 'unknown',
            reason: 'none-selected',
            presence: presenceEvidence,
            finalSelection,
            finalMetadata: { ...finalResult.metadata },
            nominations,
          }
        const selected = nominees.find((candidate) => candidate.alias === finalSelection.choice)
        if (!selected) throw new ClassifierError('INVALID_RESPONSE', 'H6 final choice has no mask')
        const region = boundsOfPacked(selected.mask)
        if (!region)
          throw new ClassifierError('INVALID_RESPONSE', 'H6 selected mask has no foreground')
        assertActive(signal)
        return {
          status: 'located',
          family: selected.family,
          alias: selected.alias,
          sourceAlias: selected.sourceAlias,
          region: { ...region },
          mask: clonePacked(selected.mask),
          presence: presenceEvidence,
          finalSelection,
          finalMetadata: { ...finalResult.metadata },
          nominations,
        }
      } catch (error) {
        if (error instanceof H6ComposerFailure) throw error
        const code = errorCode(error)
        const message =
          error instanceof Error ? error.message.slice(0, 500) : 'H6 composition failed'
        throw new H6ComposerFailure(
          code,
          message,
          {
            presence: presenceEvidence,
            nominations: structuredClone(nominations),
          },
          error,
        )
      } finally {
        clearTimeout(timer)
        owned.image.data.fill(0)
        for (const candidate of owned.candidates) candidate.mask.data.fill(0)
      }
    },
  }
}

function contextRect(bounds: PixelRect, width: number, height: number): PixelRect {
  const wantedWidth = Math.min(width, Math.max(4 * bounds.width, 128))
  const wantedHeight = Math.min(height, Math.max(4 * bounds.height, 128))
  const centerX = bounds.left + bounds.width / 2
  const centerY = bounds.top + bounds.height / 2
  const left = Math.max(0, Math.min(width - wantedWidth, Math.floor(centerX - wantedWidth / 2)))
  const top = Math.max(0, Math.min(height - wantedHeight, Math.floor(centerY - wantedHeight / 2)))
  return { left, top, width: wantedWidth, height: wantedHeight }
}

function safeSvg(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

async function encode(pipeline: ReturnType<typeof sharp>, signal: AbortSignal): Promise<Buffer> {
  assertActive(signal)
  let output: Buffer | undefined
  try {
    output = await pipeline.png({ compressionLevel: 6 }).toBuffer()
    assertActive(signal)
    if (output.byteLength < 24 || output.byteLength > limits.imageBytes)
      throw new ClassifierError('RESOURCE_LIMIT', 'H6 rendered PNG exceeds its per-image cap')
    return output
  } catch (error) {
    output?.fill(0)
    throw error
  } finally {
    pipeline.destroy()
  }
}

async function sourcePng(image: RgbaRaster, signal: AbortSignal): Promise<RasterImage> {
  const bytes = await encode(
    sharp(image.data, {
      raw: { width: image.width, height: image.height, channels: 4 },
      limitInputPixels: 2_097_152,
      failOn: 'error',
    }),
    signal,
  )
  return { bytes: new Uint8Array(bytes), width: image.width, height: image.height }
}

function overviewRaw(
  image: RgbaRaster,
  candidate: H6PresentedCandidate,
  width: number,
  height: number,
): Buffer {
  const pixels = Buffer.alloc(width * height * 4, 246)
  const scale = Math.min(width / image.width, height / image.height)
  const contentWidth = Math.max(1, Math.round(image.width * scale))
  const contentHeight = Math.max(1, Math.round(image.height * scale))
  const padX = Math.floor((width - contentWidth) / 2)
  const padY = Math.floor((height - contentHeight) / 2)
  for (let y = 0; y < contentHeight; y++) {
    const sourceY = Math.min(image.height - 1, Math.floor((y + 0.5) / scale))
    for (let x = 0; x < contentWidth; x++) {
      const sourceX = Math.min(image.width - 1, Math.floor((x + 0.5) / scale))
      const sourceIndex = (sourceY * image.width + sourceX) * 4
      const destIndex = ((padY + y) * width + padX + x) * 4
      pixels[destIndex] = image.data[sourceIndex] ?? 0
      pixels[destIndex + 1] = image.data[sourceIndex + 1] ?? 0
      pixels[destIndex + 2] = image.data[sourceIndex + 2] ?? 0
      pixels[destIndex + 3] = 255
    }
  }
  const left = padX + Math.floor(candidate.bounds.left * scale)
  const top = padY + Math.floor(candidate.bounds.top * scale)
  const right =
    padX +
    Math.max(left - padX, Math.ceil((candidate.bounds.left + candidate.bounds.width) * scale) - 1)
  const bottom =
    padY +
    Math.max(top - padY, Math.ceil((candidate.bounds.top + candidate.bounds.height) * scale) - 1)
  for (let x = left; x <= right; x++) {
    paint(pixels, width, height, x, top, [220, 38, 38, 255])
    paint(pixels, width, height, x, bottom, [220, 38, 38, 255])
  }
  for (let y = top; y <= bottom; y++) {
    paint(pixels, width, height, left, y, [220, 38, 38, 255])
    paint(pixels, width, height, right, y, [220, 38, 38, 255])
  }
  return pixels
}

function paint(
  pixels: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  rgba: readonly [number, number, number, number],
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return
  const index = (y * width + x) * 4
  pixels[index] = rgba[0]
  pixels[index + 1] = rgba[1]
  pixels[index + 2] = rgba[2]
  pixels[index + 3] = rgba[3]
}

function cropPixels(
  image: RgbaRaster,
  mask: Uint8Array,
  crop: PixelRect,
): { source: Buffer; overlay: Buffer; cutout: Buffer } {
  const count = crop.width * crop.height
  const source = Buffer.alloc(count * 4)
  const overlay = Buffer.alloc(count * 4)
  const cutout = Buffer.alloc(count * 4)
  for (let y = 0; y < crop.height; y++) {
    const sourceStart = ((crop.top + y) * image.width + crop.left) * 4
    const targetStart = y * crop.width * 4
    const row = image.data.subarray(sourceStart, sourceStart + crop.width * 4)
    source.set(row, targetStart)
    for (let x = 0; x < crop.width; x++) {
      const i = targetStart + x * 4
      if (mask[(crop.top + y) * image.width + crop.left + x] === 1) {
        overlay[i] = Math.round(((row[x * 4] ?? 0) + 0) / 2)
        overlay[i + 1] = Math.round(((row[x * 4 + 1] ?? 0) + 255) / 2)
        overlay[i + 2] = Math.round(((row[x * 4 + 2] ?? 0) + 255) / 2)
        overlay[i + 3] = 255
        cutout[i] = row[x * 4] ?? 0
        cutout[i + 1] = row[x * 4 + 1] ?? 0
        cutout[i + 2] = row[x * 4 + 2] ?? 0
        cutout[i + 3] = 255
      } else {
        overlay[i] = row[x * 4] ?? 0
        overlay[i + 1] = row[x * 4 + 1] ?? 0
        overlay[i + 2] = row[x * 4 + 2] ?? 0
        overlay[i + 3] = 255
        cutout[i] = 128
        cutout[i + 1] = 128
        cutout[i + 2] = 128
        cutout[i + 3] = 255
      }
    }
  }
  return { source, overlay, cutout }
}

async function resizedPanel(
  pixels: Buffer,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
  signal: AbortSignal,
): Promise<Buffer> {
  return encode(
    sharp(pixels, {
      raw: { width, height, channels: 4 },
      limitInputPixels: 2_097_152,
      failOn: 'error',
    }).resize(outWidth, outHeight, {
      fit: 'contain',
      kernel: 'nearest',
      background: { r: 20, g: 24, b: 32, alpha: 1 },
    }),
    signal,
  )
}

async function locationOverview(
  image: RgbaRaster,
  candidate: H6PresentedCandidate,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const raw = overviewRaw(image, candidate, width, height)
  try {
    return await encode(
      sharp(raw, { raw: { width, height, channels: 4 }, failOn: 'error' }),
      signal,
    )
  } finally {
    raw.fill(0)
  }
}

async function renderAtlasTile(
  image: RgbaRaster,
  candidate: H6PresentedCandidate,
  signal: AbortSignal,
): Promise<Buffer> {
  assertActive(signal)
  const crop = contextRect(candidate.bounds, image.width, image.height)
  const decoded = unpackBinaryMask(candidate.mask)
  let source: Buffer | undefined
  let overlay: Buffer | undefined
  let cutout: Buffer | undefined
  let overview: Buffer | undefined
  let sourcePanel: Buffer | undefined
  let overlayPanel: Buffer | undefined
  let cutoutPanel: Buffer | undefined
  let svg: Buffer | undefined
  let tile: Buffer | undefined
  try {
    const crops = cropPixels(image, decoded, crop)
    source = crops.source
    overlay = crops.overlay
    cutout = crops.cutout
    sourcePanel = await resizedPanel(source, crop.width, crop.height, 448, 344, signal)
    overlayPanel = await resizedPanel(overlay, crop.width, crop.height, 448, 344, signal)
    cutoutPanel = await resizedPanel(cutout, crop.width, crop.height, 208, 80, signal)
    overview = await locationOverview(image, candidate, 208, 80, signal)
    svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect x="0" y="0" width="480" height="32" fill="#111827"/><text x="12" y="22" font-family="DejaVu Sans,sans-serif" font-size="15" fill="white">${safeSvg(candidate.alias)}</text></svg>`,
    )
    tile = await encode(
      sharp({ create: { width: 480, height: 480, channels: 4, background: '#f8fafc' } }).composite([
        { input: sourcePanel, left: 16, top: 40 },
        { input: overlayPanel, left: 16, top: 40 },
        { input: overview, left: 16, top: 392 },
        { input: cutoutPanel, left: 256, top: 392 },
        { input: svg },
      ]),
      signal,
    )
    return tile
  } finally {
    decoded.fill(0)
    source?.fill(0)
    overlay?.fill(0)
    cutout?.fill(0)
    overview?.fill(0)
    sourcePanel?.fill(0)
    overlayPanel?.fill(0)
    cutoutPanel?.fill(0)
    svg?.fill(0)
  }
}

async function renderFinalCard(
  image: RgbaRaster,
  candidate: H6PresentedCandidate,
  signal: AbortSignal,
): Promise<Buffer> {
  assertActive(signal)
  const crop = contextRect(candidate.bounds, image.width, image.height)
  const decoded = unpackBinaryMask(candidate.mask)
  let source: Buffer | undefined
  let overlay: Buffer | undefined
  let cutout: Buffer | undefined
  let overview: Buffer | undefined
  let overlayPanel: Buffer | undefined
  let cutoutPanel: Buffer | undefined
  let svg: Buffer | undefined
  try {
    const crops = cropPixels(image, decoded, crop)
    source = crops.source
    overlay = crops.overlay
    cutout = crops.cutout
    overview = await locationOverview(image, candidate, 276, 240, signal)
    overlayPanel = await resizedPanel(overlay, crop.width, crop.height, 282, 240, signal)
    cutoutPanel = await resizedPanel(cutout, crop.width, crop.height, 282, 240, signal)
    svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="320"><rect x="0" y="0" width="900" height="32" fill="#111827"/><text x="12" y="21" font-family="DejaVu Sans,sans-serif" font-size="16" fill="white">${safeSvg(candidate.alias)}</text><text x="10" y="304" font-family="DejaVu Sans,sans-serif" font-size="12" fill="#111827">source location</text><text x="300" y="304" font-family="DejaVu Sans,sans-serif" font-size="12" fill="#111827">context and actual mask</text><text x="600" y="304" font-family="DejaVu Sans,sans-serif" font-size="12" fill="#111827">actual cutout</text></svg>`,
    )
    return await encode(
      sharp({ create: { width: 900, height: 320, channels: 4, background: '#f8fafc' } }).composite([
        { input: overview, left: 10, top: 40 },
        { input: overlayPanel, left: 300, top: 40 },
        { input: cutoutPanel, left: 600, top: 40 },
        { input: svg },
      ]),
      signal,
    )
  } finally {
    decoded.fill(0)
    source?.fill(0)
    overlay?.fill(0)
    cutout?.fill(0)
    overview?.fill(0)
    overlayPanel?.fill(0)
    cutoutPanel?.fill(0)
    svg?.fill(0)
  }
}

export function createSharpH6Presentation(): H6PresentationPort {
  return {
    async renderPresence(input) {
      const image = { ...input.image, data: Uint8Array.from(input.image.data) }
      try {
        assertActive(input.signal)
        return [await sourcePng(image, input.signal)]
      } finally {
        image.data.fill(0)
      }
    },
    async renderNomination(input) {
      const image = { ...input.image, data: Uint8Array.from(input.image.data) }
      const candidates = input.candidates.map((candidate) => ({
        ...candidate,
        bounds: { ...candidate.bounds },
        mask: clonePacked(candidate.mask),
      }))
      const output: RasterImage[] = []
      try {
        assertActive(input.signal)
        output.push(await sourcePng(image, input.signal))
        for (let offset = 0; offset < candidates.length; offset += 9) {
          const group = candidates.slice(offset, offset + 9)
          if (output.length > H6_LIMITS.presentationPagesPerFamily)
            throw new ClassifierError(
              'RESOURCE_LIMIT',
              'H6 family requires more than four atlas pages',
            )
          const buffers: Buffer[] = []
          try {
            for (let index = 0; index < group.length; index++) {
              const candidate = group[index]
              if (!candidate) continue
              const tile = await renderAtlasTile(image, candidate, input.signal)
              buffers.push(tile)
            }
            const overlays: sharp.OverlayOptions[] = buffers.map((buffer, index) => ({
              input: buffer,
              left: (index % 3) * 480,
              top: Math.floor(index / 3) * 480,
            }))
            const page = await encode(
              sharp({
                create: { width: 1440, height: 1440, channels: 4, background: '#d1d5db' },
              }).composite(overlays),
              input.signal,
            )
            output.push({ bytes: new Uint8Array(page), width: 1440, height: 1440 })
          } finally {
            for (const buffer of buffers) buffer.fill(0)
          }
        }
        if (output.length > 5)
          throw new ClassifierError('RESOURCE_LIMIT', 'H6 nomination exceeds five image parts')
        return output
      } catch (error) {
        for (const view of output) view.bytes.fill(0)
        throw error
      } finally {
        image.data.fill(0)
        for (const candidate of candidates) candidate.mask.data.fill(0)
      }
    },
    async renderFinal(input) {
      const image = { ...input.image, data: Uint8Array.from(input.image.data) }
      const candidates = input.candidates.map((candidate) => ({
        ...candidate,
        bounds: { ...candidate.bounds },
        mask: clonePacked(candidate.mask),
      }))
      const output: RasterImage[] = []
      try {
        assertActive(input.signal)
        output.push(await sourcePng(image, input.signal))
        for (const candidate of candidates) {
          const card = await renderFinalCard(image, candidate, input.signal)
          output.push({ bytes: new Uint8Array(card), width: 900, height: 320 })
          card.fill(0)
        }
        if (output.length > 9)
          throw new ClassifierError('RESOURCE_LIMIT', 'H6 final request exceeds nine image parts')
        return output
      } catch (error) {
        for (const view of output) view.bytes.fill(0)
        throw error
      } finally {
        image.data.fill(0)
        for (const candidate of candidates) candidate.mask.data.fill(0)
      }
    },
  }
}
