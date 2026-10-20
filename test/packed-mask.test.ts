import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ClassifierError } from '../src/entities/errors.js'
import { packBinaryMask, unpackBinaryMask } from '../src/features/segmentation/packed-mask.js'

await test('packed masks use row-major LSB-first bytes and round trip', () => {
  const source = Uint8Array.of(1, 0, 1, 1, 0, 0, 0, 1, 1)
  const packed = packBinaryMask(source, 3, 3)
  assert.deepEqual([...packed.data], [0b10001101, 0b00000001])
  source.fill(0)
  assert.deepEqual([...unpackBinaryMask(packed)], [1, 0, 1, 1, 0, 0, 0, 1, 1])
})

await test('packed mask validation rejects malformed dimensions, values and padding', () => {
  assert.throws(() => packBinaryMask(Uint8Array.of(0), 2, 1), /dimensions/)
  assert.throws(() => packBinaryMask(Uint8Array.of(2), 1, 1), /zero or one/)
  assert.throws(
    () =>
      unpackBinaryMask({
        data: Uint8Array.of(0b10000001),
        width: 1,
        height: 1,
        format: 'binary-lsb0',
      }),
    /padding/,
  )
  assert.throws(
    () => unpackBinaryMask({ data: Uint8Array.of(0), width: 9, height: 1, format: 'binary-lsb0' }),
    /length/,
  )
  assert.throws(
    () => packBinaryMask(new Uint8Array(2_097_153), 2_097_153, 1),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
  )
})
