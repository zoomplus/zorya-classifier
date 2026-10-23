import sharp from 'sharp'
import type {
  DecisionState,
  ChoiceSelection,
  DecisionPort,
  DecisionResult,
  PixelRect,
  RasterPort,
} from '../../src/entities/contracts.js'
import type { RgbaRaster } from '../../src/entities/representation.js'
import { limits } from '../../src/entities/contracts.js'
import { assertActive, ClassifierError } from '../../src/entities/errors.js'
import { selection, validateDecision } from '../../src/features/choice.js'
import type { BinaryMask } from '../../src/entities/segmentation.js'

export const H3C_VERDICTS = [
  'match-complete-pure',
  'wrong-object-or-contaminated',
  'match-incomplete',
  'unknown',
] as const

export interface H3cVerificationInput {
  image: RgbaRaster
  mask: BinaryMask
  box: PixelRect
  alias: string
  target: string
  exclusions: readonly string[]
  signal: AbortSignal
}

export interface H3cVerificationResult {
  verdict: (typeof H3C_VERDICTS)[number]
  selection: ChoiceSelection
  metadata: DecisionResult['metadata']
  witness: { x: number; y: number; origin: 'selected-mask-foreground' }
}

interface H3cVerifierOptions {
  decision: DecisionPort
  imageState: RasterPort['imageState']
}

function foregroundBounds(mask: BinaryMask): PixelRect | undefined {
  let left = mask.width
  let top = mask.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const pixel = mask.data[y * mask.width + x]
      if (pixel !== 0 && pixel !== 1)
        throw new ClassifierError('INVALID_INPUT', 'H3c mask pixels must be binary')
      if (pixel === 0) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  return right < left ? undefined : { left, top, width: right - left + 1, height: bottom - top + 1 }
}

function sameRect(first: PixelRect, second: PixelRect): boolean {
  return (
    first.left === second.left &&
    first.top === second.top &&
    first.width === second.width &&
    first.height === second.height
  )
}

function cropAround(box: PixelRect, width: number, height: number): PixelRect {
  const paddingX = Math.max(16, Math.ceil(box.width * 0.5))
  const paddingY = Math.max(16, Math.ceil(box.height * 0.5))
  const left = Math.max(0, box.left - paddingX)
  const top = Math.max(0, box.top - paddingY)
  const right = Math.min(width, box.left + box.width + paddingX)
  const bottom = Math.min(height, box.top + box.height + paddingY)
  return { left, top, width: right - left, height: bottom - top }
}

function witnessOf(mask: BinaryMask): { x: number; y: number; origin: 'selected-mask-foreground' } {
  for (let y = 0; y < mask.height; y++)
    for (let x = 0; x < mask.width; x++)
      if (mask.data[y * mask.width + x] === 1) return { x, y, origin: 'selected-mask-foreground' }
  throw new ClassifierError('INVALID_INPUT', 'H3c selected mask has no foreground pixels')
}

function questionFor(target: string, exclusions: readonly string[]) {
  const identity = `The authored target is ${JSON.stringify(target)}; authored exclusions are ${JSON.stringify(exclusions)}.`
  return {
    type: 'choice' as const,
    rankingSize: 1 as const,
    instructions: `${identity} Judge the same visible instance represented by the selected candidate mask. Use the unmodified full source for scene identity and visible extent, the clean crop for context, the cyan overlay to inspect the exact foreground mask, and the neutral-background cutout to inspect the extracted pixels. Consider the full visible instance within the source image. Return only one supplied answer.`,
    criteria: {
      'match-complete-pure': `${identity} The visible selected instance is exactly the authored target, the selected mask isolates that instance without substantial unrelated pixels or other objects, and the mask-derived box contains the instance's whole visible extent.`,
      'wrong-object-or-contaminated': `${identity} The selected mask depicts a different object or instance, or includes substantial unrelated objects or background; this does not establish that the authored target is absent elsewhere.`,
      'match-incomplete': `${identity} The selected instance is the authored target, but visible target content is missing from the selected foreground mask or its mask-derived box.`,
      unknown: `${identity} The target identity, mask purity, completeness, or association between the mask and the same instance cannot be judged reliably.`,
    },
  }
}

function copyRaster(input: RgbaRaster): RgbaRaster {
  return {
    data: Uint8Array.from(input.data),
    width: input.width,
    height: input.height,
    format: 'rgba8',
  }
}

async function pngFromRgba(image: RgbaRaster, signal: AbortSignal): Promise<Buffer> {
  assertActive(signal)
  const pipeline = sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
    limitInputPixels: limits.imagePixels,
    failOn: 'error',
  }).png({ compressionLevel: 6 })
  try {
    const png = await pipeline.toBuffer()
    assertActive(signal)
    if (png.byteLength > limits.imageBytes)
      throw new ClassifierError('RESOURCE_LIMIT', 'H3c presentation image exceeds byte limit')
    return png
  } finally {
    pipeline.destroy()
  }
}

export function createH3cVerifier(options: H3cVerifierOptions) {
  if (
    !options ||
    typeof options.decision?.decide !== 'function' ||
    typeof options.imageState !== 'function'
  )
    throw new ClassifierError('INVALID_INPUT', 'H3c verifier requires caller-owned ports')

  return {
    async verify(value: H3cVerificationInput): Promise<H3cVerificationResult> {
      if (
        !value ||
        !value.image ||
        !(value.image.data instanceof Uint8Array) ||
        !value.mask ||
        !(value.mask.data instanceof Uint8Array) ||
        value.mask.format !== 'binary-u8' ||
        !(value.signal instanceof AbortSignal) ||
        typeof value.alias !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value.alias) ||
        !value.box ||
        ![value.box.left, value.box.top, value.box.width, value.box.height].every(
          Number.isSafeInteger,
        ) ||
        typeof value.target !== 'string' ||
        value.target.trim().length < 1 ||
        value.target.length > 2000 ||
        !Array.isArray(value.exclusions) ||
        value.exclusions.length > 16 ||
        value.exclusions.some(
          (entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 500,
        )
      )
        throw new ClassifierError('INVALID_INPUT', 'Invalid H3c verification input')
      const width = value.image.width
      const height = value.image.height
      const maskWidth = value.mask.width
      const maskHeight = value.mask.height
      const pixels = width * height
      if (
        value.image.format !== 'rgba8' ||
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 16384 ||
        height > 16384 ||
        !Number.isSafeInteger(pixels) ||
        pixels < 1 ||
        pixels > limits.imagePixels ||
        value.image.data.byteLength !== pixels * 4 ||
        !Number.isSafeInteger(maskWidth) ||
        !Number.isSafeInteger(maskHeight) ||
        maskWidth !== width ||
        maskHeight !== height ||
        value.mask.data.byteLength !== pixels
      )
        throw new ClassifierError('INVALID_INPUT', 'H3c image and mask dimensions disagree')
      const image = copyRaster({
        data: value.image.data,
        width,
        height,
        format: 'rgba8',
      })
      const mask: BinaryMask = {
        data: Uint8Array.from(value.mask.data),
        width: maskWidth,
        height: maskHeight,
        format: 'binary-u8',
      }
      const alias = value.alias
      const target = value.target
      const exclusions = [...value.exclusions]
      const box: PixelRect = {
        left: value.box.left,
        top: value.box.top,
        width: value.box.width,
        height: value.box.height,
      }
      const signal = value.signal
      let fullPng: Buffer | undefined
      let cleanPng: Buffer | undefined
      let overlayPng: Buffer | undefined
      let cutoutPng: Buffer | undefined
      const scratch: Buffer[] = []
      try {
        assertActive(signal)
        const bounds = foregroundBounds(mask)
        if (!bounds || !sameRect(bounds, box))
          throw new ClassifierError(
            'INVALID_INPUT',
            'H3c box must exactly match actual mask foreground',
          )
        const witness = witnessOf(mask)
        const crop = cropAround(bounds, image.width, image.height)
        fullPng = await pngFromRgba(image, signal)
        const cleanPipeline = sharp(image.data, {
          raw: { width: image.width, height: image.height, channels: 4 },
          limitInputPixels: limits.imagePixels,
          failOn: 'error',
        })
          .extract(crop)
          .png({ compressionLevel: 6 })
        try {
          cleanPng = await cleanPipeline.toBuffer()
        } finally {
          cleanPipeline.destroy()
        }
        assertActive(signal)

        const context = Buffer.from(image.data)
        scratch.push(context)
        const overlayPixels = Buffer.alloc(crop.width * crop.height * 4)
        scratch.push(overlayPixels)
        const cutoutPixels = Buffer.alloc(crop.width * crop.height * 4)
        scratch.push(cutoutPixels)
        const crossSvg = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width}" height="${crop.height}"><path d="M ${witness.x - crop.left - 5} ${witness.y - crop.top} H ${witness.x - crop.left + 5} M ${witness.x - crop.left} ${witness.y - crop.top - 5} V ${witness.y - crop.top + 5}" stroke="#ff00ff" stroke-width="2"/></svg>`,
        )
        scratch.push(crossSvg)
        for (let y = crop.top; y < crop.top + crop.height; y++) {
          for (let x = crop.left; x < crop.left + crop.width; x++) {
            const sourceIndex = (y * image.width + x) * 4
            const targetIndex = ((y - crop.top) * crop.width + x - crop.left) * 4
            if (mask.data[y * mask.width + x] === 1) {
              overlayPixels[targetIndex] = 0
              overlayPixels[targetIndex + 1] = 255
              overlayPixels[targetIndex + 2] = 255
              overlayPixels[targetIndex + 3] = 96
              cutoutPixels[targetIndex] = image.data[sourceIndex] ?? 0
              cutoutPixels[targetIndex + 1] = image.data[sourceIndex + 1] ?? 0
              cutoutPixels[targetIndex + 2] = image.data[sourceIndex + 2] ?? 0
              cutoutPixels[targetIndex + 3] = image.data[sourceIndex + 3] ?? 0
            } else {
              cutoutPixels[targetIndex] = 128
              cutoutPixels[targetIndex + 1] = 128
              cutoutPixels[targetIndex + 2] = 128
              cutoutPixels[targetIndex + 3] = 255
            }
          }
        }
        const cropRaw = await sharp(context, {
          raw: { width: image.width, height: image.height, channels: 4 },
          limitInputPixels: limits.imagePixels,
        })
          .extract(crop)
          .raw()
          .toBuffer()
        scratch.push(cropRaw)
        assertActive(signal)
        const overlayComposed = await sharp(cropRaw, {
          raw: { width: crop.width, height: crop.height, channels: 4 },
        })
          .composite([
            { input: overlayPixels, raw: { width: crop.width, height: crop.height, channels: 4 } },
            { input: crossSvg },
          ])
          .png({ compressionLevel: 6 })
          .toBuffer()
        overlayPng = overlayComposed
        cutoutPng = await sharp(cutoutPixels, {
          raw: { width: crop.width, height: crop.height, channels: 4 },
        })
          .png({ compressionLevel: 6 })
          .toBuffer()
        assertActive(signal)
        if (
          [fullPng, cleanPng, overlayPng, cutoutPng].some(
            (part) => part.byteLength > limits.imageBytes,
          )
        )
          throw new ClassifierError('RESOURCE_LIMIT', 'H3c presentation exceeds image byte limits')
        const states: DecisionState[] = []
        for (const [index, bytes] of [fullPng, cleanPng, overlayPng, cutoutPng].entries()) {
          const dimensions = index === 0 ? { width: image.width, height: image.height } : crop
          states.push(
            await options.imageState({ bytes: Uint8Array.from(bytes), ...dimensions }, signal),
          )
          assertActive(signal)
        }
        assertActive(signal)
        const state = [
          `Authored target (JSON string): ${JSON.stringify(target)}. Authored exclusions (JSON strings): ${JSON.stringify(exclusions)}.`,
          `Selected candidate: ${alias}. The box is derived from the selected mask's actual foreground pixels: ${JSON.stringify(bounds)}. Deterministic witness from selected-mask foreground: ${JSON.stringify(witness)}.`,
          'Unmodified full source:',
          ...states[0]!,
          'Clean context crop around the selected mask-derived box:',
          ...states[1]!,
          'Exact selected-mask overlay in cyan; the magenta cross is a deterministic selected-mask foreground witness:',
          ...states[2]!,
          'Exact selected-mask cutout over neutral gray:',
          ...states[3]!,
        ]
        assertActive(signal)
        const request = {
          state,
          questions: { verification: questionFor(target, exclusions) },
        }
        const raw = await options.decision.decide(request, signal)
        assertActive(signal)
        const checked = validateDecision(request, raw)
        const chosen = selection(checked, H3C_VERDICTS, 1, 'verification')
        return {
          verdict: chosen.choice as H3cVerificationResult['verdict'],
          selection: chosen,
          metadata: { ...checked.metadata },
          witness,
        }
      } finally {
        image.data.fill(0)
        mask.data.fill(0)
        fullPng?.fill(0)
        cleanPng?.fill(0)
        overlayPng?.fill(0)
        cutoutPng?.fill(0)
        for (const bytes of scratch) bytes.fill(0)
      }
    },
  }
}
