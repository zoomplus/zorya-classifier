import { z } from 'zod'
import type {
  ClassificationResult,
  ClassifyInput,
  DecisionPort,
  LocalizationResult,
  LocateInput,
  RefinementPort,
  Representation,
} from '../entities/contracts.js'
import { classifySchema, locateSchema, parse } from '../entities/contracts.js'
import { ClassifierError } from '../entities/errors.js'
import { createSharpRaster } from '../infrastructure/raster.js'
import { classifyInput } from '../processes/classify.js'
import { locateInput } from '../processes/locate.js'
import { OperationGate } from '../shared/gate.js'
import { OperationScope } from '../shared/scope.js'
import { InputBudget } from '../shared/input-budget.js'
import type {
  AnyLocateInput,
  WholeObjectLocateInput,
  WholeObjectLocalizationResult,
} from '../entities/whole-object.js'
import { wholeObjectSchema } from '../entities/whole-object.js'
import { locateWholeObjectInput } from '../processes/whole-object.js'
import type { WholeObjectIntervalPolicy } from '../processes/whole-object.js'
import type { ImageRepresentationPort } from '../entities/representation.js'
import { preparedTextSchema, representationLimits } from '../entities/representation.js'
import type { ExtractInput, ExtractionResult, SegmentationPort } from '../entities/segmentation.js'
import { extractSchema } from '../entities/segmentation.js'
import { extractObject } from '../processes/extract.js'
import { extractFromRegion } from '../processes/extract-from-region.js'
import { createSharpCutoutRaster } from '../infrastructure/segmentation/cutout-raster.js'
import type { BoundaryViewPort } from '../entities/boundary-view.js'
import type { ObjectProposalPort } from '../entities/object-proposals.js'
import { locateFromProposals } from '../processes/proposal-location.js'
import { createSharpObjectProposalPresentation } from '../infrastructure/segmentation/proposal-presentation.js'
import type { SegmentationBoxCheckPort } from '../entities/segmentation-verification.js'
import { createSegmentationBoxCheck } from '../features/segmentation/box-check.js'
import { createSharpSegmentationBoxPresentation } from '../infrastructure/segmentation/box-presentation.js'

export interface ClassifierOptions {
  decision: DecisionPort
  timeoutMs?: number
  concurrency?: number
  maxQueue?: number
  maxInputBytes?: number
  /** @experimental Optional legacy region refinement; unqualified for general use. */
  refinement?: RefinementPort
  /** Caller-owned; classifier disposal never disposes a shared segmenter. @experimental Unqualified segmentation adapter. */
  segmentation?: SegmentationPort
  /** Optional caller-owned containment checker; by default reuses the injected decision port. @experimental Unqualified box-check override. */
  segmentationBoxCheck?: SegmentationBoxCheckPort
  /** Explicit, caller-owned pixel-mask proposal strategy for whole-object operations. @experimental Unqualified proposal path. */
  objectProposals?: ObjectProposalPort
}
export interface Classifier {
  classify(input: ClassifyInput): Promise<ClassificationResult>
  /** @experimental Unqualified spatial localization; see {@link LocateInput} and {@link WholeObjectLocateInput}. */
  locate(input: WholeObjectLocateInput): Promise<WholeObjectLocalizationResult>
  /** @experimental Unqualified coarse region search; returns a hypothesized grid cell. */
  locate(input: LocateInput): Promise<LocalizationResult>
  /** @experimental Unqualified spatial localization. */
  locate(input: AnyLocateInput): Promise<LocalizationResult | WholeObjectLocalizationResult>
  /** @experimental Region-seeded extraction; unqualified for general mask or object accuracy. */
  extract(input: ExtractInput): Promise<ExtractionResult>
  dispose(): Promise<void>
}
const configSchema = z.object({
  timeoutMs: z.number().int().min(1).max(120000).default(45000),
  concurrency: z.number().int().min(1).max(4).default(2),
  maxQueue: z.number().int().min(0).max(32).default(16),
  maxInputBytes: z
    .number()
    .int()
    .min(1)
    .max(256 * 1024 * 1024)
    .default(64 * 1024 * 1024),
})
function signalOf(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined
  if (!(value instanceof AbortSignal))
    throw new ClassifierError('INVALID_INPUT', 'signal must be an AbortSignal')
  return value
}
export function createClassifier(options: ClassifierOptions): Classifier {
  return composeClassifier(options)
}

/** Internal benchmark composition. No research codec is exported by the npm entry points. */
export function createResearchClassifier(
  options: ClassifierOptions,
  experimental?: ImageRepresentationPort,
  boundaryView?: BoundaryViewPort,
  intervalPolicy?: WholeObjectIntervalPolicy,
): Classifier {
  return composeClassifier(options, experimental, boundaryView, intervalPolicy)
}

function composeClassifier(
  options: ClassifierOptions,
  experimental?: ImageRepresentationPort,
  boundaryView?: BoundaryViewPort,
  intervalPolicy?: WholeObjectIntervalPolicy,
): Classifier {
  if (!options || typeof options.decision?.decide !== 'function')
    throw new ClassifierError('INVALID_INPUT', 'A DecisionPort is required')
  const segmenter = options.segmentation
  const objectProposals = options.objectProposals
  if (
    segmenter !== undefined &&
    (!segmenter ||
      typeof segmenter.segment !== 'function' ||
      (segmenter.expand !== undefined && typeof segmenter.expand !== 'function') ||
      typeof segmenter.settle !== 'function' ||
      typeof segmenter.dispose !== 'function')
  )
    throw new ClassifierError('INVALID_INPUT', 'segmentation must implement SegmentationPort')
  if (
    options.segmentationBoxCheck !== undefined &&
    (!options.segmentationBoxCheck || typeof options.segmentationBoxCheck.check !== 'function')
  )
    throw new ClassifierError('INVALID_INPUT', 'segmentationBoxCheck must implement its check port')
  if (
    objectProposals !== undefined &&
    (!objectProposals ||
      typeof objectProposals.propose !== 'function' ||
      typeof objectProposals.settle !== 'function' ||
      typeof objectProposals.dispose !== 'function')
  )
    throw new ClassifierError('INVALID_INPUT', 'objectProposals must implement ObjectProposalPort')
  const config = parse(configSchema, {
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
    maxQueue: options.maxQueue,
    maxInputBytes: options.maxInputBytes,
  })
  const gate = new OperationGate(config.concurrency, config.maxQueue)
  const inputBudget = new InputBudget(config.maxInputBytes)
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
  const owned = new Map<OperationScope, Promise<unknown>>()
  let disposed = false
  const textRepresentation: ImageRepresentationPort | undefined = experimental
    ? {
        async prepare(input) {
          const result = parse(
            preparedTextSchema,
            await experimental.prepare(input),
            'INVALID_RESPONSE',
          )
          const bytes = result.state.reduce((sum, part) => sum + Buffer.byteLength(part, 'utf8'), 0)
          if (bytes > representationLimits.totalBytes || bytes !== result.metadata.bytes)
            throw new ClassifierError(
              'INVALID_RESPONSE',
              'Representation byte accounting is inconsistent',
            )
          return {
            state: result.state,
            metadata: {
              ...result.metadata,
              views: result.metadata.views.map(({ content, ...view }) => ({
                ...view,
                ...(content === undefined ? {} : { content }),
              })),
            },
          }
        },
      }
    : undefined
  function representationFor(
    value: Representation | undefined,
  ): ImageRepresentationPort | undefined {
    if (value?.type !== 'experimental-text') return undefined
    if (!textRepresentation)
      throw new ClassifierError(
        'UNSUPPORTED',
        'No text-image profile has passed release qualification yet',
      )
    return textRepresentation
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
      options.decision,
      raster,
      signal,
      representation,
      boundaryView,
      intervalPolicy,
    )
  }
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
            options.decision,
            raster,
            operationSignal,
            undefined,
            representation,
          ),
      },
    )
  }
  async function run<T>(
    signal: AbortSignal | undefined,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (disposed) throw new ClassifierError('DISPOSED', 'Classifier has been disposed')
    const scope = new OperationScope(config.timeoutMs, signal)
    const job = (async () => {
      let acquired = false
      try {
        await gate.acquire(scope.signal)
        acquired = true
        scope.guard()
        const result = await task(scope.signal)
        scope.guard()
        return result
      } catch (error) {
        scope.guard()
        throw error
      } finally {
        if (acquired) gate.release()
        scope.dispose()
        owned.delete(scope)
      }
    })()
    owned.set(scope, job)
    return job
  }
  function locate(input: WholeObjectLocateInput): Promise<WholeObjectLocalizationResult>
  function locate(input: LocateInput): Promise<LocalizationResult>
  function locate(
    input: AnyLocateInput,
  ): Promise<LocalizationResult | WholeObjectLocalizationResult>
  async function locate(
    input: AnyLocateInput,
  ): Promise<LocalizationResult | WholeObjectLocalizationResult> {
    if (disposed) throw new ClassifierError('DISPOSED', 'Classifier has been disposed')
    gate.assertAvailable()
    if (!input || typeof input !== 'object')
      throw new ClassifierError('INVALID_INPUT', 'Expected locate input object')
    const { signal, ...rest } = input
    const parent = signalOf(signal)
    if (rest.mode === 'whole-object') {
      const parsed = parse(wholeObjectSchema, rest)
      const representation = representationFor(parsed.representation)
      const release = inputBudget.reserve(parsed.image.byteLength)
      try {
        const snapshot = { ...parsed, image: new Uint8Array(parsed.image) }
        return await run(parent, (s) => locateWhole(snapshot, s, representation))
      } finally {
        release()
      }
    }
    const parsed = parse(locateSchema, rest)
    const representation = representationFor(parsed.representation)
    const release = inputBudget.reserve(parsed.image.byteLength)
    try {
      const snapshot = { ...parsed, image: new Uint8Array(parsed.image) }
      return await run(parent, (s) =>
        locateInput(snapshot, options.decision, raster, s, options.refinement, representation),
      )
    } finally {
      release()
    }
  }
  return {
    async classify(input) {
      if (disposed) throw new ClassifierError('DISPOSED', 'Classifier has been disposed')
      gate.assertAvailable()
      if (!input || typeof input !== 'object')
        throw new ClassifierError('INVALID_INPUT', 'Expected classify input object')
      const { signal, ...rest } = input
      const parent = signalOf(signal)
      const parsed = parse(classifySchema, rest)
      const hasImage = typeof parsed.input !== 'string' && parsed.input.image !== undefined
      const representation = hasImage ? representationFor(parsed.representation) : undefined
      const byteCount =
        typeof parsed.input === 'string'
          ? Buffer.byteLength(parsed.input)
          : (parsed.input.image?.byteLength ?? 0) + Buffer.byteLength(parsed.input.text ?? '')
      const release = inputBudget.reserve(byteCount)
      try {
        const media =
          typeof parsed.input === 'string'
            ? parsed.input
            : {
                ...parsed.input,
                ...(parsed.input.image === undefined
                  ? {}
                  : { image: new Uint8Array(parsed.input.image) }),
              }
        return await run(parent, (s) =>
          classifyInput({ ...parsed, input: media }, options.decision, raster, s, representation),
        )
      } finally {
        release()
      }
    },
    locate,
    async extract(input) {
      if (disposed) throw new ClassifierError('DISPOSED', 'Classifier has been disposed')
      gate.assertAvailable()
      if (!input || typeof input !== 'object')
        throw new ClassifierError('INVALID_INPUT', 'Expected extract input object')
      const { signal, ...rest } = input
      const parent = signalOf(signal)
      const parsed = parse(extractSchema, rest)
      if (!segmenter && !proposalDependencies)
        throw new ClassifierError(
          'UNSUPPORTED',
          'extract requires an explicit SegmentationPort or ObjectProposalPort',
        )
      const representation = representationFor(parsed.representation)
      const release = inputBudget.reserve(parsed.image.byteLength)
      try {
        const snapshot = { ...parsed, image: new Uint8Array(parsed.image) }
        return await run(parent, (s) => {
          if (segmenter) return extractRegion(snapshot, s, representation)
          let prepared: Awaited<ReturnType<typeof locateFromProposals>> | undefined
          // Per-operation ownership: no global selected-mask cache or second native inference.
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
            { ...snapshot, mode: 'whole-object', signal: s },
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
                prepared = await locateFromProposals(
                  wholeInput,
                  proposalDependencies,
                  requestSignal,
                )
                return prepared.location
              },
            },
          )
        })
      } finally {
        release()
      }
    },
    async dispose() {
      disposed = true
      for (const scope of owned.keys()) scope.abort()
      await Promise.allSettled(owned.values())
    },
  }
}
