import test from 'node:test'
import assert from 'node:assert/strict'
import {
  masksFromLogits,
  promptTensors,
  seedCenteredBox,
} from '../benchmarks/v03/segmentation-prompt-probe.js'

await test('seed-centered context box uses a fixed 3x factor and contains the original cell', () => {
  const box = seedCenteredBox({ left: 448, top: 256, width: 64, height: 57 }, 1024, 685)
  assert.deepEqual(box, { left: 384, top: 199, width: 192, height: 171 })
  assert.ok(box.left <= 448)
  assert.ok(box.top <= 256)
  assert.ok(box.left + box.width >= 512)
  assert.ok(box.top + box.height >= 313)
})

await test('seed-centered context box clips at the source edge without excluding seed pixels', () => {
  const box = seedCenteredBox({ left: 0, top: 0, width: 64, height: 57 }, 100, 100)
  assert.deepEqual(box, { left: 0, top: 0, width: 100, height: 100 })
})

await test('point-seed and seed-plus-box prompts preserve the fixed point and SAM box labels', () => {
  const seed = { left: 448, top: 256, width: 64, height: 57 }
  const point = promptTensors('point-seed', seed, 1024, 685)
  assert.deepEqual([...point.labels], [1, -1])
  assert.deepEqual([...point.coordinates], [479.5, 284, 479.5, 284])
  const box = promptTensors('seed-plus-box', seed, 1024, 685)
  assert.deepEqual([...box.labels], [1, 2, 3])
  assert.deepEqual([...box.coordinates], [479.5, 284, 384, 199, 576, 370])
  assert.deepEqual(box.box, { left: 384, top: 199, width: 192, height: 171 })
})

await test('all four masks remain present and diagnostic selection uses only seed-hit masks', () => {
  const width = 4
  const height = 2
  const pixels = width * height
  const rgba = new Uint8Array(pixels * 4).fill(255)
  const logits = new Float32Array(pixels * 4).fill(-1)
  const paint = (candidate: number, indexes: number[]) => {
    for (const index of indexes) logits[candidate * pixels + index] = 1
  }
  paint(0, [0, 1])
  paint(1, [4, 5])
  paint(2, [1, 2])
  paint(3, [3, 7])
  const result = masksFromLogits({
    rgba,
    logits,
    scores: Float32Array.of(0.99, 0.2, 0.8, 0.9),
    width,
    height,
    roi: { left: 0, top: 0, width, height },
    seed: { left: 0, top: 0, width: 2, height: 1 },
  })
  assert.equal(result.masks.length, 4)
  assert.deepEqual(result.hits, [true, false, true, false])
  assert.equal(result.nativeIndex, 0)
})
