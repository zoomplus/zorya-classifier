import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  presentationVariantHash,
  presentationVariants,
} from '../benchmarks/v02/presentationvariants.js'
import { parsePresentationPilotArgs } from '../benchmarks/v02/run-presentation-pilot.js'
import { safeErrorCode } from '../benchmarks/v02/presentationpilot.js'

await test('presentation comparison variants freeze the same model route, tolerance, deadlines, and no-retry policy', () => {
  const numeric = presentationVariants['numeric-v1']
  const rulers = presentationVariants['axis-rulers-v1']
  assert.deepEqual(numeric.route, rulers.route)
  assert.equal(numeric.boxTolerancePx, 8)
  assert.equal(rulers.boxTolerancePx, 8)
  assert.equal(numeric.timeoutMs, 45000)
  assert.equal(rulers.timeoutMs, 45000)
  assert.equal(numeric.maxExtentPasses, rulers.maxExtentPasses)
  assert.equal(numeric.retries, 0)
  assert.equal(rulers.retries, 0)
  assert.equal(numeric.route.allowFallbacks, false)
  assert.equal(rulers.route.allowFallbacks, false)
  assert.notEqual(numeric.boundaryPresentation, rulers.boundaryPresentation)
})

await test('presentation hash freezes renderer source only for the axis-rulers variant', () => {
  const rendererA = 'a'.repeat(64)
  const rendererB = 'b'.repeat(64)
  assert.notEqual(
    presentationVariantHash('axis-rulers-v1', rendererA),
    presentationVariantHash('axis-rulers-v1', rendererB),
  )
  assert.throws(() => presentationVariantHash('axis-rulers-v1'))
  assert.throws(() => presentationVariantHash('numeric-v1', rendererA))
  assert.equal(presentationVariantHash('numeric-v1'), presentationVariantHash('numeric-v1'))
})

await test('paired pilot CLI requires explicit paid-run intent and rejects variant selection', () => {
  assert.throws(() => parsePresentationPilotArgs([]), /explicit --allow-paid/u)
  const parsed = parsePresentationPilotArgs([
    '--allow-paid',
    '--image-root',
    './dev-fixture',
    '--out',
    './.run/pilot',
  ])
  assert.equal(parsed.imageRoot.endsWith('/dev-fixture'), true)
  assert.equal(parsed.outputRoot.endsWith('/.run/pilot'), true)
  assert.throws(
    () => parsePresentationPilotArgs(['--allow-paid', '--variant', 'numeric-v1']),
    /Unknown option/u,
  )
})

await test('pilot error summaries preserve known provider failures and redact unknown codes', () => {
  assert.equal(safeErrorCode({ code: 'PROVIDER' }), 'PROVIDER')
  assert.equal(safeErrorCode({ code: 'AUTHENTICATION' }), 'AUTHENTICATION')
  assert.equal(safeErrorCode({ code: 'secret-token-value' }), 'RUNNER_FAILURE')
})
