import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import type {
  ClassificationResult,
  DecisionPort,
  DecisionRequest,
  DecisionResult,
} from '../src/entities/contracts.js'
import type { Classifier, ClassifierOptions } from '../src/app/create-classifier.js'
import type { FreshCase } from '../benchmarks/v02/fresh-corpus.js'
import type { SegmentationPort } from '../src/entities/segmentation.js'
import {
  assertRecorderHealthy,
  assertNoImagePartsAtFetch,
  regionSeededDevManifests,
  regionSeededNoImageProfile,
  regionSeededProfile,
  regionPresenceFirstNoImageProfile,
  regionPresenceFirstProfile,
  regionPresenceFirstHeldoutProfile,
  regionPresenceFirstNoImageHeldoutProfile,
  regionPresenceFirstCheckedProfile,
  regionPresenceFirstCheckedNoImageProfile,
  regionPresenceFirstCheckedHeldoutProfile,
  regionPresenceFirstCheckedNoImageHeldoutProfile,
  checkedRegionSeededRecipe,
  checkedRegionNoImageRecipe,
  regionSeededProducerSourceManifest,
  regionSeededRecipe,
  processRegionSeededCase,
  runRegionSeededProfile,
  removeImagesAtDecisionBoundary,
} from '../benchmarks/v02/region-seeded-runner.js'
import type { Recorder } from '../benchmarks/v02/recording.js'
import { recordProvider } from '../benchmarks/v02/recording.js'
import { RunBudget } from '../benchmarks/v02/budget.js'
import {
  parseRegionSeededArgs,
  runRegionSeededCli,
} from '../benchmarks/v02/run-region-seeded-dev.js'

await test('region-seeded and no-image controls are distinct named fixed recipes', () => {
  assert.equal(regionSeededProfile.id, 'native-luna-region-seeded-sam-dev-v1')
  assert.equal(regionSeededNoImageProfile.id, 'native-luna-region-no-image-control-dev-v1')
  assert.equal(regionPresenceFirstProfile.id, 'native-luna-presence-first-region-seeded-sam-dev-v2')
  assert.equal(
    regionPresenceFirstNoImageProfile.id,
    'native-luna-presence-first-region-no-image-control-dev-v2',
  )
  assert.equal(
    regionPresenceFirstHeldoutProfile.id,
    'native-luna-presence-first-region-seeded-sam-heldout-v2',
  )
  assert.equal(
    regionPresenceFirstNoImageHeldoutProfile.id,
    'native-luna-presence-first-region-no-image-control-heldout-v2',
  )
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
  assert.equal(
    regionPresenceFirstCheckedProfile.id,
    'native-luna-presence-first-checked-region-sam-dev-v3',
  )
  assert.equal(
    regionPresenceFirstCheckedNoImageProfile.id,
    'native-luna-presence-first-region-no-image-control-dev-v3',
  )
  assert.equal(
    regionPresenceFirstCheckedHeldoutProfile.id,
    'native-luna-presence-first-checked-region-sam-heldout-v3',
  )
  assert.equal(
    regionPresenceFirstCheckedNoImageHeldoutProfile.id,
    'native-luna-presence-first-region-no-image-control-heldout-v3',
  )
  assert.equal(checkedRegionSeededRecipe.maxBoxCheckCalls, 2)
  assert.equal(checkedRegionSeededRecipe.maxLogicalCallsPerCase, 6)
  assert.equal(checkedRegionSeededRecipe.maxPhysicalCallsPerCase, 6)
  assert.equal(checkedRegionSeededRecipe.timeoutMs, 120_000)
  assert.equal(checkedRegionSeededRecipe.retries, 0)
  assert.equal(checkedRegionSeededRecipe.fallback, false)
  assert.equal(checkedRegionNoImageRecipe.maxBoxCheckCalls, 0)
  assert.equal(checkedRegionNoImageRecipe.maxLogicalCallsPerCase, 4)
  assert.equal(checkedRegionNoImageRecipe.maxPhysicalCallsPerCase, 4)
  assert.deepEqual(
    regionSeededDevManifests.map((item) => item.sha256),
    [
      '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a',
      '6013a54bebba277f6457765cd8ef78e12e2dd5bab4453a752967233ebb429bfc',
      'b04ba6cac5b39c927281f61e4af7dcc7a5c5c2272a637aa9676ab3009fbd5d15',
    ],
  )
})

await test('checked-region records ordered box-check evidence without adding checks to seed search', async () => {
  const fixture = await makeProcessCaseFixture({
    variant: 'region-seeded-sam',
    checkedRegion: true,
    runBoxCheck: true,
  })
  try {
    const result = await processRegionSeededCase(fixture.args)
    assert.equal(result.extraction.seed.status, 'located', JSON.stringify(result.extraction))
    assert.equal(result.extraction.seed.logicalCalls, 0)
    assert.equal(result.extraction.status, 'unknown')
    assert.deepEqual(
      result.extraction.boxChecks?.map((row) => [row.index, row.status, row.verdict]),
      [[0, 'ok', 'complete']],
    )
    assert.deepEqual(result.extraction.verification, {
      checks: [
        {
          verdict: 'complete',
          selection: {
            choice: 'complete',
            nativeChoice: 'complete',
            probabilities: { complete: 1, 'needs-expansion': 0, unknown: 0 },
            tied: ['complete'],
          },
          metadata: {
            model: 'fixture',
            provider: 'fixture',
            requestId: null,
            durationMs: 1,
            costUsd: 0,
            attempts: 1,
          },
        },
      ],
      expansion: 'not-needed',
    })
    assert.equal(fixture.extractCalls(), 1)
    assert.equal(fixture.segmentCalls(), 1)
    assert.equal(fixture.disposeCalls(), 1)
  } finally {
    await fixture.dispose()
  }
})

await test('checked-region no-image control emits an empty check list and never configures SAM', async () => {
  const fixture = await makeProcessCaseFixture({
    variant: 'no-image-control',
    checkedRegion: true,
  })
  try {
    const result = await processRegionSeededCase(fixture.args)
    assert.equal(result.extraction.status, 'not-found')
    assert.deepEqual(result.extraction.boxChecks, [])
    assert.equal(fixture.locateCalls(), 1)
    assert.equal(fixture.extractCalls(), 0)
    assert.equal(fixture.segmentCalls(), 0)
    assert.equal(fixture.disposeCalls(), 1)
  } finally {
    await fixture.dispose()
  }
})

await test('failed box-check attempts retain zero-fetch evidence without a fabricated verification result', async () => {
  const fixture = await makeProcessCaseFixture({
    variant: 'region-seeded-sam',
    checkedRegion: true,
    runBoxCheck: true,
    boxCheckError: Object.assign(new Error('fixture local validation'), { code: 'INVALID_INPUT' }),
  })
  try {
    const result = await processRegionSeededCase(fixture.args)
    assert.equal(result.extraction.status, 'failed')
    assert.equal(result.extraction.seed.status, 'located')
    assert.deepEqual(result.extraction.boxChecks, [
      {
        index: 0,
        status: 'failed',
        requestHash: null,
        logicalId: null,
        physicalIds: [],
        physicalCalls: 0,
        errorCode: 'INVALID_INPUT',
      },
    ])
    assert.equal(result.extraction.verification, undefined)
  } finally {
    await fixture.dispose()
  }
})

await test('presence-first gate skips candidate extraction and control region search after absent classification', async () => {
  for (const variant of ['region-seeded-sam', 'no-image-control'] as const) {
    const fixture = await makeProcessCaseFixture({
      variant,
      classify: { choice: 'absent' },
      checkedRegion: true,
    })
    try {
      const result = await processRegionSeededCase(fixture.args)
      assert.equal(result.classify.status, 'ok')
      assert.equal(result.classify.value, 'absent')
      assert.equal(result.extraction.status, 'not-found')
      assert.equal(result.extraction.reason, 'classification-absent')
      assert.equal(result.extraction.physicalCalls, 0)
      assert.equal(result.extraction.logicalCalls, 0)
      assert.equal(result.extraction.seed.status, 'not-reached')
      assert.deepEqual(result.extraction.boxChecks, [])
      assert.equal(fixture.locateCalls(), 0)
      assert.equal(fixture.extractCalls(), 0)
      assert.equal(fixture.segmentCalls(), 0)
      assert.equal(fixture.classifyCalls(), 1)
      assert.equal(fixture.disposeCalls(), 1)
      assert.deepEqual(await readdir(fixture.caseDirectory), [])
    } finally {
      await fixture.dispose()
    }
  }
})

await test('presence-first gate skips region work and artifacts after failed classification', async () => {
  const fixture = await makeProcessCaseFixture({
    variant: 'region-seeded-sam',
    checkedRegion: true,
    classifyError: Object.assign(new Error('fixture provider failure'), { code: 'PROVIDER' }),
  })
  try {
    const result = await processRegionSeededCase(fixture.args)
    assert.equal(result.classify.status, 'failed')
    assert.equal(result.classify.errorCode, 'PROVIDER')
    assert.equal(result.extraction.status, 'failed')
    assert.equal(result.extraction.reason, 'classification-failed')
    assert.equal(result.extraction.physicalCalls, 0)
    assert.equal(result.extraction.logicalCalls, 0)
    assert.equal(result.extraction.seed.status, 'not-reached')
    assert.deepEqual(result.extraction.boxChecks, [])
    assert.equal(fixture.locateCalls(), 0)
    assert.equal(fixture.extractCalls(), 0)
    assert.equal(fixture.segmentCalls(), 0)
    assert.equal(fixture.classifyCalls(), 1)
    assert.equal(fixture.disposeCalls(), 1)
    assert.deepEqual(await readdir(fixture.caseDirectory), [])
  } finally {
    await fixture.dispose()
  }
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

await test('receipt persistence failures fail closed before the next operation stage', () => {
  const healthyAfterProviderError = {
    port: {
      decide: async () => {
        throw new Error('provider error')
      },
    },
    calls: [],
    logicalCalls: [],
    fetch: async () => new Response('{}'),
    persistenceFailures: [],
  } satisfies Recorder
  assert.doesNotThrow(() => assertRecorderHealthy(healthyAfterProviderError))

  const lostReceipt = {
    ...healthyAfterProviderError,
    persistenceFailures: [
      {
        stage: 'physical-receipt',
        logicalId: 1,
        physicalId: 1,
        errorCode: 'PERSISTENCE_ERROR',
      },
    ],
  } satisfies Recorder
  assert.throws(
    () => assertRecorderHealthy(lostReceipt),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'PERSISTENCE_FAILURE')
      return true
    },
  )
})

await test('recordProvider exposes pre-fetch persistence failure without admitting a network call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'region-seeded-receipt-failure-'))
  try {
    const blocker = join(root, 'not-a-directory')
    await writeFile(blocker, 'fixture')
    let fetchCalls = 0
    const recorder = recordProvider(
      () => ({
        decide: async () => {
          throw new Error('must not be called')
        },
      }),
      new RunBudget(1, 1, 0.05, 'dev'),
      blocker,
      {
        model: 'fixture-model',
        provider: 'fixture-provider',
        providerName: 'Fixture',
        apiEndpoint: '/fixture',
        allowFallbacks: false,
      },
      async () => {
        fetchCalls++
        return new Response('{}')
      },
    )
    await assert.rejects(
      recorder.port.decide({ state: ['fixture'], questions: {} }, new AbortController().signal),
    )
    assert.equal(fetchCalls, 0)
    assert.equal(recorder.calls.length, 0)
    assert.equal(recorder.persistenceFailures?.length, 1)
    assert.throws(
      () => assertRecorderHealthy(recorder),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'PERSISTENCE_FAILURE')
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
  const gatedCandidate = parseRegionSeededArgs(['--dry-run', '--presence-first'])
  assert.equal(gatedCandidate.profileId, regionPresenceFirstProfile.id)
  assert.equal(gatedCandidate.requireClassifiedPresence, true)
  const gatedControl = parseRegionSeededArgs([
    '--dry-run',
    '--variant',
    'no-image-control',
    '--presence-first',
  ])
  assert.equal(gatedControl.profileId, regionPresenceFirstNoImageProfile.id)
  assert.equal(gatedControl.requireClassifiedPresence, true)
  const checkedCandidate = parseRegionSeededArgs(['--dry-run', '--checked-region'])
  assert.equal(checkedCandidate.profileId, regionPresenceFirstCheckedProfile.id)
  assert.equal(checkedCandidate.requireClassifiedPresence, true)
  assert.equal(checkedCandidate.checkedRegion, true)
  const checkedControl = parseRegionSeededArgs([
    '--dry-run',
    '--variant',
    'no-image-control',
    '--checked-region',
  ])
  assert.equal(checkedControl.profileId, regionPresenceFirstCheckedNoImageProfile.id)
  assert.equal(checkedControl.checkedRegion, true)
  assert.throws(
    () => parseRegionSeededArgs(['--dry-run', '--phase', 'heldout']),
    /HELDOUT requires --freeze/u,
  )
  const heldoutArgs = [
    '--dry-run',
    '--phase',
    'heldout',
    '--presence-first',
    '--freeze',
    '/tmp/freeze.json',
    '--image-root',
    '/tmp/image-root',
    '--photo-inputs',
    '/tmp/photo.json',
    '--photo-sha256',
    'a'.repeat(64),
    '--ui-inputs',
    '/tmp/ui.json',
    '--ui-sha256',
    'b'.repeat(64),
    '--map-inputs',
    '/tmp/map.json',
    '--map-sha256',
    'c'.repeat(64),
  ]
  const heldoutCandidate = parseRegionSeededArgs(heldoutArgs)
  assert.equal(heldoutCandidate.profileId, regionPresenceFirstHeldoutProfile.id)
  assert.equal(heldoutCandidate.phase, 'heldout')
  assert.equal(heldoutCandidate.expectedCaseCount, 80)
  assert.equal(heldoutCandidate.maxPhysicalCalls, 600)
  assert.equal(heldoutCandidate.maxCostUsd, 10)
  assert.equal(heldoutCandidate.requireClassifiedPresence, true)
  const heldoutControl = parseRegionSeededArgs([...heldoutArgs, '--variant', 'no-image-control'])
  assert.equal(heldoutControl.profileId, regionPresenceFirstNoImageHeldoutProfile.id)
  assert.equal(heldoutControl.maxPhysicalCalls, 600)
  assert.equal(heldoutControl.maxCostUsd, 10)
  const checkedHeldoutCandidate = parseRegionSeededArgs([...heldoutArgs, '--checked-region'])
  assert.equal(checkedHeldoutCandidate.profileId, regionPresenceFirstCheckedHeldoutProfile.id)
  assert.equal(checkedHeldoutCandidate.checkedRegion, true)
  const checkedHeldoutControl = parseRegionSeededArgs([
    ...heldoutArgs,
    '--variant',
    'no-image-control',
    '--checked-region',
  ])
  assert.equal(checkedHeldoutControl.profileId, regionPresenceFirstCheckedNoImageHeldoutProfile.id)
  assert.equal(checkedHeldoutControl.maxPhysicalCalls, 600)
  assert.throws(
    () =>
      parseRegionSeededArgs(['--dry-run', '--phase', 'heldout', '--freeze', '/tmp/freeze.json']),
    /HELDOUT requires explicit --image-root/u,
  )
  assert.throws(() => parseRegionSeededArgs([]), /Choose exactly one/u)
  assert.throws(() => parseRegionSeededArgs(['--dry-run', '--allow-paid']), /Choose exactly one/u)
})

await test('new producer rejects legacy segmentation dispatch before reading credentials', async () => {
  await assert.rejects(
    runRegionSeededCli(['--allow-paid']),
    /Legacy segmentation profiles require their frozen historical producer/u,
  )
})

await test('presence-first HELDOUT rejects an authorization that omits its required policy bit', async () => {
  await assert.rejects(
    runRegionSeededProfile({
      manifests: [],
      imageRoot: '/unused/image-root',
      outputRoot: '/unused/output',
      apiKey: 'offline-fixture-key',
      encoderPath: '/unused/encoder.onnx',
      decoderPath: '/unused/decoder.onnx',
      profileId: regionPresenceFirstHeldoutProfile.id,
      variant: 'region-seeded-sam',
      requireClassifiedPresence: true,
      phase: 'heldout',
      expectedCaseCount: 80,
      maxPhysicalCalls: 600,
      maxCostUsd: 10,
      unknownCostReserveUsd: 0.05,
      authorization: {
        schemaVersion: 1,
        profileId: regionPresenceFirstHeldoutProfile.id,
        phase: 'heldout',
        variant: 'region-seeded-sam',
        producerSourceSha256: 'a'.repeat(64),
        manifests: [
          { sha256: 'b'.repeat(64), cases: 40 },
          { sha256: 'c'.repeat(64), cases: 20 },
          { sha256: 'd'.repeat(64), cases: 20 },
        ],
        maxPhysicalCalls: 600,
        maxCostUsd: 10,
        unknownCostReserveUsd: 0.05,
      },
    }),
    /external frozen authorization/u,
  )
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

async function makeProcessCaseFixture(input: {
  variant: 'region-seeded-sam' | 'no-image-control'
  classify?: { choice: 'present' | 'absent' }
  classifyError?: Error
  checkedRegion?: boolean
  runBoxCheck?: boolean
  boxCheckError?: Error
}) {
  const root = await mkdtemp(join(tmpdir(), 'presence-first-case-'))
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 20, g: 30, b: 40 } },
  })
    .png()
    .toBuffer()
  const imagePath = join(root, 'image.png')
  await writeFile(imagePath, bytes)
  const item: FreshCase = {
    caseId: 'fixture-case',
    image: {
      path: 'image.png',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      width: 2,
      height: 2,
    },
    locate: { target: 'named target' },
    classify: { question: 'Is the target present?', options: ['present', 'absent'] },
  }
  const caseDirectory = join(root, 'case-output')
  let locateCalls = 0
  let extractCalls = 0
  let segmentCalls = 0
  let classifyCalls = 0
  let disposeCalls = 0
  const metadata = {
    model: 'fixture',
    provider: 'fixture',
    requestId: null,
    durationMs: 1,
    costUsd: 0,
    attempts: 1,
  }
  const result: ClassificationResult = {
    choice: input.classify?.choice ?? 'present',
    nativeChoice: input.classify?.choice ?? 'present',
    probabilities: { [input.classify?.choice ?? 'present']: 1 },
    tied: [input.classify?.choice ?? 'present'],
    metadata,
  }
  const decision: DecisionPort = {
    async decide(request) {
      if (request.questions.box_check && input.boxCheckError) throw input.boxCheckError
      const answer = request.questions.box_check
        ? {
            type: 'choice' as const,
            choice: 'complete',
            probabilities: { complete: 1, 'needs-expansion': 0, unknown: 0 },
          }
        : undefined
      return { answers: answer ? { box_check: answer } : {}, metadata }
    },
  }
  const recorder: Recorder = {
    port: decision,
    calls: [],
    logicalCalls: [],
    fetch: async () => new Response('{}'),
    persistenceFailures: [],
  }
  const segmentation: SegmentationPort = {
    async segment() {
      segmentCalls++
      return {
        status: 'unknown',
        reason: 'fixture',
        metadata: {
          method: 'fixture',
          backend: 'fixture',
          durationMs: 1,
          input: { width: 2, height: 2 },
        },
      }
    },
    async settle() {},
    async dispose() {},
  }
  const classifierFactory = (options: ClassifierOptions): Classifier => ({
    async classify() {
      classifyCalls++
      if (input.classifyError) throw input.classifyError
      return result
    },
    async locate() {
      locateCalls++
      return {
        status: 'not-found',
        reason: 'absent-in-evaluated-region',
        metadata: {
          image: { width: 2, height: 2, coordinateSpace: 'oriented-source-pixels' },
          stages: [],
          durationMs: 1,
          knownCostUsd: 0,
          unknownCostCount: 0,
        },
      }
    },
    async extract(extractInput) {
      extractCalls++
      if (input.runBoxCheck) {
        assert.ok(options.segmentation)
        assert.ok(options.segmentationBoxCheck)
        const rgba = await sharp(bytes).ensureAlpha().raw().toBuffer()
        try {
          const seed = await options.segmentation.segment({
            image: { data: rgba, width: 2, height: 2, format: 'rgba8' },
            seedRegion: { left: 0, top: 0, width: 1, height: 1 },
            prompt: 'seed-region',
            wholeRegion: { left: 0, top: 0, width: 2, height: 2 },
            bounds: {
              left: { start: 0, endExclusive: 2 },
              right: { start: 0, endExclusive: 2 },
              top: { start: 0, endExclusive: 2 },
              bottom: { start: 0, endExclusive: 2 },
            },
            roi: { left: 0, top: 0, width: 2, height: 2 },
            target: 'named target',
            exclusions: [],
            completeness: 'visible-object',
            signal: extractInput.signal ?? new AbortController().signal,
          })
          assert.equal(seed.status, 'unknown')
          const checked = await options.segmentationBoxCheck.check({
            image: { data: rgba, width: 2, height: 2, format: 'rgba8' },
            region: { left: 0, top: 0, width: 2, height: 2 },
            seedRegion: { left: 0, top: 0, width: 1, height: 1 },
            roi: { left: 0, top: 0, width: 2, height: 2 },
            target: 'named target',
            exclusions: [],
            signal: extractInput.signal ?? new AbortController().signal,
          })
          const localization = {
            image: { width: 2, height: 2, coordinateSpace: 'oriented-source-pixels' as const },
            stages: [],
            durationMs: 1,
            knownCostUsd: 0,
            unknownCostCount: 0,
          }
          return {
            status: 'unknown' as const,
            reason: 'segmentation-uncertain' as const,
            seedLocation: {
              status: 'located' as const,
              region: { left: 0, top: 0, width: 1, height: 1 },
              normalizedRegion: { left: 0, top: 0, width: 0.5, height: 0.5 },
              selection: {
                choice: 'C00',
                nativeChoice: 'C00',
                probabilities: { C00: 1 },
                tied: ['C00'],
              },
              method: 'three-choice-grid-v1' as const,
              metadata: localization,
            },
            metadata: localization,
            segmentation: {
              method: 'fixture',
              backend: 'fixture',
              durationMs: 1,
              input: { width: 2, height: 2 },
            },
            verification: { checks: [checked], expansion: 'not-needed' as const },
          }
        } finally {
          rgba.fill(0)
        }
      }
      return {
        status: 'not-found',
        reason: 'absent-in-evaluated-region',
        metadata: {
          image: { width: 2, height: 2, coordinateSpace: 'oriented-source-pixels' },
          stages: [],
          durationMs: 1,
          knownCostUsd: 0,
          unknownCostCount: 0,
        },
      }
    },
    async dispose() {
      disposeCalls++
      assert.equal(options.segmentation !== undefined, input.variant === 'region-seeded-sam')
    },
  })
  const args: Parameters<typeof processRegionSeededCase>[0] = {
    item,
    root,
    caseDirectory,
    classifierFactory,
    decision,
    ...(input.variant === 'region-seeded-sam' ? { segmentation } : {}),
    variant: input.variant,
    requireClassifiedPresence: true,
    ...(input.checkedRegion ? { checkedRegion: true } : {}),
    recorder,
    signal: new AbortController().signal,
  }
  return {
    args,
    caseDirectory,
    locateCalls: () => locateCalls,
    extractCalls: () => extractCalls,
    segmentCalls: () => segmentCalls,
    classifyCalls: () => classifyCalls,
    disposeCalls: () => disposeCalls,
    async dispose() {
      bytes.fill(0)
      await rm(root, { recursive: true, force: true })
    },
  }
}
