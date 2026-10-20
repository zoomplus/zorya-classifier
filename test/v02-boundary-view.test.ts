import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import type { RasterImage } from '../src/entities/contracts.js'
import { ClassifierError } from '../src/entities/errors.js'
import { createSharpBoundaryView } from '../src/infrastructure/boundary-view.js'

const active = new AbortController().signal

async function raster(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly number[],
): Promise<RasterImage> {
  const bytes = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = pixel(x, y)
      bytes.set(color, (y * width + x) * 4)
    }
  }
  return {
    bytes: await sharp(bytes, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer(),
    width,
    height,
  }
}

async function rgba(image: RasterImage): Promise<Buffer> {
  const result = await sharp(image.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.equal(result.info.width, image.width)
  assert.equal(result.info.height, image.height)
  assert.equal(result.info.channels, 4)
  return result.data
}

function pixel(data: Buffer, width: number, x: number, y: number): number[] {
  return [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]
}

await test('axis bands map narrow source-coordinate intervals through an offset ROI', async () => {
  const source = await raster(160, 90, (x, y) => [x, y, 77, 255])
  const view = await createSharpBoundaryView().render({
    source,
    sourceRegion: { left: 20, top: 11, width: 100, height: 50 },
    axis: 'left',
    candidates: [
      { id: 'left00', display: 'L0', interval: { start: 25, endExclusive: 26 } },
      { id: 'left01', display: 'L1', interval: { start: 80, endExclusive: 81 } },
    ],
    signal: active,
  })
  const data = await rgba(view.image)
  assert.deepEqual(view.sourceRegion, { left: 20, top: 11, width: 100, height: 50 })
  assert.deepEqual(view.content, { left: 10, top: 210, width: 1280, height: 640 })
  assert.equal(view.scaleX, 12.8)
  assert.equal(view.scaleY, 12.8)
  assert.deepEqual(
    view.candidates.map(({ id, display }) => [id, display]),
    [
      ['left00', 'L0'],
      ['left01', 'L1'],
    ],
  )
  // Scaled half-open interval boundaries use the ROI offset and declared content scale.
  for (const x of [74, 87, 778, 791]) {
    const marker = pixel(data, view.image.width, x, 500)
    assert.ok(marker[0]! > marker[1]! && marker[0]! > 120, `expected X marker at output x=${x}`)
  }
  // A nearest-neighbor output sample maps to source (22, 14), not a full-image/recentered crop.
  assert.deepEqual(pixel(data, view.image.width, 42, 254), [22, 14, 77, 255])
})

await test('content preserves crop aspect ratio while the rendered image remains within side limits', async () => {
  const source = await raster(3200, 1800, () => [30, 80, 120, 255])
  const view = await createSharpBoundaryView().render({
    source,
    sourceRegion: { left: 50, top: 100, width: 2400, height: 1200 },
    axis: 'bottom',
    candidates: [{ id: 'bottom00', display: 'B0', interval: { start: 800, endExclusive: 801 } }],
    signal: active,
  })
  assert.equal(view.content.width / view.content.height, 2)
  assert.ok(view.image.width >= 280 && view.image.height >= 280)
  assert.ok(view.image.width < 1568 && view.image.height < 1568)
  assert.equal(view.scaleX, view.content.width / 2400)
  assert.equal(view.scaleY, view.content.height / 1200)
})

await test('transparent source pixels remain transparent under clean content pixels', async () => {
  const source = await raster(40, 30, () => [90, 80, 70, 0])
  const view = await createSharpBoundaryView().render({
    source,
    sourceRegion: { left: 5, top: 4, width: 20, height: 12 },
    axis: 'top',
    candidates: [{ id: 'top00', display: 'T0', interval: { start: 8, endExclusive: 10 } }],
    signal: active,
  })
  const data = await rgba(view.image)
  assert.equal(pixel(data, view.image.width, view.content.left + 1, view.content.top + 1)[3], 0)
  assert.equal(pixel(data, view.image.width, 0, 0)[3], 255)
})

await test('rejects invalid intervals and already-aborted rendering before raster work', async () => {
  const source = await raster(10, 10, () => [0, 0, 0, 255])
  await assert.rejects(
    createSharpBoundaryView().render({
      source,
      sourceRegion: { left: 0, top: 0, width: 10, height: 10 },
      axis: 'left',
      candidates: [{ id: 'left00', display: 'L0', interval: { start: 4, endExclusive: 4 } }],
      signal: active,
    }),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
  )
  const stopped = new AbortController()
  stopped.abort()
  await assert.rejects(
    createSharpBoundaryView().render({
      source,
      sourceRegion: { left: 0, top: 0, width: 10, height: 10 },
      axis: 'left',
      candidates: [{ id: 'left00', display: 'L0', interval: { start: 2, endExclusive: 3 } }],
      signal: stopped.signal,
    }),
    (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
  )
  await assert.rejects(
    createSharpBoundaryView().render({
      source,
      sourceRegion: { left: 0, top: 0, width: 10, height: 10 },
      axis: 'left',
      candidates: [{ id: 'left00', display: 'L0', interval: { start: 2, endExclusive: 3 } }],
      signal: { aborted: false } as AbortSignal,
    }),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
  )
})

await test('X render is byte-identical for left and right IDs while preserving per-question mappings', async () => {
  const source = await raster(80, 40, (x, y) => [x * 2, y * 3, 50, 255])
  const port = createSharpBoundaryView()
  const shared = {
    source,
    sourceRegion: { left: 10, top: 4, width: 50, height: 25 },
    candidates: [
      { display: 'X0', interval: { start: 14, endExclusive: 15 } },
      { display: 'X1', interval: { start: 24, endExclusive: 25 } },
    ],
    signal: active,
  }
  const left = await port.render({
    ...shared,
    axis: 'left',
    candidates: shared.candidates.map((candidate, index) => ({
      ...candidate,
      id: `left0${index}`,
    })),
  })
  const right = await port.render({
    ...shared,
    axis: 'right',
    candidates: shared.candidates.map((candidate, index) => ({
      ...candidate,
      id: `right0${index}`,
    })),
  })
  assert.deepEqual(left.image.bytes, right.image.bytes)
  assert.deepEqual(
    left.candidates.map(({ id }) => id),
    ['left00', 'left01'],
  )
  assert.deepEqual(
    right.candidates.map(({ id }) => id),
    ['right00', 'right01'],
  )
})

await test('rejects unordered or overlapping source intervals without reordering them', async () => {
  const source = await raster(40, 30, () => [0, 0, 0, 255])
  await assert.rejects(
    createSharpBoundaryView().render({
      source,
      sourceRegion: { left: 0, top: 0, width: 40, height: 30 },
      axis: 'left',
      candidates: [
        { id: 'left00', display: 'X0', interval: { start: 20, endExclusive: 22 } },
        { id: 'left01', display: 'X1', interval: { start: 10, endExclusive: 11 } },
      ],
      signal: active,
    }),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
  )
})
