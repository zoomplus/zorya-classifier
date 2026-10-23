import { performance } from 'node:perf_hooks'

import type {
  DecisionMetadata,
  DecisionPort,
  DecisionRequest,
  LocateInput,
  LocalizationMetadata,
  RasterPort,
} from '../entities/contracts.js'
import { parse, pixelRectSchema } from '../entities/contracts.js'
import { assertActive, ClassifierError } from '../entities/errors.js'
import type { CutoutRasterPort } from '../entities/cutout-raster.js'
import type {
  ObjectProposalPort,
  ObjectProposalPresentationPort,
} from '../entities/object-proposals.js'
import { objectProposalLimits } from '../entities/object-proposals.js'
import type { BinaryMask, SegmentationMetadata } from '../entities/segmentation.js'
import type {
  WholeObjectLocateInput,
  WholeObjectLocated,
  WholeObjectLocalizationResult,
} from '../entities/whole-object.js'
import { wholeObjectSchema } from '../entities/whole-object.js'
import { presence, selection, validateDecision } from '../features/choice.js'
import { packBinaryMask, unpackBinaryMask } from '../features/segmentation/packed-mask.js'
import {
  copyDecisionMetadata,
  copyDecisionState,
  makeQuestion,
  makeState,
  makeWholeVerificationRequest,
  presentationStates,
} from '../features/proposals/presentation.js'
import {
  deriveMaskAndRegion,
  validateProposalBatch,
  validateRectInImage,
  validateRgba,
  validateSource,
} from '../features/proposals/validation.js'
import { locateInput } from './locate.js'

interface ProposalLocateDependencies {
  decision: DecisionPort
  raster: RasterPort
  image: CutoutRasterPort
  proposals: ObjectProposalPort
  presentation: ObjectProposalPresentationPort
}

function localizationMetadata(
  source: { width: number; height: number },
  stages: DecisionMetadata[],
  started: number,
): LocalizationMetadata {
  return {
    image: {
      width: source.width,
      height: source.height,
      coordinateSpace: 'oriented-source-pixels',
    },
    stages,
    durationMs: performance.now() - started,
    knownCostUsd: stages.reduce((total, stage) => total + (stage.costUsd ?? 0), 0),
    unknownCostCount: stages.filter((stage) => stage.costUsd === null).length,
  }
}

function unknown(
  reason:
    | 'extent-uncertain'
    | 'extent-inconsistent'
    | 'instance-ambiguous'
    | 'representation-limit',
  metadata: LocalizationMetadata,
): WholeObjectLocalizationResult {
  return { status: 'unknown', reason, metadata }
}

/** Localize from closed, externally generated masks without exposing private proposal metadata. */
export async function locateFromProposals(
  input: Omit<WholeObjectLocateInput, 'signal'>,
  dependencies: ProposalLocateDependencies,
  signal: AbortSignal,
): Promise<{
  location: WholeObjectLocalizationResult
  mask?: BinaryMask
  segmentation?: SegmentationMetadata
}> {
  const started = performance.now()
  const args = parse(wholeObjectSchema, input)
  assertActive(signal)
  const normalized = validateSource(await dependencies.raster.normalize(args.image, signal))
  assertActive(signal)
  if (normalized.width * normalized.height > objectProposalLimits.imagePixels)
    throw new ClassifierError('RESOURCE_LIMIT', 'Proposal source exceeds its pixel limit')
  const roi = parse(
    pixelRectSchema,
    args.roi ?? { left: 0, top: 0, width: normalized.width, height: normalized.height },
  )
  validateRectInImage(roi, normalized, 'ROI')

  const seedInput: Omit<LocateInput, 'signal'> = {
    image: args.image,
    target: args.target,
    exclusions: args.exclusions,
    roi,
    mode: 'region',
  }
  const seedResult = await locateInput(
    seedInput,
    dependencies.decision,
    dependencies.raster,
    signal,
  )
  assertActive(signal)
  if (seedResult.status !== 'located') return { location: seedResult }

  const stages = seedResult.metadata.stages.map(copyDecisionMetadata)
  const metadata = () => localizationMetadata(source, stages, started)
  const rgba = await dependencies.image.rgba(normalized, signal)
  const source = validateRgba(rgba, normalized.width, normalized.height)
  assertActive(signal)
  const seed = parse(pixelRectSchema, seedResult.region, 'INVALID_RESPONSE')
  validateRectInImage(seed, source, 'Seed region')
  if (
    seed.left < roi.left ||
    seed.top < roi.top ||
    seed.left + seed.width > roi.left + roi.width ||
    seed.top + seed.height > roi.top + roi.height
  )
    return { location: unknown('extent-inconsistent', metadata()) }

  const roiCopy = { ...roi }
  const proposalInputImage = { ...source, data: new Uint8Array(source.data) }
  const rawBatch = await dependencies.proposals.propose({
    image: proposalInputImage,
    seedRegion: { ...seed },
    roi: roiCopy,
    signal,
  })
  assertActive(signal)
  const batch = validateProposalBatch(rawBatch, source)
  if (batch.proposals.length === 0) return { location: unknown('extent-uncertain', metadata()) }

  const derived = batch.proposals.map((proposal) => {
    const sourcePixels = unpackBinaryMask(proposal.mask)
    const mapped = deriveMaskAndRegion(sourcePixels, source, roi, seed)
    return {
      ...proposal,
      mask: packBinaryMask(mapped.data, source.width, source.height),
      region: mapped.region,
      intersectsSeed: mapped.intersectsSeed,
      touchesRoi: mapped.touchesRoi,
    }
  })
  const proposalViews = derived.map(({ id, mask, region }) => ({ id, mask, region }))
  const sheetStates = await presentationStates(dependencies, source, seed, proposalViews, signal)
  const originalState = copyDecisionState(await dependencies.raster.imageState(normalized, signal))
  assertActive(signal)

  const ids = batch.proposals.map((proposal) => proposal.id)
  const state = makeState(args.target, args.exclusions, seed, roi, originalState, sheetStates)
  const choiceRequest: DecisionRequest = {
    state,
    questions: { selection: makeQuestion(proposalViews) },
  }
  assertActive(signal)
  const choiceResult = validateDecision(
    choiceRequest,
    await dependencies.decision.decide(choiceRequest, signal),
  )
  stages.push(copyDecisionMetadata(choiceResult.metadata))
  assertActive(signal)
  const choice = selection(choiceResult, [...ids, 'none'], 1).choice
  if (choice === 'none') return { location: unknown('extent-uncertain', metadata()) }
  const selected = derived[ids.indexOf(choice)]
  if (!selected) throw new ClassifierError('INVALID_RESPONSE', 'Selected proposal alias is missing')
  if (!selected.region || !selected.intersectsSeed)
    return { location: unknown('extent-inconsistent', metadata()) }
  const selectedPixels = unpackBinaryMask(selected.mask)

  const selectedPresentation = await presentationStates(
    dependencies,
    source,
    seed,
    [{ id: selected.id, mask: selected.mask, region: selected.region }],
    signal,
  )
  const focusedState = makeState(
    args.target,
    args.exclusions,
    seed,
    roi,
    originalState,
    selectedPresentation,
  )

  const wholeRequest = makeWholeVerificationRequest(choice, focusedState)
  assertActive(signal)
  const wholeResult = validateDecision(
    wholeRequest,
    await dependencies.decision.decide(wholeRequest, signal),
  )
  stages.push(copyDecisionMetadata(wholeResult.metadata))
  assertActive(signal)
  if (presence(wholeResult) <= 0.5) return { location: unknown('extent-uncertain', metadata()) }

  const region = { ...selected.region }
  const { left, top, width, height } = region
  const location: WholeObjectLocated = {
    status: 'located',
    kind: 'whole-object',
    region,
    normalizedRegion: {
      left: left / source.width,
      top: top / source.height,
      width: width / source.width,
      height: height / source.height,
    },
    seedRegion: { ...seed },
    bounds: {
      left: { start: left, endExclusive: left + 1 },
      right: { start: left + width - 1, endExclusive: left + width },
      top: { start: top, endExclusive: top + 1 },
      bottom: { start: top + height - 1, endExclusive: top + height },
    },
    completeness: selected.touchesRoi ? 'boundary-limited' : 'visible-object',
    method: 'pixel-mask-proposals-v1',
    proposalMetadata: batch.metadata,
    metadata: metadata(),
  }
  return {
    location,
    mask: {
      data: selectedPixels,
      width: source.width,
      height: source.height,
      format: 'binary-u8',
    },
    segmentation: batch.metadata,
  }
}
