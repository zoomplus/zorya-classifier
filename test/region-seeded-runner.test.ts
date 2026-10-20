import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import {
  assertNoImagePartsAtFetch,
  regionSeededDevManifests,
  regionSeededNoImageProfile,
  regionSeededProfile,
  regionSeededProducerSourceManifest,
  regionSeededRecipe,
  removeImagesAtDecisionBoundary,
} from '../benchmarks/v02/region-seeded-runner.js'
import { parseRegionSeededArgs } from '../benchmarks/v02/run-region-seeded-dev.js'

await test('region-seeded and no-image controls are distinct named fixed recipes', () => {
  assert.equal(regionSeededProfile.id, 'native-luna-region-seeded-sam-dev-v1')
  assert.equal(regionSeededNoImageProfile.id, 'native-luna-region-no-image-control-dev-v1')
  assert.equal(regionSeededRecipe.model, 'openai/gpt-6-luna-decisions')
  assert.equal(regionSeededRecipe.provider, 'openai')
  assert.equal(regionSeededRecipe.regionSearchPasses, 3)
  assert.equal(regionSeededRecipe.extentCalls, 0)
  assert.equal(regionSeededRecipe.sameInstanceCalls, 0)
  assert.equal(regionSeededRecipe.maxPhysicalCallsPerCase, 4)
  assert.equal(regionSeededRecipe.maxPhysicalCalls, 250)
  assert.equal(regionSeededRecipe.maxCostUsd, 5)
  assert.equal(regionSeededRecipe.timeoutMs, 120_000)
  assert.equal(regionSeededRecipe.retries, 0)
  assert.equal(regionSeededRecipe.fallback, false)
  assert.deepEqual(
    regionSeededDevManifests.map((item) => item.sha256),
    [
      '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a',
      '6013a54bebba277f6457765cd8ef78e12e2dd5bab4453a752967233ebb429bfc',
      'b04ba6cac5b39c927281f61e4af7dcc7a5c5c2272a637aa9676ab3009fbd5d15',
    ],
  )
})

await test('no-image DecisionPort strips image parts while preserving text state and questions', async () => {
  const controller = new AbortController()
  let seen: DecisionRequest | undefined
  const result: DecisionResult = {
    answers: {},
    metadata: {
      model: 'fixture',
      provider: 'fixture',
      requestId: null,
      durationMs: 1,
      costUsd: 0,
      attempts: 1,
    },
  }
  const port: DecisionPort = {
    async decide(request, signal) {
      assert.equal(signal, controller.signal)
      seen = request
      return result
    },
  }
  const request: DecisionRequest = {
    state: [
      'geometry metadata',
      { type: 'image_url', image_url: { url: 'data:image/png;base64,PRIVATE', detail: 'high' } },
    ],
    questions: {
      locate: {
        type: 'choice',
        instructions: 'Select a region.',
        criteria: { C00: 'first', C01: 'second' },
      },
    },
  }
  assert.equal(
    await removeImagesAtDecisionBoundary(port).decide(request, controller.signal),
    result,
  )
  assert.deepEqual(seen?.state, ['geometry metadata'])
  assert.deepEqual(seen?.questions, request.questions)
})

await test('no-image fetch boundary verifies requests and rejects any image part', async () => {
  let forwarded = 0
  const audit = { checkedFetches: 0, imagePartFetches: 0 }
  const checked = assertNoImagePartsAtFetch(async () => {
    forwarded++
    return new Response('{}', { status: 200 })
  }, audit)
  await checked('https://fixture.invalid', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ content: 'geometry only' }] }),
  })
  assert.equal(forwarded, 1)
  assert.deepEqual(audit, { checkedFetches: 1, imagePartFetches: 0 })
  await assert.rejects(
    checked('https://fixture.invalid', {
      method: 'POST',
      body: JSON.stringify({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,secret' },
      }),
    }),
    /Image part reached no-image fetch boundary/u,
  )
  await assert.rejects(
    checked('https://fixture.invalid', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ content: 'data:image/png;base64,private' }] }),
    }),
    /Image part reached no-image fetch boundary/u,
  )
  assert.equal(forwarded, 1)
  assert.deepEqual(audit, { checkedFetches: 3, imagePartFetches: 2 })
})

await test('CLI defaults to the pinned complete exposed DEV candidate and requires one execution mode', () => {
  const parsed = parseRegionSeededArgs(['--dry-run'])
  assert.equal(parsed.phase, 'dev')
  assert.equal(parsed.variant, 'region-seeded-sam')
  assert.equal(parsed.profileId, regionSeededProfile.id)
  assert.equal(parsed.expectedCaseCount, 40)
  assert.equal(parsed.maxPhysicalCalls, 250)
  assert.equal(parsed.maxCostUsd, 5)
  assert.deepEqual(
    parsed.manifests.map((item) => item.sha256),
    regionSeededDevManifests.map((item) => item.sha256),
  )
  const control = parseRegionSeededArgs(['--dry-run', '--variant', 'no-image-control'])
  assert.equal(control.profileId, regionSeededNoImageProfile.id)
  assert.throws(
    () => parseRegionSeededArgs(['--dry-run', '--phase', 'heldout']),
    /HELDOUT requires --freeze/u,
  )
  assert.throws(
    () =>
      parseRegionSeededArgs(['--dry-run', '--phase', 'heldout', '--freeze', '/tmp/freeze.json']),
    /HELDOUT requires explicit --image-root/u,
  )
  assert.throws(() => parseRegionSeededArgs([]), /Choose exactly one/u)
  assert.throws(() => parseRegionSeededArgs(['--dry-run', '--allow-paid']), /Choose exactly one/u)
})

await test('source seal includes the new runner, CLI, no-image guard and policy document', async () => {
  const sources = await regionSeededProducerSourceManifest()
  for (const path of [
    './region-seeded-runner.ts',
    './run-region-seeded-dev.ts',
    './fresh-corpus.ts',
    './recording.ts',
    './budget.ts',
    './protocol.ts',
    './categorical-presence-port.ts',
    './native-categorical-presence-port.ts',
    './region-seeded-runner.md',
    '../../package.json',
    '../../package-lock.json',
    'src/app/create-classifier.ts',
    'src/processes/extract-from-region.ts',
  ])
    assert.ok(sources[path], `missing source pin ${path}`)
})
