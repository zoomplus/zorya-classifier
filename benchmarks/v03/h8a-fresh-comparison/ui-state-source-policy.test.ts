import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeUiVisibleStateFingerprint,
  uiTargetOracleSchema,
  validateUiStateSourcePixelPolicy,
  type UiSourcePixelIdentity,
} from './ui-state-source-policy.js'
import { UI_STATE_DEV40_RUNTIME_PROOF_SHA256 } from './ui-state-dev40-policy.js'

function uiState(name: string, title = 'Application') {
  return {
    visibleNodes: [
      {
        index: 0,
        role: 'push button',
        name,
        states: ['showing', 'visible', 'enabled'],
        bounds: { x: 10, y: 20, width: 30, height: 12 },
      },
    ],
    windowStack: [{ title, geometry: { x: 0, y: 0, width: 1280, height: 1024, screen: 0 } }],
  }
}

function source(
  opaqueCaseId: string,
  overrides: Partial<UiSourcePixelIdentity> = {},
): UiSourcePixelIdentity {
  return {
    opaqueCaseId,
    stratum: 'ui',
    encodedSha256: opaqueCaseId.padStart(64, '0'),
    decodedRgbSha256: opaqueCaseId.padStart(64, '1'),
    perceptualHash64: '0000000000000000',
    visibleStateFingerprintSha256: computeUiVisibleStateFingerprint(uiState(opaqueCaseId)),
    ...overrides,
  }
}

await test('different visible UI states may share pHash zero', () => {
  assert.doesNotThrow(() => validateUiStateSourcePixelPolicy([source('one'), source('two')], []))
})

await test('same exact encoded pixels are rejected despite different UI state labels', () => {
  assert.throws(
    () =>
      validateUiStateSourcePixelPolicy(
        [
          source('one'),
          source('two', {
            encodedSha256: source('one').encodedSha256,
            visibleStateFingerprintSha256: computeUiVisibleStateFingerprint(uiState('Other')),
          }),
        ],
        [],
      ),
    /Exact encoded source duplicate/u,
  )
})

await test('same decoded RGB pixels are rejected even when the PNG encodings differ', () => {
  assert.throws(
    () =>
      validateUiStateSourcePixelPolicy(
        [source('one'), source('two', { decodedRgbSha256: source('one').decodedRgbSha256 })],
        [],
      ),
    /Exact decoded RGB source duplicate/u,
  )
})

await test('same visible state is rejected regardless of task or hidden metadata', () => {
  const shared = computeUiVisibleStateFingerprint(uiState('Search'))
  const first = { ...source('one'), visibleStateFingerprintSha256: shared }
  const second = {
    ...source('two'),
    visibleStateFingerprintSha256: computeUiVisibleStateFingerprint(uiState('Search')),
  }
  assert.throws(
    () => validateUiStateSourcePixelPolicy([first, second], []),
    /Duplicate native visible UI state/u,
  )
})

await test('photo and map pHash distance gate remains unchanged', () => {
  const photo = { ...source('photo'), stratum: 'photo' as const }
  const map = {
    ...source('map'),
    stratum: 'map' as const,
    perceptualHash64: '0000000000000004',
  }
  assert.throws(
    () => validateUiStateSourcePixelPolicy([photo, map], []),
    /unchanged pHash distance gate/u,
  )
})

await test('the checked runtime-file proof pin is a complete SHA-256 digest', () => {
  assert.equal(
    UI_STATE_DEV40_RUNTIME_PROOF_SHA256,
    '278015e2d7a9bbd7f308c865c01a9dc2277ec48d89d11852400940ef6e0ec389',
  )
  assert.match(UI_STATE_DEV40_RUNTIME_PROOF_SHA256, /^[a-f0-9]{64}$/u)
})

await test('a registered target may have an intentionally empty accessible name', () => {
  assert.deepEqual(
    uiTargetOracleSchema.parse({
      role: 'push button',
      name: '',
      expectedPresence: 'present',
      preMatchCount: 1,
      postMatchCount: 1,
      uniqueMatchBounds: { x: 120, y: 210, width: 32, height: 28 },
    }),
    {
      role: 'push button',
      name: '',
      expectedPresence: 'present',
      preMatchCount: 1,
      postMatchCount: 1,
      uniqueMatchBounds: { x: 120, y: 210, width: 32, height: 28 },
    },
  )
})
