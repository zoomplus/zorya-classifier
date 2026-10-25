import type { LocalizationResult, LocateInput, Representation } from '../entities/contracts.js'
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
import { createClassifierRuntime, parseOperationSignal } from './classifier-runtime.js'
import { createClassifierSpatial } from './classifier-spatial.js'
import type { ComposedClassifier, WithRepresentationField } from './composed-classifier.js'

export type { Classifier, ClassifierOptions } from './classifier-contracts.js'

interface ResearchRepresentationHook {
  representationPort: ImageRepresentationPort
  acceptsRepresentation(raw: unknown): boolean
}

type OperationBody = { representation?: unknown }

function prepareResearchOperationInput(
  rest: OperationBody & Record<string, unknown>,
  research: ResearchRepresentationHook | undefined,
): { rest: OperationBody & Record<string, unknown>; port: ImageRepresentationPort | undefined } {
  if (!research || rest.representation === undefined) return { rest, port: undefined }
  if (!research.acceptsRepresentation(rest.representation)) return { rest, port: undefined }
  return {
    rest: { ...rest, representation: { type: 'vision' } satisfies Representation },
    port: research.representationPort,
  }
}

export function createClassifier(options: ClassifierOptions): Classifier {
  return composeClassifier(options)
}

/** Internal composition seam for benchmark helpers; not re-exported from public entry points. */
export function composeClassifier<R = Representation>(
  options: ClassifierOptions,
  research?: ResearchRepresentationHook,
  boundaryView?: BoundaryViewPort,
  intervalPolicy?: WholeObjectIntervalPolicy,
): ComposedClassifier<R> {
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

  function locate(
    input: WithRepresentationField<WholeObjectLocateInput, R>,
  ): Promise<WholeObjectLocalizationResult>
  function locate(input: WithRepresentationField<LocateInput, R>): Promise<LocalizationResult>
  function locate(
    input: WithRepresentationField<AnyLocateInput, R>,
  ): Promise<LocalizationResult | WholeObjectLocalizationResult>
  async function locate(
    input: WithRepresentationField<AnyLocateInput, R>,
  ): Promise<LocalizationResult | WholeObjectLocalizationResult> {
    runtime.assertAcceptingOperations()
    if (!input || typeof input !== 'object')
      throw new ClassifierError('INVALID_INPUT', 'Expected locate input object')
    const { signal, ...rest } = input
    const parent = parseOperationSignal(signal)
    const { rest: rewritten, port } = prepareResearchOperationInput(rest, research)
    if (rewritten.mode === 'whole-object') {
      const parsed = parse(wholeObjectSchema, rewritten)
      return runtime.withOwnedInput(
        parsed.image.byteLength,
        parent,
        () => ({ ...parsed, image: new Uint8Array(parsed.image) }),
        (snapshot, s) => spatial.locateWhole(snapshot, s, port),
      )
    }
    const parsed = parse(locateSchema, rewritten)
    return runtime.withOwnedInput(
      parsed.image.byteLength,
      parent,
      () => ({ ...parsed, image: new Uint8Array(parsed.image) }),
      (snapshot, s) => locateInput(snapshot, options.decision, raster, s, options.refinement, port),
    )
  }

  return {
    async classify(input) {
      runtime.assertAcceptingOperations()
      if (!input || typeof input !== 'object')
        throw new ClassifierError('INVALID_INPUT', 'Expected classify input object')
      const { signal, ...rest } = input
      const parent = parseOperationSignal(signal)
      const { rest: rewritten, port } = prepareResearchOperationInput(rest, research)
      const parsed = parse(classifySchema, rewritten)
      const hasImage = typeof parsed.input !== 'string' && parsed.input.image !== undefined
      const representation = hasImage ? port : undefined
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
      const { rest: rewritten, port } = prepareResearchOperationInput(rest, research)
      const parsed = parse(extractSchema, rewritten)
      if (!segmenter && !proposalDependencies)
        throw new ClassifierError(
          'UNSUPPORTED',
          'extract requires an explicit SegmentationPort or ObjectProposalPort',
        )
      return runtime.withOwnedInput(
        parsed.image.byteLength,
        parent,
        () => ({ ...parsed, image: new Uint8Array(parsed.image) }),
        (snapshot, s) => {
          if (segmenter) return spatial.extractRegion(snapshot, s, port)
          return spatial.extractWithProposals(snapshot, s, port)
        },
      )
    },
    dispose: () => runtime.dispose(),
  }
}
