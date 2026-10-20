import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'

import type { PixelRect } from '../src/entities/contracts.js'
import type { PresentedObjectProposal } from '../src/entities/object-proposals.js'
import type { RgbaRaster } from '../src/entities/representation.js'
import { createSharpObjectProposalPresentation } from '../src/infrastructure/segmentation/proposal-presentation.js'

const presenter = createSharpObjectProposalPresentation()

function image(width = 12, height = 12): RgbaRaster {
  const data = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index++) {
    data[index * 4] = 30 + (index % 100)
    data[index * 4 + 1] = 70
    data[index * 4 + 2] = 110
    data[index * 4 + 3] = 255
  }
  return { data, width, height, format: 'rgba8' }
}

function proposalSet(width: number, height: number): PresentedObjectProposal[] {
  const all: PresentedObjectProposal[] = []
  for (let index = 0; index < 36; index++) {
    const data = new Uint8Array(Math.ceil((width * height) / 8))
    const x = index % width
    const y = Math.floor(index / width) % height
    const isEmpty = index === 1
    if (!isEmpty) {
      const offset = y * width + x
      data[offset >>> 3] = data[offset >>> 3]! | (1 << (offset & 7))
    }
    all.push({
      id: `C${index.toString(10).padStart(2, '0')}`,
      mask: { data, width, height, format: 'binary-lsb0' },
      region: isEmpty ? null : { left: x, top: y, width: 1, height: 1 },
      ...(index === 0 ? { qualityScore: 0.987654 } : {}),
    })
  }
  return all
}

async function raw(bytes: Uint8Array) {
  return sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
}

function pixel(buffer: Uint8Array, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4
  return [...buffer.subarray(offset, offset + 4)]
}

async function hasNear(
  bytes: Uint8Array,
  centerX: number,
  centerY: number,
  predicate: (pixel: number[]) => boolean,
): Promise<boolean> {
  const decoded = await raw(bytes)
  for (let y = Math.max(0, centerY - 2); y <= Math.min(decoded.info.height - 1, centerY + 2); y++)
    for (let x = Math.max(0, centerX - 2); x <= Math.min(decoded.info.width - 1, centerX + 2); x++)
      if (predicate(pixel(decoded.data, decoded.info.width, x, y))) return true
  return false
}

const rect: PixelRect = { left: 2, top: 2, width: 3, height: 3 }

await test('renders a seed witness plus all 36 stable aliases and exact foreground rectangles', async () => {
  const source = image()
  const proposals = proposalSet(source.width, source.height)
  const output = await presenter.render({
    image: source,
    seedRegion: rect,
    proposals,
    signal: new AbortController().signal,
  })
  assert.equal(output.length, 4)
  assert.ok(output.every((part) => part.byteLength > 0))
  assert.ok(output.reduce((sum, part) => sum + part.byteLength, 0) <= 16 * 1024 * 1024)

  const seed = await raw(output[0]!)
  assert.deepEqual([seed.info.width, seed.info.height, seed.info.channels], [12, 12, 4])
  assert.ok(await hasNear(output[0]!, 2, 2, (p) => p[2]! > p[0]! * 1.3 && p[2]! > p[1]!))

  for (const sheet of output.slice(1)) {
    const decoded = await raw(sheet)
    assert.deepEqual(
      [decoded.info.width, decoded.info.height, decoded.info.channels],
      [1200, 720, 4],
    )
  }
  // C00's one-pixel support/bounds are visible in the first left preview at the scaled coordinate.
  const rectangleYellow = (p: number[]) => p[0]! > 170 && p[1]! > 150 && p[2]! < 80
  assert.ok(
    await hasNear(
      output[1]!,
      4 + Math.round((0.5 * 142) / 12),
      69 + Math.round((0.5 * 142) / 12),
      rectangleYellow,
    ),
  )
  // C35 occupies the final tile of the third sheet; its alias cannot reorder or omit the proposal.
  assert.ok(
    await hasNear(
      output[3]!,
      3 * 300 + 4 + Math.round((11.5 * 142) / 12),
      2 * 240 + 69 + Math.round((2.5 * 142) / 12),
      rectangleYellow,
    ),
  )
  // Empty C01 is accepted and has no mask-derived region; the optional native score is not exposed.
  const third = await raw(output[1]!)
  assert.notEqual(pixel(third.data, third.info.width, 300 + 8, 8)[3], 0)
  assert.equal(JSON.stringify(output).includes('0.987654'), false)
})

await test('accepts a partial proposal batch and does not invent aliases for unused cells', async () => {
  const source = image()
  const proposal = proposalSet(source.width, source.height)[0]!
  // A nonempty mask may fail the seed-overlap filter upstream; the presenter still shows its pixels.
  proposal.region = null
  const output = await presenter.render({
    image: source,
    seedRegion: rect,
    proposals: [proposal],
    signal: new AbortController().signal,
  })
  assert.equal(output.length, 2)
  const sheet = await raw(output[1]!)
  assert.deepEqual([sheet.info.width, sheet.info.height, sheet.info.channels], [12, 12, 4])
})

await test('renders an ordered singleton subset as a source-sized mask overlay with exact bounds', async () => {
  const source = image()
  const proposal = proposalSet(source.width, source.height)[17]!
  const output = await presenter.render({
    image: source,
    seedRegion: rect,
    proposals: [proposal],
    signal: new AbortController().signal,
  })
  assert.equal(output.length, 2)
  const overlay = await raw(output[1]!)
  assert.deepEqual([overlay.info.width, overlay.info.height], [source.width, source.height])
  assert.deepEqual(pixel(overlay.data, overlay.info.width, 5, 1), [255, 220, 0, 255])
  assert.deepEqual(
    pixel(overlay.data, overlay.info.width, 0, 0),
    pixel(source.data, source.width, 0, 0),
  )
})

await test('snapshots caller-owned source and packed masks before asynchronous encoding', async () => {
  const source = image()
  const originalSourcePixel = [...source.data.subarray(0, 4)]
  const proposals = proposalSet(source.width, source.height)
  const originalMask = new Uint8Array(proposals[0]!.mask.data)
  const seedRegion = { ...rect }
  const rendering = presenter.render({
    image: source,
    seedRegion,
    proposals,
    signal: new AbortController().signal,
  })
  source.data.fill(0)
  source.width = 6
  source.height = 24
  seedRegion.left = 8
  seedRegion.top = 8
  proposals[0]!.region = { left: 8, top: 8, width: 1, height: 1 }
  proposals[0]!.mask.data.fill(0)
  const output = await rendering
  const decoded = await raw(output[0]!)
  assert.deepEqual([decoded.info.width, decoded.info.height], [12, 12])
  assert.deepEqual(pixel(decoded.data, decoded.info.width, 0, 0), originalSourcePixel)
  const witness = pixel(decoded.data, decoded.info.width, 2, 2)
  assert.ok(witness[2]! > witness[0]! && witness[2]! > witness[1]!)
  assert.deepEqual([...proposals[0]!.mask.data], new Array(originalMask.length).fill(0))
})

await test('cutouts preserve source alpha, crop to exact packed-mask support, and retain edges', async () => {
  const source = image()
  const alphaPixel = (5 * source.width + 7) * 4 + 3
  source.data[alphaPixel] = 79
  const proposals = proposalSet(source.width, source.height)
  const picked = proposals[0]!
  picked.mask.data.fill(0)
  const selectedIndex = 5 * source.width + 7
  picked.mask.data[selectedIndex >>> 3] = 1 << (selectedIndex & 7)
  picked.region = { left: 7, top: 5, width: 1, height: 1 }
  const output = await presenter.render({
    image: source,
    seedRegion: { left: 7, top: 5, width: 1, height: 1 },
    proposals,
    signal: new AbortController().signal,
  })
  const sheet = await raw(output[1]!)
  // Right preview center in tile C00; crop-to-mask turns this into one source pixel.
  const cutout = pixel(sheet.data, sheet.info.width, 4 + 142 + 8 + 71, 28 + 100)
  assert.equal(cutout[3], 79)
  assert.deepEqual([...source.data.subarray(alphaPixel, alphaPixel + 1)], [79])
})

await test('rejects invalid aliases, inconsistent pixel bounds, malformed tails, and invalid images', async () => {
  const source = image()
  const proposals = proposalSet(source.width, source.height)
  const input = {
    image: source,
    seedRegion: rect,
    proposals,
    signal: new AbortController().signal,
  }
  proposals[0]!.id = 'target-button'
  await assert.rejects(presenter.render(input), { code: 'INVALID_RESPONSE' })
  proposals[0]!.id = 'C00'
  proposals[0]!.region = { left: 1, top: 0, width: 1, height: 1 }
  await assert.rejects(presenter.render(input), /does not match packed mask support/)
  proposals[0]!.region = { left: 0, top: 0, width: 1, height: 1 }

  const nonByteAligned = proposalSet(5, 5)
  nonByteAligned[0]!.mask.data[3] = 0x80
  await assert.rejects(
    presenter.render({
      image: image(5, 5),
      seedRegion: { left: 0, top: 0, width: 1, height: 1 },
      proposals: nonByteAligned,
      signal: new AbortController().signal,
    }),
    /padding bits/,
  )
  await assert.rejects(
    presenter.render({
      ...input,
      image: { ...source, data: source.data.subarray(0, source.data.length - 1) },
    }),
    /canonical RGBA/,
  )
})

await test('rejects duplicate and out-of-order aliases in a presentation subset', async () => {
  const source = image()
  const proposals = proposalSet(source.width, source.height)
  await assert.rejects(
    presenter.render({
      image: source,
      seedRegion: rect,
      proposals: [proposals[3]!, proposals[3]!],
      signal: new AbortController().signal,
    }),
    /unique and retain source order/,
  )
  await assert.rejects(
    presenter.render({
      image: source,
      seedRegion: rect,
      proposals: [proposals[17]!, proposals[4]!],
      signal: new AbortController().signal,
    }),
    /unique and retain source order/,
  )
})

await test('rejects an already aborted signal and stops after abort during encoding', async () => {
  const proposals = proposalSet(12, 12)
  const first = new AbortController()
  first.abort()
  await assert.rejects(
    presenter.render({ image: image(), seedRegion: rect, proposals, signal: first.signal }),
  )
  const active = new AbortController()
  const rendering = presenter.render({
    image: image(),
    seedRegion: rect,
    proposals,
    signal: active.signal,
  })
  active.abort()
  await assert.rejects(rendering)
})
