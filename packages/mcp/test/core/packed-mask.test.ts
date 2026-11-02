import assert from 'node:assert/strict'
import test from 'node:test'

import { packMaskBytes } from '../../src/core/packed-mask.js'
import { McpCoreError } from '../../src/errors.js'

await test('packed mask uses row-major LSB-first bits and exact dimensions', () => {
  assert.deepEqual(
    packMaskBytes(Uint8Array.of(1, 0, 1, 0, 1, 0, 1, 0, 1), 3, 3),
    Uint8Array.of(85, 1),
  )
  assert.throws(
    () => packMaskBytes(Uint8Array.of(1, 2), 2, 1),
    (error: unknown) => error instanceof McpCoreError && error.code === 'ARTIFACT_UNAVAILABLE',
  )
  assert.throws(
    () => packMaskBytes(Uint8Array.of(1), 2, 1),
    (error: unknown) => error instanceof McpCoreError && error.code === 'ARTIFACT_UNAVAILABLE',
  )
})
