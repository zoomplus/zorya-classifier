import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseSeedUnboundedPilotArgs } from '../benchmarks/v02/run-seed-unbounded-pilot.js'
import {
  seedUnboundedPolicy,
  seedUnboundedRoutes,
  seedUnboundedVariantHash,
} from '../benchmarks/v02/seedunboundedvariant.js'

await test('seed-unbounded route comparison freezes the same OpenAI account with adapter-specific endpoints', () => {
  assert.equal(seedUnboundedRoutes.length, 2)
  assert.deepEqual(
    seedUnboundedRoutes.map((route) => route.provider),
    ['openai', 'openai'],
  )
  assert.deepEqual(
    seedUnboundedRoutes.map((route) => route.providerName),
    ['OpenAI', 'OpenAI'],
  )
  assert.deepEqual(
    seedUnboundedRoutes.map((route) => route.model),
    ['openai/gpt-6-luna-decisions', 'openai/gpt-6-luna'],
  )
  assert.deepEqual(
    seedUnboundedRoutes.map((route) => route.apiEndpoint),
    ['/api/alpha/decisions', '/api/v1/chat/completions'],
  )
  assert.equal(seedUnboundedPolicy.promptId, 'seed-unbounded-v1')
  assert.equal(seedUnboundedPolicy.boxTolerancePx, 8)
  assert.equal(seedUnboundedPolicy.timeoutMs, 45000)
  assert.equal(seedUnboundedPolicy.retries, 0)
  assert.equal(seedUnboundedPolicy.allowFallbacks, false)
})

await test('seed-unbounded variant hash includes the complete source digest set', () => {
  const sourceHashes = { a: 'a'.repeat(64), b: 'b'.repeat(64) }
  assert.notEqual(
    seedUnboundedVariantHash(sourceHashes),
    seedUnboundedVariantHash({ ...sourceHashes, b: 'c'.repeat(64) }),
  )
  assert.throws(() => seedUnboundedVariantHash({ a: 'bad' }), /SHA-256/u)
})

await test('seed-unbounded CLI requires explicit paid intent and fixes case selection by code', () => {
  assert.throws(() => parseSeedUnboundedPilotArgs([]), /explicit --allow-paid/u)
  const options = parseSeedUnboundedPilotArgs([
    '--allow-paid',
    '--image-root',
    './corpus',
    '--out',
    './.run',
  ])
  assert.equal(options.imageRoot, resolve('./corpus'))
  assert.equal(options.outputRoot, resolve('./.run'))
  assert.throws(
    () => parseSeedUnboundedPilotArgs(['--allow-paid', '--case', 'photo-dev-03']),
    /Unknown option/u,
  )
})
