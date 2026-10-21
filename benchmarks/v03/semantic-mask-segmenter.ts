import sharp from 'sharp'
import { z } from 'zod'
import type { DecisionPort, DecisionRequest, RasterImage } from '../../src/entities/contracts.js'
import { ClassifierError, assertActive } from '../../src/entities/errors.js'
import type { ObjectProposalPort } from '../../src/entities/object-proposals.js'
import { objectProposalLimits } from '../../src/entities/object-proposals.js'
import type { RgbaRaster } from '../../src/entities/representation.js'
import type {
  BinaryMask,
  SegmentationInput,
  SegmentationPort,
  SegmentationResult,
} from '../../src/entities/segmentation.js'
import { selection, validateDecision } from '../../src/features/choice.js'
import { validateMask } from '../../src/features/segmentation/mask.js'
import { unpackBinaryMask } from '../../src/features/segmentation/packed-mask.js'
import { createSharpRaster } from '../../src/infrastructure/raster.js'

const labels = ['A', 'B', 'C', 'D'] as const
export const semanticSeedPrompt = Object.freeze({
  task: 'Compare four candidate masks with the original image. Choose exactly one candidate that covers the entire visible requested object, not merely a part. Exclude unrelated objects and background. Choose none if no candidate covers the entire requested object. Do not infer hidden object parts or invent a candidate.',
  question:
    'Which candidate mask covers the entire visible requested object in the original image?',
})
const nativeMetadata = z
  .object({
    method: z.string().min(1),
    backend: z.string().min(1),
    durationMs: z.number().finite().nonnegative(),
    input: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict(),
    qualityScore: z.number().finite().optional(),
  })
  .strict()

/** The label occupies new pixels above the image, never a strip of source content. */
export async function renderSemanticMaskView(
  source: RgbaRaster,
  mask: BinaryMask,
  label: (typeof labels)[number],
  signal: AbortSignal,
): Promise<RasterImage> {
  assertActive(signal)
  const { width, height } = source
  const pixels = width * height
  if (
    source.data.length !== pixels * 4 ||
    mask.data.length !== pixels ||
    mask.width !== width ||
    mask.height !== height
  )
    throw new ClassifierError('INVALID_RESPONSE', 'Semantic presentation geometry mismatch')
  const overlay = Buffer.alloc(pixels * 4)
  for (let index = 0; index < pixels; index++) {
    const value = mask.data[index]
    if (value !== 0 && value !== 1)
      throw new ClassifierError('INVALID_RESPONSE', 'Mask pixels must be binary')
    if (value === 0) continue
    const x = index % width,
      y = Math.floor(index / width)
    const edge =
      x === 0 ||
      y === 0 ||
      x === width - 1 ||
      y === height - 1 ||
      mask.data[index - 1] !== 1 ||
      mask.data[index + 1] !== 1 ||
      mask.data[index - width] !== 1 ||
      mask.data[index + width] !== 1
    overlay.set([0, 220, 255, edge ? 255 : 82], index * 4)
  }
  const pipeline = sharp(source.data, { raw: { width, height, channels: 4 } }).composite([
    { input: overlay, raw: { width, height, channels: 4 } },
  ])
  let composed: Buffer | undefined
  try {
    composed = await pipeline.png().toBuffer()
    assertActive(signal)
    const banner = Buffer.from(
      `<svg width="${width}" height="42" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="42" fill="#07131d"/><text x="14" y="30" fill="white" font-family="Arial,sans-serif" font-size="26" font-weight="700">Candidate ${label}</text></svg>`,
    )
    const padded = sharp(composed)
      .extend({ top: 42, bottom: 0, left: 0, right: 0, background: '#07131d' })
      .composite([{ input: banner, top: 0, left: 0 }])
    try {
      const bytes = await padded.png().toBuffer()
      assertActive(signal)
      return { bytes, width, height: height + 42 }
    } finally {
      padded.destroy()
    }
  } finally {
    pipeline.destroy()
    composed?.fill(0)
    overlay.fill(0)
  }
}

/** Research composition. Proposal lifetime belongs to the runner, not to this wrapper. */
export function createSemanticMaskSegmenter(options: {
  proposals: ObjectProposalPort
  decision: DecisionPort
}): SegmentationPort {
  const raster = createSharpRaster()
  const active = new Map<Promise<SegmentationResult>, AbortController>()
  let disposed = false
  async function segmentWork(input: SegmentationInput): Promise<SegmentationResult> {
    const started = performance.now()
    const signal = input.signal
    assertActive(signal)
    if (
      input.prompt !== 'seed-region' ||
      !Number.isSafeInteger(input.image.width) ||
      !Number.isSafeInteger(input.image.height) ||
      input.image.width < 1 ||
      input.image.height < 1 ||
      input.image.width * input.image.height > objectProposalLimits.imagePixels ||
      input.image.data.length !== input.image.width * input.image.height * 4 ||
      input.image.format !== 'rgba8'
    )
      throw new ClassifierError(
        'INVALID_INPUT',
        'Semantic seed profile requires a bounded seed-region input',
      )
    const source = { ...input.image, data: new Uint8Array(input.image.data) }
    const roi = { ...input.roi },
      seed = { ...input.seedRegion }
    const target = input.target,
      exclusions = [...input.exclusions]
    const masks: BinaryMask[] = []
    const images: RasterImage[] = []
    try {
      // Even an empty mask checks geometry before invoking the caller-owned adapter.
      validateMask(
        {
          data: new Uint8Array(source.width * source.height),
          width: source.width,
          height: source.height,
          format: 'binary-u8',
        },
        source,
        roi,
        seed,
      )
      const batch = await options.proposals.propose({
        image: { ...source, data: new Uint8Array(source.data) },
        seedRegion: seed,
        roi,
        signal,
      })
      assertActive(signal)
      const metadata = nativeMetadata.parse(batch.metadata)
      if (
        metadata.input.width !== source.width ||
        metadata.input.height !== source.height ||
        batch.proposals.length !== 4
      )
        throw new ClassifierError(
          'INVALID_RESPONSE',
          'Semantic seed profile requires exactly four source masks',
        )
      for (const [index, candidate] of batch.proposals.entries()) {
        if (candidate.id !== `C0${index}`)
          throw new ClassifierError(
            'INVALID_RESPONSE',
            'Proposal aliases are not in stable input order',
          )
        const mask: BinaryMask = {
          data: unpackBinaryMask(candidate.mask),
          width: candidate.mask.width,
          height: candidate.mask.height,
          format: 'binary-u8',
        }
        masks.push(mask)
        validateMask(mask, source, roi, seed)
      }
      const encoder = sharp(source.data, {
        raw: { width: source.width, height: source.height, channels: 4 },
      })
      try {
        images.push({
          bytes: await encoder.png().toBuffer(),
          width: source.width,
          height: source.height,
        })
      } finally {
        encoder.destroy()
      }
      assertActive(signal)
      for (const [index, mask] of masks.entries())
        images.push(await renderSemanticMaskView(source, mask, labels[index]!, signal))
      const state: DecisionRequest['state'] = [
        semanticSeedPrompt.task,
        `Target: ${target}`,
        `Exclude: ${JSON.stringify(exclusions)}`,
      ]
      for (const [index, image] of images.entries()) {
        state.push(
          index === 0
            ? 'Original image:'
            : `Candidate ${labels[index - 1]}: label occupies added top margin of 42 pixels; source content below is unchanged apart from the mask overlay.`,
        )
        state.push(...(await raster.imageState(image, signal)))
      }
      const request: DecisionRequest = {
        state,
        questions: {
          selection: {
            type: 'choice',
            rankingSize: 1,
            instructions: semanticSeedPrompt.question,
            criteria: {
              A: 'Candidate A covers the entire visible target.',
              B: 'Candidate B covers the entire visible target.',
              C: 'Candidate C covers the entire visible target.',
              D: 'Candidate D covers the entire visible target.',
              none: 'No candidate covers the entire visible target.',
            },
          },
        },
      }
      assertActive(signal)
      const result = validateDecision(request, await options.decision.decide(request, signal))
      assertActive(signal)
      const chosen = selection(result, [...labels, 'none'], 1).choice
      const selectionMetadata = {
        backend: metadata.backend,
        input: { ...metadata.input },
        method: 'semantic-seed-mask-choice-v1',
        durationMs: performance.now() - started,
      }
      if (chosen === 'none')
        return {
          status: 'unknown',
          reason: 'no-complete-mask-candidate',
          metadata: selectionMetadata,
        }
      const selected = masks[labels.findIndex((label) => label === chosen)]
      if (!selected || !validateMask(selected, source, roi, seed))
        return {
          status: 'unknown',
          reason: 'selected-mask-misses-seed',
          metadata: selectionMetadata,
        }
      return {
        status: 'segmented',
        mask: { ...selected, data: new Uint8Array(selected.data) },
        metadata: selectionMetadata,
      }
    } finally {
      source.data.fill(0)
      masks.forEach((mask) => mask.data.fill(0))
      images.forEach((image) => image.bytes.fill(0))
    }
  }
  return {
    segment(input) {
      if (disposed)
        return Promise.reject(new ClassifierError('DISPOSED', 'Semantic seed wrapper is disposed'))
      const controller = new AbortController()
      const signal = AbortSignal.any([input.signal, controller.signal])
      const operation = segmentWork({ ...input, signal }).finally(() => {
        active.delete(operation)
        controller.abort()
      })
      active.set(operation, controller)
      return operation
    },
    async settle() {
      await Promise.allSettled([...active.keys()])
    },
    async dispose() {
      disposed = true
      for (const controller of active.values())
        controller.abort(new ClassifierError('DISPOSED', 'Semantic seed wrapper disposed'))
      await Promise.allSettled([...active.keys()])
    },
  }
}
