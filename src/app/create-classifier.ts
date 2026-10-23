import type { LocalizationResult, LocateInput } from '../entities/contracts.js'
import { classifySchema, locateSchema, parse } from '../entities/contracts.js'
import { ClassifierError } from '../entities/errors.js'
import { createSharpRaster } from '../infrastructure/raster.js'
import { classifyInput } from '../processes/classify.js'
import { locateInput } from '../processes/locate.js'
import type {
  AnyLocateInput,
  WholeObjectLocateInput,
  WholeObjectLocalizationResult,
} from '../entities/whole-object.js'
import { wholeObjectSchema } from '../entities/whole-object.js'
import type { WholeObjectIntervalPolicy } from '../processes/whole-object.js'
import type { ImageRepresentationPort } from '../entities/representation.js'
import { extractSchema } from '../entities/segmentation.js'
import { createSharpCutoutRaster } from '../infrastructure/segmentation/cutout-raster.js'
import type { BoundaryViewPort } from '../entities/boundary-view.js'
import { createSharpObjectProposalPresentation } from '../infrastructure/segmentation/proposal-presentation.js'
import { createSegmentationBoxCheck } from '../features/segmentation/box-check.js'
import { createSharpSegmentationBoxPresentation } from '../infrastructure/segmentation/box-presentation.js'
import type { Classifier, ClassifierOptions } from './classifier-contracts.js'
import { validateClassifierOptions } from './classifier-config.js'
import { createClassifierRepresentation } from './classifier-representation.js'
import { createClassifierRuntime, parseOperationSignal } from './classifier-runtime.js'
import { createClassifierSpatial } from './classifier-spatial.js'

export type { Classifier, ClassifierOptions } from './classifier-contracts.js'

export function createClassifier(options: ClassifierOptions): Classifier {
  return composeClassifier(options)
}

/** Internal composition seam for benchmark helpers; not re-exported from public entry points. */
export function composeClassifier(
  options: ClassifierOptions,
  experimental?: ImageRepresentationPort,
  boundaryView?: BoundaryViewPort,
  intervalPolicy?: WholeObjectIntervalPolicy,
): Classifier {
  const { config, ports } = validateClassifierOptions(options)
  const { segmenter, objectProposals } = ports
  const runtime = createClassifierRuntime(config)
  const raster = createSharpRaster()
  const cutoutRaster = createSharpCutoutRaster()
  const boxCheck = segmenter
    ? (options.segmentationBoxCheck ??
      createSegmentationBoxCheck({
        decision: options.decision,
        presentation: createSharpSegmentationBoxPresentation(),
        imageState: raster.imageState,
      }))
    : undefined
  const proposalDependencies = objectProposals
    ? {
        decision: options.decision,
        raster,
        image: cutoutRaster,
        proposals: objectProposals,
        presentation: createSharpObjectProposalPresentation(),
      }
    : undefined
  const { representationFor } = createClassifierRepresentation(experimental)
  const spatial = createClassifierSpatial({
    getDecision: () => options.decision,
    raster,
    cutoutRaster,
    segmenter,
    boxCheck,
    proposalDependencies,
    boundaryView,
    intervalPolicy,
  })

  function locate(input: WholeObjectLocateInput): Promise<WholeObjectLocalizationResult>
  function locate(input: LocateInput): Promise<LocalizationResult>
  function locate(
    input: AnyLocateInput,
  ): Promise<LocalizationResult | WholeObjectLocalizationResult>
  async function locate(
    input: AnyLocateInput,
  ): Promise<LocalizationResult | WholeObjectLocalizationResult> {
    runtime.assertAcceptingOperations()
    if (!input || typeof input !== 'object')
      throw new ClassifierError('INVALID_INPUT', 'Expected locate input object')
    const { signal, ...rest } = input
    const parent = parseOperationSignal(signal)
    if (rest.mode === 'whole-object') {
      const parsed = parse(wholeObjectSchema, rest)
      const representation = representationFor(parsed.representation)
      return runtime.withOwnedInput(
        parsed.image.byteLength,
        parent,
        () => ({ ...parsed, image: new Uint8Array(parsed.image) }),
        (snapshot, s) => spatial.locateWhole(snapshot, s, representation),
      )
    }
    const parsed = parse(locateSchema, rest)
    const representation = representationFor(parsed.representation)
    return runtime.withOwnedInput(
      parsed.image.byteLength,
      parent,
      () => ({ ...parsed, image: new Uint8Array(parsed.image) }),
      (snapshot, s) =>
        locateInput(snapshot, options.decision, raster, s, options.refinement, representation),
    )
  }

  return {
    async classify(input) {
      runtime.assertAcceptingOperations()
      if (!input || typeof input !== 'object')
        throw new ClassifierError('INVALID_INPUT', 'Expected classify input object')
      const { signal, ...rest } = input
      const parent = parseOperationSignal(signal)
      const parsed = parse(classifySchema, rest)
      const hasImage = typeof parsed.input !== 'string' && parsed.input.image !== undefined
      const representation = hasImage ? representationFor(parsed.representation) : undefined
      const byteCount =
        typeof parsed.input === 'string'
          ? Buffer.byteLength(parsed.input)
          : (parsed.input.image?.byteLength ?? 0) + Buffer.byteLength(parsed.input.text ?? '')
      return runtime.withOwnedInput(
        byteCount,
        parent,
        () => {
          return typeof parsed.input === 'string'
            ? parsed.input
            : {
                ...parsed.input,
                ...(parsed.input.image === undefined
                  ? {}
                  : { image: new Uint8Array(parsed.input.image) }),
              }
        },
        (media, s) =>
          classifyInput({ ...parsed, input: media }, options.decision, raster, s, representation),
      )
    },
    locate,
    async extract(input) {
      runtime.assertAcceptingOperations()
      if (!input || typeof input !== 'object')
        throw new ClassifierError('INVALID_INPUT', 'Expected extract input object')
      const { signal, ...rest } = input
      const parent = parseOperationSignal(signal)
      const parsed = parse(extractSchema, rest)
      if (!segmenter && !proposalDependencies)
        throw new ClassifierError(
          'UNSUPPORTED',
          'extract requires an explicit SegmentationPort or ObjectProposalPort',
        )
      const representation = representationFor(parsed.representation)
      return runtime.withOwnedInput(
        parsed.image.byteLength,
        parent,
        () => ({ ...parsed, image: new Uint8Array(parsed.image) }),
        (snapshot, s) => {
          if (segmenter) return spatial.extractRegion(snapshot, s, representation)
          return spatial.extractWithProposals(snapshot, s, representation)
        },
      )
    },
    dispose: () => runtime.dispose(),
  }
}
