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

export const H5_FAMILIES = ['D', 'U'] as const
export type H5Family = (typeof H5_FAMILIES)[number]
export type H5DecisionStage = 'nominate-D' | 'nominate-U' | 'final-select'

export const H5_LIMITS = Object.freeze({
  familyCandidates: 36,
  totalCandidates: 72,
  packedMaskBytes: 19 * 1024 * 1024,
  presentationPngBytes: 20 * 1024 * 1024,
  caseDeadlineMs: 240_000,
})

export interface H5ProposalCandidate {
  /** The caller's original stable alias, retained as provenance. */
  id: string
  mask: PackedBinaryMask
}

export interface H5ComposerInput {
  image: RgbaRaster
  target: string
  exclusions: readonly string[]
  families: Readonly<Record<H5Family, readonly H5ProposalCandidate[]>>
  signal: AbortSignal
}

export interface H5PresentedCandidate {
  family: H5Family
  alias: string
  sourceAlias: string
  mask: PackedBinaryMask
  bounds: PixelRect
}

export interface H5PresentationPort {
  /** Inputs are temporary owned snapshots and are cleared when the promise settles. */
  renderNomination(input: {
    image: RgbaRaster
    candidates: readonly H5PresentedCandidate[]
    signal: AbortSignal
  }): Promise<readonly RasterImage[]>
  renderFinal(input: {
    image: RgbaRaster
    candidates: readonly H5PresentedCandidate[]
    signal: AbortSignal
  }): Promise<readonly RasterImage[]>
}

export interface H5DecisionBudgetRecordPort {
  admit(input: {
    stage: H5DecisionStage
    callOrdinal: number
    requestSha256: string
    signal: AbortSignal
  }): void | Promise<void>
  settle(input: {
    stage: H5DecisionStage
    requestSha256: string
    outcome: 'resolved' | 'failed'
    metadata?: DecisionResult['metadata']
    errorCode?: string
  }): void | Promise<void>
}

export interface H5ComposerOptions {
  /** Caller-supplied, preferably budgeted and physically recorded, decision port. */
  decision: DecisionPort
  imageState: RasterPort['imageState']
  presentation: H5PresentationPort
  budgetRecord: H5DecisionBudgetRecordPort
}

export interface H5NominationEvidence {
  family: H5Family
  topFour: string[]
  nomineeAliases: string[]
  selection: ChoiceSelection
  metadata: DecisionResult['metadata']
}

export type H5ComposerResult =
  | {
      status: 'located'
      family: H5Family
      alias: string
      sourceAlias: string
      region: PixelRect
      mask: PackedBinaryMask
      finalSelection: ChoiceSelection
      finalMetadata: DecisionResult['metadata']
      nominations: H5NominationEvidence[]
    }
  | {
      status: 'unknown'
      reason: 'no-nominees' | 'none-selected'
      finalSelection: ChoiceSelection | null
      finalMetadata: DecisionResult['metadata'] | null
      nominations: H5NominationEvidence[]
    }

interface OwnedCandidate extends H5PresentedCandidate {
  familyIndex: number
}

function invalid(message: string): ClassifierError {
  return new ClassifierError('INVALID_INPUT', message)
}

function packedLength(pixels: number): number {
  return Math.ceil(pixels / 8)
}

function validatePacked(mask: PackedBinaryMask, width: number, height: number): number {
  if (
    !mask ||
    mask.format !== 'binary-lsb0' ||
    !(mask.data instanceof Uint8Array) ||
    mask.width !== width ||
    mask.height !== height
  )
    throw invalid('H5 candidate mask format or dimensions are invalid')
  const pixels = width * height
  const expected = packedLength(pixels)
  if (mask.data.byteLength !== expected)
    throw invalid('H5 packed mask length does not match its dimensions')
  const unusedBits = expected * 8 - pixels
  const lastByte = mask.data[expected - 1]
  if (
    unusedBits > 0 &&
    (lastByte === undefined || (lastByte & ~((1 << (8 - unusedBits)) - 1)) !== 0)
  )
    throw invalid('H5 packed mask has nonzero padding bits')
  return expected
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

function copyInputs(value: H5ComposerInput): {
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
    throw invalid('Invalid H5 composer input')

  const width = value.image.width
  const height = value.image.height
  const target = value.target
  const exclusions = [...value.exclusions]
  const callerSignal = value.signal
  const pixels = width * height
  if (
    !Number.isSafeInteger(pixels) ||
    pixels > 2_097_152 ||
    value.image.data.byteLength !== pixels * 4
  )
    throw invalid('H5 source dimensions exceed limits or do not match the RGBA bytes')

  if (
    value.families.D.length > H5_LIMITS.familyCandidates ||
    value.families.U.length > H5_LIMITS.familyCandidates ||
    value.families.D.length + value.families.U.length > H5_LIMITS.totalCandidates
  )
    throw new ClassifierError('RESOURCE_LIMIT', 'H5 proposal candidate count exceeds its cap')

  const rawFamilies: Readonly<Record<H5Family, readonly H5ProposalCandidate[]>> = value.families
  let packedBytes = 0
  for (const family of H5_FAMILIES) {
    const seen = new Set<string>()
    for (const candidate of rawFamilies[family]) {
      if (
        !candidate ||
        typeof candidate.id !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(candidate.id) ||
        seen.has(candidate.id)
      )
        throw invalid(`H5 ${family} aliases must be unique stable identifiers`)
      seen.add(candidate.id)
      packedBytes += validatePacked(candidate.mask, width, height)
    }
  }
  if (packedBytes > H5_LIMITS.packedMaskBytes)
    throw new ClassifierError('RESOURCE_LIMIT', 'H5 aggregate packed masks exceed 19 MiB')

  const image: RgbaRaster = {
    data: Uint8Array.from(value.image.data),
    width,
    height,
    format: 'rgba8',
  }
  const candidates: OwnedCandidate[] = []
  for (const family of H5_FAMILIES) {
    const familyCandidates = rawFamilies[family]
    for (let familyIndex = 0; familyIndex < familyCandidates.length; familyIndex++) {
      const candidate = familyCandidates[familyIndex]
      if (!candidate) throw invalid('H5 candidate disappeared during snapshot')
      const ownedMask: PackedBinaryMask = {
        data: Uint8Array.from(candidate.mask.data),
        width,
        height,
        format: 'binary-lsb0',
      }
      const bounds = boundsOfPacked(ownedMask)
      if (!bounds) {
        ownedMask.data.fill(0)
        for (const snapshot of candidates) snapshot.mask.data.fill(0)
        image.data.fill(0)
        throw invalid('H5 proposal mask has no actual foreground pixels')
      }
      candidates.push({
        family,
        familyIndex,
        alias: `${family}${String(familyIndex).padStart(2, '0')}`,
        sourceAlias: candidate.id,
        mask: ownedMask,
        bounds,
      })
    }
  }
  return {
    image,
    target,
    exclusions,
    candidates,
    callerSignal,
  }
}

function questionText(target: string, exclusions: readonly string[]): string {
  return `The authored target is ${JSON.stringify(target)} and authored exclusions are ${JSON.stringify(exclusions)}.`
}

function nominationRequest(
  family: H5Family,
  candidates: readonly OwnedCandidate[],
  target: string,
  exclusions: readonly string[],
  state: DecisionState,
): DecisionRequest {
  const context = questionText(target, exclusions)
  const criteria: Record<string, string> = {}
  for (const candidate of candidates)
    criteria[candidate.alias] =
      `${context} The ${candidate.alias} actual mask depicts the authored target instance and its whole visible source extent without substantial unrelated visible foreground/background. Ordinary minor contour deviations, antialiasing, small holes, occlusion-created gaps, and disconnected visible pieces alone are acceptable; do not infer pixels hidden behind an occluder.`
  criteria.none = `${context} None of the shown ${family} masks shows the authored target's whole visible source extent without material visible omissions or major unrelated foreground/background.`
  return {
    state,
    questions: {
      selection: {
        type: 'choice',
        rankingSize: 4,
        instructions: `${context} Rank the strongest actual masks from this ${family} proposal family. Candidates show actual mask overlays. Return exactly four distinct supplied aliases, or all supplied answers when fewer than four exist. Judge visible source pixels only: ordinary small edge imperfections, occlusion-created gaps, and disconnected visible pieces alone do not disqualify a mask. Do not infer hidden shape; use none if no candidate shows the target's whole visible extent without major contamination.`,
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
  const context = questionText(target, exclusions)
  const criteria: Record<string, string> = {}
  for (const candidate of candidates)
    criteria[candidate.alias] =
      `${context} The ${candidate.alias} card depicts the authored target instance; its mask contains the whole visible source extent without material omissions or substantial unrelated visible foreground/background. Ordinary minor contour deviations, antialiasing, small holes, occlusion-created gaps, and disconnected visible pieces alone are acceptable; do not infer pixels hidden behind an occluder.`
  criteria.none = `${context} None of the nominated masks can be confirmed as the authored target instance with its whole visible source extent and without major unrelated visible foreground/background.`
  return {
    state,
    questions: {
      selection: {
        type: 'choice',
        rankingSize: 1,
        instructions: `${context} Compare the unmodified full source with each nominee's clean context, exact mask overlay, and exact masked cutout. Judge visible source pixels only. Choose the best actual nominee only when it is the authored target and its mask covers the whole visible extent without material visible omissions or substantial unrelated foreground/background. Allow ordinary minor contour deviations, antialiasing, small holes, gaps where an occluder hides the target, and disconnected visible pieces when identity and extent remain clear. Do not infer hidden object shape. If no nominee meets these requirements, choose none. Do not infer coordinates.`,
        criteria,
      },
    },
  }
}

function imageCount(state: DecisionState): number {
  return state.filter((part) => typeof part !== 'string').length
}

function serializeBytes(request: DecisionRequest): number {
  try {
    return Buffer.byteLength(JSON.stringify(request))
  } catch {
    throw invalid('H5 request cannot be serialized')
  }
}

function decisionImageBytes(state: DecisionState): number {
  let total = 0
  for (const part of state) {
    if (typeof part === 'string') continue
    if (
      !part ||
      part.type !== 'image_url' ||
      typeof part.image_url?.url !== 'string' ||
      part.image_url.detail !== 'high'
    )
      throw invalid('H5 imageState returned a malformed image part')
    const url = part.image_url.url
    const prefix = 'data:image/png;base64,'
    if (!url.startsWith(prefix)) throw invalid('H5 imageState must prepare PNG data URLs')
    const encoded = url.slice(prefix.length)
    if (encoded.length < 32 || encoded.length > Math.ceil((limits.imageBytes * 4) / 3) + 4)
      throw new ClassifierError('RESOURCE_LIMIT', 'H5 prepared image exceeds its per-image cap')
    const bytes = Buffer.from(encoded, 'base64')
    if (
      bytes.byteLength < 24 ||
      bytes.byteLength > limits.imageBytes ||
      bytes.toString('base64') !== encoded
    )
      throw new ClassifierError('RESOURCE_LIMIT', 'H5 prepared image exceeds its per-image cap')
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
): Promise<{ state: DecisionState; pngBytes: number }> {
  let pngBytes = 0
  const states: DecisionState = []
  try {
    if (images.length !== expectedImages)
      throw new ClassifierError('RESOURCE_LIMIT', 'H5 presentation has an unexpected image count')
    for (const image of images) {
      assertActive(signal)
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
        throw new ClassifierError('RESOURCE_LIMIT', 'H5 rendered image exceeds its limits')
      pngBytes += image.bytes.byteLength
      if (pngBytes > H5_LIMITS.presentationPngBytes)
        throw new ClassifierError('RESOURCE_LIMIT', 'H5 aggregate presentation exceeds 20 MiB')
      const imageSnapshot = {
        bytes: Uint8Array.from(image.bytes),
        width: image.width,
        height: image.height,
      }
      let state: DecisionState
      try {
        state = await imageState(imageSnapshot, signal)
      } finally {
        imageSnapshot.bytes.fill(0)
      }
      if (!Array.isArray(state) || imageCount(state) !== 1)
        throw new ClassifierError(
          'INVALID_RESPONSE',
          'H5 imageState must prepare one image per view',
        )
      states.push(...state)
    }
    const joined = states
    if (imageCount(joined) > 9)
      throw new ClassifierError('RESOURCE_LIMIT', 'H5 request exceeds nine image parts')
    const preparedBytes = decisionImageBytes(joined)
    if (preparedBytes > H5_LIMITS.presentationPngBytes)
      throw new ClassifierError('RESOURCE_LIMIT', 'H5 prepared aggregate image exceeds 20 MiB')
    return { state: joined, pngBytes }
  } finally {
    for (const image of images) image.bytes.fill(0)
  }
}

function orderedNominees(
  checked: DecisionResult,
  candidateAliases: readonly string[],
): { selection: ChoiceSelection; topFour: string[]; nomineeAliases: string[] } {
  const keys = [...candidateAliases, 'none']
  const selected = selection(checked, keys, 4, 'selection')
  const answer = checked.answers.selection
  if (!answer) throw new ClassifierError('INVALID_RESPONSE', 'H5 nomination answer is missing')
  let ordered: string[]
  if (answer.type === 'ranked-choice') ordered = [...answer.ranking]
  else if (answer.type === 'choice') {
    ordered = keys
      .map((key, index) => ({ key, index, score: answer.probabilities[key] ?? NaN }))
      .sort((first, second) => second.score - first.score || first.index - second.index)
      .map(({ key }) => key)
      .slice(0, Math.min(4, keys.length))
  } else throw new ClassifierError('INVALID_RESPONSE', 'H5 nomination must be a Choice')
  return {
    selection: selected,
    topFour: ordered,
    nomineeAliases: ordered.filter((alias) => alias !== 'none'),
  }
}

function sha256Request(request: DecisionRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

function codeFor(error: unknown): string {
  return error instanceof ClassifierError ? error.code : 'TECHNICAL_ERROR'
}

function clonePacked(mask: PackedBinaryMask): PackedBinaryMask {
  return {
    data: Uint8Array.from(mask.data),
    width: mask.width,
    height: mask.height,
    format: 'binary-lsb0',
  }
}

function containsAliases(
  candidates: readonly OwnedCandidate[],
  aliases: readonly string[],
): OwnedCandidate[] {
  const index = new Map(candidates.map((candidate) => [candidate.alias, candidate]))
  return aliases.map((alias) => {
    const candidate = index.get(alias)
    if (!candidate)
      throw new ClassifierError('INVALID_RESPONSE', 'H5 nominee alias has no source mask')
    return candidate
  })
}

export function createH5ProposalComposer(options: H5ComposerOptions) {
  if (
    !options ||
    typeof options.decision?.decide !== 'function' ||
    typeof options.imageState !== 'function' ||
    typeof options.presentation?.renderNomination !== 'function' ||
    typeof options.presentation.renderFinal !== 'function' ||
    typeof options.budgetRecord?.admit !== 'function' ||
    typeof options.budgetRecord.settle !== 'function'
  )
    throw invalid(
      'H5 composer requires caller-owned decision, presentation, image, and budget ports',
    )

  return {
    async compose(value: H5ComposerInput): Promise<H5ComposerResult> {
      const deadline = new AbortController()
      const timer = setTimeout(
        () => deadline.abort(new ClassifierError('TIMEOUT', 'H5 case exceeded 240 seconds')),
        H5_LIMITS.caseDeadlineMs,
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
      const nominations: H5NominationEvidence[] = []
      let callOrdinal = 0
      try {
        const invoke = async (stage: H5DecisionStage, request: DecisionRequest) => {
          assertActive(signal)
          if (callOrdinal >= 3)
            throw new ClassifierError('RESOURCE_LIMIT', 'H5 per-case decision cap is three')
          callOrdinal++
          const requestSha256 = sha256Request(request)
          await options.budgetRecord.admit({
            stage,
            callOrdinal,
            requestSha256,
            signal,
          })
          let raw: DecisionResult
          try {
            assertActive(signal)
            raw = await options.decision.decide(structuredClone(request), signal)
          } catch (error) {
            await options.budgetRecord.settle({
              stage,
              requestSha256,
              outcome: 'failed',
              errorCode: codeFor(error),
            })
            throw error
          }
          await options.budgetRecord.settle({
            stage,
            requestSha256,
            outcome: 'resolved',
            metadata: raw.metadata,
          })
          assertActive(signal)
          return validateDecision(request, raw)
        }

        for (const family of H5_FAMILIES) {
          assertActive(signal)
          const candidates = owned.candidates.filter((candidate) => candidate.family === family)
          if (candidates.length === 0) continue
          const presentationInput = {
            image: {
              data: Uint8Array.from(owned.image.data),
              width: owned.image.width,
              height: owned.image.height,
              format: 'rgba8' as const,
            },
            candidates: candidates.map((candidate) => ({
              ...candidate,
              bounds: { ...candidate.bounds },
              mask: clonePacked(candidate.mask),
            })),
            signal,
          }
          let views: readonly RasterImage[]
          try {
            views = await options.presentation.renderNomination(presentationInput)
          } finally {
            presentationInput.image.data.fill(0)
            for (const candidate of presentationInput.candidates) candidate.mask.data.fill(0)
          }
          const prepared = await prepareImages(
            views,
            options.imageState,
            signal,
            1 + Math.ceil(candidates.length / 6),
          )
          const request = nominationRequest(family, candidates, owned.target, owned.exclusions, [
            `${family} family candidates; clean and actual-mask views are grouped in stable source order.`,
            ...prepared.state,
          ])
          if (imageCount(request.state) > 7 || serializeBytes(request) > 32 * 1024 * 1024)
            throw new ClassifierError(
              'RESOURCE_LIMIT',
              'H5 nomination request exceeds its fixed cap',
            )
          const checked = await invoke(family === 'D' ? 'nominate-D' : 'nominate-U', request)
          const order = orderedNominees(
            checked,
            candidates.map((candidate) => candidate.alias),
          )
          nominations.push({
            family,
            topFour: order.topFour,
            nomineeAliases: order.nomineeAliases,
            selection: order.selection,
            metadata: { ...checked.metadata },
          })
        }

        const nominees = H5_FAMILIES.flatMap((family) => {
          const evidence = nominations.find((item) => item.family === family)
          return evidence ? containsAliases(owned.candidates, evidence.nomineeAliases) : []
        })
        if (nominees.length === 0)
          return {
            status: 'unknown',
            reason: 'no-nominees',
            finalSelection: null,
            finalMetadata: null,
            nominations,
          }
        if (nominees.length > 8)
          throw new ClassifierError('RESOURCE_LIMIT', 'H5 final nominee count exceeds eight')
        assertActive(signal)
        const finalPresentationInput = {
          image: {
            data: Uint8Array.from(owned.image.data),
            width: owned.image.width,
            height: owned.image.height,
            format: 'rgba8' as const,
          },
          candidates: nominees.map((candidate) => ({
            ...candidate,
            bounds: { ...candidate.bounds },
            mask: clonePacked(candidate.mask),
          })),
          signal,
        }
        let finalViews: readonly RasterImage[]
        try {
          finalViews = await options.presentation.renderFinal(finalPresentationInput)
        } finally {
          finalPresentationInput.image.data.fill(0)
          for (const candidate of finalPresentationInput.candidates) candidate.mask.data.fill(0)
        }
        const prepared = await prepareImages(
          finalViews,
          options.imageState,
          signal,
          1 + nominees.length,
        )
        const request = finalRequest(nominees, owned.target, owned.exclusions, prepared.state)
        if (imageCount(request.state) > 9 || serializeBytes(request) > 32 * 1024 * 1024)
          throw new ClassifierError('RESOURCE_LIMIT', 'H5 final request exceeds its fixed cap')
        const checked = await invoke('final-select', request)
        const finalSelection = selection(
          checked,
          [...nominees.map((candidate) => candidate.alias), 'none'],
          1,
          'selection',
        )
        if (finalSelection.choice === 'none')
          return {
            status: 'unknown',
            reason: 'none-selected',
            finalSelection,
            finalMetadata: { ...checked.metadata },
            nominations,
          }
        const selected = nominees.find((candidate) => candidate.alias === finalSelection.choice)
        if (!selected)
          throw new ClassifierError('INVALID_RESPONSE', 'H5 final answer does not map to a nominee')
        const bounds = boundsOfPacked(selected.mask)
        if (!bounds)
          throw new ClassifierError(
            'INVALID_RESPONSE',
            'H5 selected mask lost its foreground bounds',
          )
        assertActive(signal)
        return {
          status: 'located',
          family: selected.family,
          alias: selected.alias,
          sourceAlias: selected.sourceAlias,
          region: { ...bounds },
          mask: clonePacked(selected.mask),
          finalSelection,
          finalMetadata: { ...checked.metadata },
          nominations,
        }
      } finally {
        clearTimeout(timer)
        owned.image.data.fill(0)
        for (const candidate of owned.candidates) candidate.mask.data.fill(0)
      }
    },
  }
}

function paddedCrop(box: PixelRect, width: number, height: number): PixelRect {
  const padX = Math.max(16, Math.ceil(box.width * 0.5))
  const padY = Math.max(16, Math.ceil(box.height * 0.5))
  const left = Math.max(0, box.left - padX)
  const top = Math.max(0, box.top - padY)
  const right = Math.min(width, box.left + box.width + padX)
  const bottom = Math.min(height, box.top + box.height + padY)
  return { left, top, width: right - left, height: bottom - top }
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
  let bytes: Buffer | undefined
  try {
    bytes = await pipeline.png({ compressionLevel: 6 }).toBuffer()
    assertActive(signal)
    if (bytes.byteLength < 24 || bytes.byteLength > limits.imageBytes)
      throw new ClassifierError('RESOURCE_LIMIT', 'H5 rendered PNG exceeds per-image byte cap')
    return bytes
  } catch (error) {
    bytes?.fill(0)
    throw error
  } finally {
    pipeline.destroy()
  }
}

async function pngRaster(raster: RgbaRaster, signal: AbortSignal): Promise<RasterImage> {
  const bytes = await encode(
    sharp(raster.data, {
      raw: { width: raster.width, height: raster.height, channels: 4 },
      limitInputPixels: 2_097_152,
      failOn: 'error',
    }),
    signal,
  )
  return { bytes: new Uint8Array(bytes), width: raster.width, height: raster.height }
}

async function renderCard(
  image: RgbaRaster,
  candidate: H5PresentedCandidate,
  mode: 'nomination' | 'final',
  signal: AbortSignal,
): Promise<Buffer> {
  const crop = paddedCrop(candidate.bounds, image.width, image.height)
  const panelWidth = mode === 'nomination' ? 144 : 288
  const panelHeight = mode === 'nomination' ? 232 : 260
  const cardWidth = mode === 'nomination' ? 320 : 900
  const cardHeight = mode === 'nomination' ? 284 : 320
  const decoded = unpackBinaryMask(candidate.mask)
  let sourceCrop: Buffer | undefined
  let overlay: Buffer | undefined
  let cutout: Buffer | undefined
  const panels: Buffer[] = []
  let svg: Buffer | undefined
  try {
    const extractPipeline = sharp(image.data, {
      raw: { width: image.width, height: image.height, channels: 4 },
      limitInputPixels: 2_097_152,
      failOn: 'error',
    })
      .extract(crop)
      .raw()
    try {
      sourceCrop = await extractPipeline.toBuffer()
    } finally {
      extractPipeline.destroy()
    }
    overlay = Buffer.from(sourceCrop)
    if (mode === 'final') cutout = Buffer.alloc(crop.width * crop.height * 4)
    for (let y = 0; y < crop.height; y++) {
      for (let x = 0; x < crop.width; x++) {
        const sourceIndex = (y * crop.width + x) * 4
        const maskIndex = (crop.top + y) * image.width + crop.left + x
        const foreground = decoded[maskIndex] === 1
        if (foreground) {
          overlay[sourceIndex] = Math.round(((sourceCrop[sourceIndex] ?? 0) + 0) / 2)
          overlay[sourceIndex + 1] = Math.round(((sourceCrop[sourceIndex + 1] ?? 0) + 255) / 2)
          overlay[sourceIndex + 2] = Math.round(((sourceCrop[sourceIndex + 2] ?? 0) + 255) / 2)
          if (cutout) {
            cutout[sourceIndex] = sourceCrop[sourceIndex] ?? 0
            cutout[sourceIndex + 1] = sourceCrop[sourceIndex + 1] ?? 0
            cutout[sourceIndex + 2] = sourceCrop[sourceIndex + 2] ?? 0
            cutout[sourceIndex + 3] = sourceCrop[sourceIndex + 3] ?? 0
          }
        } else if (cutout) {
          cutout[sourceIndex] = 128
          cutout[sourceIndex + 1] = 128
          cutout[sourceIndex + 2] = 128
          cutout[sourceIndex + 3] = 255
        }
      }
    }
    const encodePanel = (pixels: Buffer) =>
      encode(
        sharp(pixels, {
          raw: { width: crop.width, height: crop.height, channels: 4 },
          limitInputPixels: 2_097_152,
          failOn: 'error',
        }).resize(panelWidth, panelHeight, {
          fit: 'contain',
          kernel: 'nearest',
          background: { r: 20, g: 24, b: 32, alpha: 1 },
        }),
        signal,
      )
    panels.push(await encodePanel(sourceCrop))
    panels.push(await encodePanel(overlay))
    if (cutout) panels.push(await encodePanel(cutout))
    assertActive(signal)
    const panelCount = mode === 'nomination' ? 2 : 3
    const panelSlotWidth = cardWidth / panelCount
    const gap = 4
    const headerHeight = 28
    const lefts = Array.from({ length: panelCount }, (_, index) => index * panelSlotWidth + gap)
    const overlays: sharp.OverlayOptions[] = panels.map((panel, index) => ({
      input: panel,
      left: lefts[index] ?? 0,
      top: headerHeight,
    }))
    const labels =
      mode === 'nomination'
        ? ['clean context', 'cyan mask overlay']
        : ['clean context', 'cyan mask overlay', 'masked cutout']
    svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cardWidth}" height="${cardHeight}"><rect width="100%" height="${headerHeight}" fill="#111827"/><text x="8" y="19" font-family="DejaVu Sans,sans-serif" font-size="14" fill="white">${safeSvg(candidate.alias)} (${safeSvg(candidate.sourceAlias)})</text>${labels.map((label, index) => `<text x="${(lefts[index] ?? 0) + 3}" y="${cardHeight - 6}" font-family="DejaVu Sans,sans-serif" font-size="12" fill="#111827">${label}</text>`).join('')}</svg>`,
    )
    return await encode(
      sharp({
        create: {
          width: cardWidth,
          height: cardHeight,
          channels: 4,
          background: '#f8fafc',
        },
      }).composite([...overlays, { input: svg }]),
      signal,
    )
  } finally {
    decoded.fill(0)
    sourceCrop?.fill(0)
    overlay?.fill(0)
    cutout?.fill(0)
    svg?.fill(0)
    for (const panel of panels) panel.fill(0)
  }
}

export function createSharpH5Presentation(): H5PresentationPort {
  return {
    async renderNomination(input) {
      const image: RgbaRaster = {
        data: Uint8Array.from(input.image.data),
        width: input.image.width,
        height: input.image.height,
        format: 'rgba8',
      }
      const candidates = input.candidates.map((candidate) => ({
        ...candidate,
        bounds: { ...candidate.bounds },
        mask: clonePacked(candidate.mask),
      }))
      const output: RasterImage[] = []
      try {
        assertActive(input.signal)
        output.push(await pngRaster(image, input.signal))
        for (let offset = 0; offset < candidates.length; offset += 6) {
          const group = candidates.slice(offset, offset + 6)
          const tiles: sharp.OverlayOptions[] = []
          const tileBuffers: Buffer[] = []
          try {
            for (let index = 0; index < group.length; index++) {
              const candidate = group[index]
              if (!candidate) continue
              const tile = await renderCard(image, candidate, 'nomination', input.signal)
              tileBuffers.push(tile)
              tiles.push({ input: tile, left: (index % 3) * 320, top: Math.floor(index / 3) * 284 })
            }
            const sheet = await encode(
              sharp({
                create: {
                  width: 960,
                  height: 568,
                  channels: 4,
                  background: '#cbd5e1',
                },
              }).composite(tiles),
              input.signal,
            )
            output.push({ bytes: new Uint8Array(sheet), width: 960, height: 568 })
          } finally {
            for (const tile of tileBuffers) tile.fill(0)
          }
        }
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
      const image: RgbaRaster = {
        data: Uint8Array.from(input.image.data),
        width: input.image.width,
        height: input.image.height,
        format: 'rgba8',
      }
      const candidates = input.candidates.map((candidate) => ({
        ...candidate,
        bounds: { ...candidate.bounds },
        mask: clonePacked(candidate.mask),
      }))
      const output: RasterImage[] = []
      try {
        assertActive(input.signal)
        output.push(await pngRaster(image, input.signal))
        for (const candidate of candidates) {
          const card = await renderCard(image, candidate, 'final', input.signal)
          output.push({ bytes: new Uint8Array(card), width: 900, height: 320 })
          card.fill(0)
        }
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
