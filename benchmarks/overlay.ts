import sharp from 'sharp'
import { writeFile } from 'node:fs/promises'
import type { PixelRect } from '../src/index.js'
import type { PhotoTruth } from './corpus.js'

/** Evaluation-only rendering. This result must never be an input to a provider. */
export async function writeOverlay(
  image: Uint8Array,
  truth: PhotoTruth,
  predictions: readonly { label: 'one-stage' | 'two-stage' | 'three-stage'; region?: PixelRect }[],
  file: string,
): Promise<void> {
  const normalized = sharp(image, { limitInputPixels: 16_777_216 }).rotate()
  let data: Buffer, width: number, height: number
  try {
    const output = await normalized.png().toBuffer({ resolveWithObject: true })
    data = output.data
    width = output.info.width
    height = output.info.height
  } finally {
    normalized.destroy()
  }
  const boxes = truth.targetBoxes
    .map(
      ({ xyxy: [x0, y0, x1, y1] }) =>
        `<rect x="${x0 * width}" y="${y0 * height}" width="${(x1 - x0) * width}" height="${(y1 - y0) * height}" fill="none" stroke="#00ff70" stroke-width="3"/>`,
    )
    .join('')
  const colors = ['#ff3c74', '#00d9ff', '#ffcf00']
  const marks = predictions
    .map((prediction, index) => {
      const r = prediction.region
      if (!r) return ''
      const cx = r.left + r.width / 2,
        cy = r.top + r.height / 2
      return `<rect x="${r.left}" y="${r.top}" width="${r.width}" height="${r.height}" fill="none" stroke="${colors[index]}" stroke-width="2"/><path d="M${cx - 5},${cy}H${cx + 5}M${cx},${cy - 5}V${cy + 5}" stroke="${colors[index]}" stroke-width="3"/>`
    })
    .join('')
  const caption = `<rect width="${width}" height="24" fill="black" fill-opacity=".8"/><text x="5" y="17" font-family="sans-serif" font-size="12" fill="white">GT green; 1-stage pink; 2-stage cyan; 3-stage yellow; crosses = region centers</text>`
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${boxes}${marks}${caption}</svg>`,
  )
  const pipeline = sharp(data).composite([{ input: svg }])
  try {
    await writeFile(file, await pipeline.png().toBuffer(), { flag: 'wx' })
  } finally {
    pipeline.destroy()
  }
}
