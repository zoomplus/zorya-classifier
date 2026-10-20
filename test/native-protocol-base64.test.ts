import assert from 'node:assert/strict'
import test from 'node:test'

import {
  nativeObjectProposalReplySchema,
  nativeSegmentationRequestSchema,
} from '../src/infrastructure/segmentation/native-protocol.js'

const id = 'a0000000-0000-4000-8000-000000000001'
const options = {
  encoderPath: '/models/encoder.onnx',
  decoderPath: '/models/decoder.onnx',
  executionProvider: 'cpu' as const,
  threads: 1,
}

function zeroBytesBase64(byteLength: number): string {
  const encodedLength = Math.ceil(byteLength / 3) * 4
  const chars = 'A'.repeat(encodedLength)
  if (byteLength % 3 === 1) return `${chars.slice(0, -2)}==`
  if (byteLength % 3 === 2) return `${chars.slice(0, -1)}=`
  return chars
}

function mobileSamRequest(width: number, height: number, rgba: string) {
  return {
    id,
    kind: 'mobile-sam',
    width,
    height,
    rgba,
    seedRegion: { left: 0, top: 0, width: 1, height: 1 },
    wholeRegion: { left: 0, top: 0, width, height },
    roi: { left: 0, top: 0, width, height },
    options,
  }
}

await test('native request schema accepts full UI and map RGBA payloads', () => {
  const ui = mobileSamRequest(1280, 800, zeroBytesBase64(1280 * 800 * 4))
  assert.equal(ui.rgba.length, 5_461_336)
  assert.equal(nativeSegmentationRequestSchema.safeParse(ui).success, true)

  const map = mobileSamRequest(1920, 1080, zeroBytesBase64(1920 * 1080 * 4))
  assert.equal(map.rgba.length, 11_059_200)
  assert.equal(nativeSegmentationRequestSchema.safeParse(map).success, true)

  for (const source of [ui, map]) {
    const { wholeRegion: _wholeRegion, ...proposal } = source
    assert.equal(
      nativeSegmentationRequestSchema.safeParse({ ...proposal, kind: 'mobile-sam-proposals' })
        .success,
      true,
    )
    const { options: _options, ...grabCut } = source
    assert.equal(
      nativeSegmentationRequestSchema.safeParse({
        ...grabCut,
        kind: 'grabcut',
        assetPath: '/models/opencv.js',
      }).success,
      true,
    )
  }
})

await test('native base64 validation rejects malformed alphabet, padding and pad bits', () => {
  const malformed = ['!!!!', 'AAAA\n', 'A===', 'AA=A', 'AB==', 'AAB=']
  for (const rgba of malformed)
    assert.equal(
      nativeSegmentationRequestSchema.safeParse(mobileSamRequest(1, 1, rgba)).success,
      false,
      `accepted malformed base64 ${JSON.stringify(rgba)}`,
    )
})

await test('proposal reply schema accepts all 36 packed masks at 1280×800 size', () => {
  const mask = zeroBytesBase64(Math.ceil((1280 * 800) / 8))
  const reply = {
    id,
    status: 'proposals',
    width: 1280,
    height: 800,
    proposals: Array.from({ length: 36 }, (_, index) => ({
      id: `C${String(index).padStart(2, '0')}`,
      mask,
      qualityScore: 0.5,
    })),
  }
  assert.equal(mask.length, 170_668)
  assert.equal(nativeObjectProposalReplySchema.safeParse(reply).success, true)
})
