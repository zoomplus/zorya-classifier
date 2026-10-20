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
import { createSharpCutoutRaster } from '../infrastructure/segmentation/cutout-raster.js'
import type { BoundaryViewPort } from '../entities/boundary-view.js'

export interface ClassifierOptions {
  decision: DecisionPort
  timeoutMs?: number
  concurrency?: number
  maxQueue?: number
  maxInputBytes?: number
  refinement?: RefinementPort
  /** Caller-owned; classifier disposal never disposes a shared segmenter. */
  segmentation?: SegmentationPort
}
export interface Classifier {
  classify(input: ClassifyInput): Promise<ClassificationResult>
  locate(input: WholeObjectLocateInput): Promise<WholeObjectLocalizationResult>
  locate(input: LocateInput): Promise<LocalizationResult>
  locate(input: AnyLocateInput): Promise<LocalizationResult | WholeObjectLocalizationResult>
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
  if (
    segmenter !== undefined &&
    (!segmenter ||
      typeof segmenter.segment !== 'function' ||
      typeof segmenter.settle !== 'function' ||
      typeof segmenter.dispose !== 'function')
  )
    throw new ClassifierError('INVALID_INPUT', 'segmentation must implement SegmentationPort')
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
        return await run(parent, (s) =>
          locateWholeObjectInput(
            snapshot,
            options.decision,
            raster,
            s,
            representation,
            boundaryView,
            intervalPolicy,
          ),
        )
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
      if (!segmenter)
        throw new ClassifierError('UNSUPPORTED', 'extract requires an explicit SegmentationPort')
      const representation = representationFor(parsed.representation)
      const release = inputBudget.reserve(parsed.image.byteLength)
      try {
        const snapshot = { ...parsed, image: new Uint8Array(parsed.image) }
        return await run(parent, (s) =>
          extractObject(
            { ...snapshot, mode: 'whole-object', signal: s },
            {
              raster,
              image: cutoutRaster,
              segmenter,
              locateWhole: (source, { signal: requestSignal, ...request }) =>
                locateWholeObjectInput(
                  { ...request, mode: 'whole-object', image: source.bytes },
                  options.decision,
                  raster,
                  requestSignal,
                  representation,
                  boundaryView,
                  intervalPolicy,
                ),
            },
          ),
        )
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
