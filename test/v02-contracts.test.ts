import assert from 'node:assert/strict'
import test from 'node:test'
import { classifySchema, locateSchema, representationSchema } from '../src/entities/contracts.js'
import { representationLimits } from '../src/entities/representation.js'
import { wholeObjectSchema } from '../src/entities/whole-object.js'
import { extractSchema } from '../src/entities/segmentation.js'

await test('whole-object defaults are explicit and region input remains separate', () => {
  const input = { image: new Uint8Array([1]), target: 'object' }
  assert.equal(locateSchema.parse(input).mode, undefined)
  assert.equal(locateSchema.safeParse({ ...input, mode: 'whole-object' }).success, false)
  const whole = wholeObjectSchema.parse({ ...input, mode: 'whole-object' })
  assert.equal(whole.boxTolerancePx, 8)
  assert.equal(whole.maxExtentPasses, 3)
  assert.equal(extractSchema.parse(input).mode, undefined)
  assert.equal(extractSchema.safeParse({ ...input, mode: 'region' }).success, false)
  for (const extra of [
    { maxExtentPasses: 4 },
    { maxExtentPasses: 0 },
    { boxTolerancePx: 0 },
    { boxTolerancePx: 65 },
    { boxTolerancePx: 1.5 },
    { invented: true },
  ])
    assert.equal(wholeObjectSchema.safeParse({ ...whole, ...extra }).success, false)
})

await test('representation selects a single versioned public profile with strict keys', () => {
  assert.equal(representationLimits.totalBytes, 65536)
  assert.equal(representationLimits.partCharacters, 64000)
  assert.equal(representationLimits.maxSide, 64)
  assert.equal(representationSchema.safeParse({ type: 'vision' }).success, true)
  assert.equal(
    representationSchema.safeParse({ type: 'experimental-text', profile: 'text-image-v1' }).success,
    true,
  )
  assert.equal(
    representationSchema.safeParse({ type: 'experimental-text', profile: 'pixel-rle-v1' }).success,
    false,
  )
  assert.equal(representationSchema.safeParse({ type: 'vision', model: 'hidden' }).success, false)
  assert.equal(
    classifySchema.safeParse({
      input: { image: new Uint8Array([1]) },
      classes: [
        { id: 'a', description: 'one' },
        { id: 'b', description: 'two' },
      ],
      representation: { type: 'vision' },
    }).success,
    true,
  )
})
