import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import type { DecisionRequest, ImagePart } from '../src/entities/contracts.js'
import { prepareJpegTransportRequest } from '../benchmarks/experiments/jpeg-transport-v1.js'

function part(bytes: Uint8Array): ImagePart {
  return {
    type: 'image_url',
    image_url: {
      url: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
      detail: 'high',
    },
  }
}
function request(state: DecisionRequest['state']): DecisionRequest {
  return {
    state,
    questions: {
      selection: {
        type: 'choice',
        criteria: { A: 'A', B: 'B' },
        instructions: 'Choose one ID.',
        rankingSize: 1,
      },
    },
  }
}
const signal = new AbortController().signal

await test('opaque transport experiment reduces a varied raster without changing geometry or questions', async () => {
  const width = 256
  const height = 180
  let seed = 0x5a4f5259
  const pixels = Buffer.from(
    Uint8Array.from({ length: width * height * 3 }, () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return seed & 255
    }),
  )
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer()
  const original = request(['context', part(png), '{"sourceImageTransform":{"scaleX":1}}'])
  const saved = structuredClone(original)
  const prepared = await prepareJpegTransportRequest(original, signal)
  assert.deepEqual(original, saved)
  assert.deepEqual(prepared.request.questions, original.questions)
  assert.equal(prepared.request.state[0], original.state[0])
  assert.equal(prepared.request.state[2], original.state[2])
  const image = prepared.request.state[1]
  assert.ok(typeof image !== 'string' && image?.type === 'image_url')
  assert.equal(image.image_url.url.startsWith('data:image/jpeg;base64,'), true)
  const encoded = Buffer.from(image.image_url.url.split(',')[1]!, 'base64')
  const metadata = await sharp(encoded).metadata()
  assert.deepEqual([metadata.width, metadata.height], [width, height])
  assert.ok(encoded.byteLength < png.byteLength)
  assert.deepEqual(prepared.images[0], {
    stateIndex: 1,
    width,
    height,
    inputBytes: png.byteLength,
    outputBytes: encoded.byteLength,
    outputFormat: 'jpeg',
    reason: 'smaller-opaque-jpeg',
  })
})

await test('transparent images and smaller lossless images remain byte-identical PNGs', async () => {
  const transparent = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 100, g: 200, b: 20, alpha: 0.4 },
    },
  })
    .png()
    .toBuffer()
  const flat = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  const source = request([part(transparent), part(flat)])
  const prepared = await prepareJpegTransportRequest(source, signal)
  assert.deepEqual(prepared.request, source)
  assert.deepEqual(
    prepared.images.map((value) => value.reason),
    ['transparent-png', 'smaller-lossless-png'],
  )
})

await test('text-only requests stay image-free and pre-cancelled or invalid images stop before dispatch', async () => {
  const text = request(['pixels encoded as text'])
  assert.deepEqual((await prepareJpegTransportRequest(text, signal)).request, text)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(prepareJpegTransportRequest(text, controller.signal), { code: 'ABORTED' })
  await assert.rejects(prepareJpegTransportRequest(request([part(Uint8Array.of(1))]), signal), {
    code: 'INVALID_INPUT',
  })
  await assert.rejects(
    prepareJpegTransportRequest(
      request(Array.from({ length: 10 }, () => part(Uint8Array.of(1)))),
      signal,
    ),
    { code: 'RESOURCE_LIMIT' },
  )
  const remote: ImagePart = {
    type: 'image_url',
    image_url: { url: 'https://invalid.example/p.png', detail: 'high' },
  }
  await assert.rejects(prepareJpegTransportRequest(request([remote]), signal), {
    code: 'INVALID_INPUT',
  })
})

await test('transport preparation snapshots caller-owned state before decoding', async () => {
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#abcdef' } })
    .png()
    .toBuffer()
  const source = request([part(png)])
  const saved = structuredClone(source)
  const pending = prepareJpegTransportRequest(source, signal)
  source.state.length = 0
  source.questions.selection = {
    type: 'choice',
    criteria: { changed: 'Changed' },
    instructions: 'Choose one ID.',
  }
  const prepared = await pending
  assert.deepEqual(prepared.request, saved)
})
