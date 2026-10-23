import type { DecisionPort, RasterPort } from '../entities/contracts.js'
import { ClassifierError } from '../entities/errors.js'
import type { CutoutRasterPort } from '../entities/cutout-raster.js'
import type { BoundaryViewPort } from '../entities/boundary-view.js'
import type {
  ObjectProposalPort,
  ObjectProposalPresentationPort,
} from '../entities/object-proposals.js'
import type { ImageRepresentationPort } from '../entities/representation.js'
import type { ExtractInput, ExtractionResult, SegmentationPort } from '../entities/segmentation.js'
import type { SegmentationBoxCheckPort } from '../entities/segmentation-verification.js'
import type {
  WholeObjectLocateInput,
  WholeObjectLocalizationResult,
} from '../entities/whole-object.js'
import { locateWholeObjectInput } from '../processes/whole-object.js'
import type { WholeObjectIntervalPolicy } from '../processes/whole-object.js'
import { locateInput } from '../processes/locate.js'
import { extractFromRegion } from '../processes/extract-from-region.js'
import { extractObject } from '../processes/extract.js'
import { locateFromProposals } from '../processes/proposal-location.js'

type ClassifierSpatialDeps = {
  getDecision: () => DecisionPort
  raster: RasterPort
  cutoutRaster: CutoutRasterPort
  segmenter: SegmentationPort | undefined
  boxCheck: SegmentationBoxCheckPort | undefined
  proposalDependencies:
    | {
        decision: DecisionPort
        raster: RasterPort
        image: CutoutRasterPort
        proposals: ObjectProposalPort
        presentation: ObjectProposalPresentationPort
      }
    | undefined
  boundaryView: BoundaryViewPort | undefined
  intervalPolicy: WholeObjectIntervalPolicy | undefined
}

export function createClassifierSpatial(deps: ClassifierSpatialDeps) {
  const {
    getDecision,
    raster,
    cutoutRaster,
    segmenter,
    boxCheck,
    proposalDependencies,
    boundaryView,
    intervalPolicy,
  } = deps

  function extractRegion(
    input: Omit<ExtractInput, 'signal'>,
    signal: AbortSignal,
    representation: ImageRepresentationPort | undefined,
  ): Promise<ExtractionResult> {
    if (!segmenter || !boxCheck)
      throw new ClassifierError('UNSUPPORTED', 'Region extraction requires a SegmentationPort')
    if (representation)
      throw new ClassifierError('UNSUPPORTED', 'Checked segmentation requires vision input')
    return extractFromRegion(
      { ...input, signal },
      {
        raster,
        image: cutoutRaster,
        segmenter,
        boxCheck,
        locateRegion: (source, { signal: operationSignal, ...request }) =>
          locateInput(
            { ...request, image: source.bytes },
            getDecision(),
            raster,
            operationSignal,
            undefined,
            representation,
          ),
      },
    )
  }

  async function locateWhole(
    input: Omit<WholeObjectLocateInput, 'signal'>,
    signal: AbortSignal,
    representation: ImageRepresentationPort | undefined,
  ): Promise<WholeObjectLocalizationResult> {
    if (segmenter) {
      const result = await extractRegion(input, signal, representation)
      if (result.status === 'extracted') return result.location
      if (result.status === 'unknown' && result.reason === 'segmentation-uncertain')
        return {
          status: 'unknown',
          reason: 'segmentation-uncertain',
          metadata: 'metadata' in result ? result.metadata : result.location.metadata,
          ...(result.verification ? { verification: result.verification } : {}),
        }
      return result
    }
    if (proposalDependencies) {
      if (representation)
        throw new ClassifierError('UNSUPPORTED', 'Mask proposal selection requires vision input')
      return (await locateFromProposals(input, proposalDependencies, signal)).location
    }
    return locateWholeObjectInput(
      input,
      getDecision(),
      raster,
      signal,
      representation,
      boundaryView,
      intervalPolicy,
    )
  }

  function extractWithProposals(
    snapshot: Omit<ExtractInput, 'signal'>,
    signal: AbortSignal,
    representation: ImageRepresentationPort | undefined,
  ): Promise<ExtractionResult> {
    let prepared: Awaited<ReturnType<typeof locateFromProposals>> | undefined
    const selectedMask: SegmentationPort = {
      async segment() {
        if (!prepared?.mask || !prepared.segmentation)
          throw new ClassifierError('INVALID_RESPONSE', 'Proposal selection omitted its mask')
        return {
          status: 'segmented',
          mask: prepared.mask,
          metadata: prepared.segmentation,
        }
      },
      async settle() {},
      async dispose() {},
    }
    return extractObject(
      { ...snapshot, mode: 'whole-object', signal },
      {
        raster,
        image: cutoutRaster,
        segmenter: selectedMask,
        locateWhole: async (source, { signal: requestSignal, ...request }) => {
          const wholeInput = {
            ...request,
            mode: 'whole-object' as const,
            image: source.bytes,
          }
          if (!proposalDependencies)
            throw new ClassifierError('UNSUPPORTED', 'ObjectProposalPort is required')
          if (representation)
            throw new ClassifierError(
              'UNSUPPORTED',
              'Mask proposal selection requires vision input',
            )
          prepared = await locateFromProposals(wholeInput, proposalDependencies, requestSignal)
          return prepared.location
        },
      },
    )
  }

  return { locateWhole, extractRegion, extractWithProposals }
}
