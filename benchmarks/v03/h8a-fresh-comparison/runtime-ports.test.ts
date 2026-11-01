import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import { z } from 'zod'
import type { DecisionRequest } from '../../../src/entities/contracts.js'
import { createClassifier } from '../../../src/app/create-classifier.js'
import type { SegmentationPort } from '../../../src/entities/segmentation.js'
import { createOpenRouterDecisions } from '../../../src/openrouter.js'
import { createNativeCategoricalPresencePort } from '../../v02/native-categorical-presence-port.js'
import { assertRecorderHealthy, processRegionSeededCase } from '../../v02/region-seeded-runner.js'
import { CampaignLedger } from './campaign-ledger.js'
import { ImmutableCaseArtifactStore } from './case-artifact-store.js'
import { createCampaignFetchBoundary } from './campaign-fetch-boundary.js'
import { PROFILE_CANDIDATE_ID, PROFILE_CONTROL_ID, PROFILE_FLAT_CANDIDATE_ID } from './constants.js'
import type {
  CandidateRuntimePort,
  H8FreshRuntimePortOptions,
  OfflineFixtureRuntimePortOptions,
} from './runtime-ports.js'
import {
  createH8FreshRuntimePorts,
  createH8FreshRuntimePortsForOfflineFixture,
} from './runtime-ports.js'
import { packBinaryLsb0V1, unpackBinaryLsb0V1 } from './packed-binary-lsb0.js'
import { PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY } from './provider-refusal-replay.js'

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

function visionReply(model: string, cost?: number): Response {
  return response({
    id: 'offline-vision-reply',
    model,
    provider: 'OpenAI',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { content: JSON.stringify({ answers: { selection: { ranking: ['visible'] } } }) },
      },
    ],
    ...(cost === undefined ? {} : { usage: { cost } }),
  })
}

function alphaReply(body: unknown, cost?: number): Response {
  const parsed = z
    .object({
      questions: z
        .record(z.object({ criteria: z.record(z.unknown()).optional() }).passthrough())
        .optional(),
    })
    .passthrough()
    .parse(body)
  const answers = Object.fromEntries(
    Object.entries(parsed.questions ?? {}).map(([id, question]) => {
      const criteria = Object.keys(question.criteria ?? {})
      const first = criteria[0] ?? 'unknown'
      return [
        id,
        {
          type: 'choice',
          choice: first,
          probabilities: Object.fromEntries(criteria.map((key) => [key, key === first ? 1 : 0])),
        },
      ]
    }),
  )
  return response({
    id: 'offline-alpha-reply',
    model: 'openai/gpt-6-luna-decisions',
    provider: 'OpenAI',
    answers,
    ...(cost === undefined ? {} : { usage: { cost } }),
  })
}

function maskBytes(
  width: number,
  height: number,
  rect: { left: number; top: number; width: number; height: number },
): Uint8Array {
  const pixels = new Uint8Array(width * height)
  for (let y = rect.top; y < rect.top + rect.height; y++) {
    pixels.fill(1, y * width + rect.left, y * width + rect.left + rect.width)
  }
  return pixels
}

async function withFixtureRoot(
  run: (root: string, source: Buffer) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'h8a-fresh-ports-'))
  const source = await sharp({
    create: { width: 64, height: 48, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } },
  })
    .png()
    .toBuffer()
  try {
    await run(root, source)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function fixtureOptions(
  root: string,
  fetch: typeof globalThis.fetch,
  candidateRuntime: CandidateRuntimePort,
  segmenter: SegmentationPort,
): OfflineFixtureRuntimePortOptions {
  return {
    apiKey: 'offline-fixture-key',
    artifactRoot: join(root, 'artifacts'),
    temporaryRoot: join(root, 'temporary'),
    maskArtifactDirectory: join(root, 'masks'),
    cutoutArtifactDirectory: join(root, 'cutouts'),
    nativeRuntime: {
      pythonExecutable: 'offline-not-executed',
      assetRoot: join(root, 'assets-not-opened'),
    },
    mobileSam: {
      encoderPath: join(root, 'encoder-not-opened.onnx'),
      decoderPath: join(root, 'decoder-not-opened.onnx'),
    },
    sourceCanvasByOpaqueCaseId: new Map([
      ['opaque-local-route-id', { width: 64, height: 48 }],
      ['opaque-control-route-id', { width: 64, height: 48 }],
      ['opaque-exif-control-id', { width: 48, height: 64 }],
    ]),
    controlEngine: {
      kind: 'offline-fixture-only',
      processRegionSeededCase,
      assertRecorderHealthy,
      createClassifier,
      createOpenRouterDecisions,
      createNativeCategoricalPresencePort,
      createControlSegmenter: () => segmenter,
    },
    fetch,
    createCandidateRuntime: () => candidateRuntime,
  }
}

await test('campaign fetch boundary admits only the actual fetch and settles observed usage cost', async () => {
  await withFixtureRoot(async (root) => {
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const requestBody = JSON.stringify({ model: 'openai/gpt-6-luna' })
    const bodySha = digest(requestBody)
    let baseFetchCalls = 0
    const boundary = createCampaignFetchBoundary({
      ledger,
      reservedUsd: 0.55,
      profileId: PROFILE_CANDIDATE_ID,
      opaqueCaseId: 'boundary-fixture-case',
      caseExecutionIdentitySha256: digest('boundary-case-identity'),
      endpoint: '/api/v1/chat/completions',
      journalDirectory: join(root, 'journal'),
      baseFetch: async () => {
        baseFetchCalls++
        return response({ usage: { cost: 0.014 } })
      },
      readCurrentProviderCall: () => ({
        physicalId: 1,
        logicalId: 1,
        requestSha256: digest('logical-request'),
        requestBodySha256: bodySha,
      }),
    })
    assert.equal(ledger.snapshot().physicalDispatchCount, 0)
    const returned = await boundary.fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: requestBody,
    })
    assert.equal(returned.status, 200)
    assert.equal(baseFetchCalls, 1)
    assert.equal(ledger.snapshot().physicalDispatchCount, 1)
    assert.equal(ledger.snapshot().knownCostUsd, 0.014)
    assert.equal(ledger.snapshot().unknownReserveUsd, 0)
    assert.equal(boundary.entries[0]?.physicalId, 1)
    assert.equal(boundary.entries[0]?.requestBodySha256, bodySha)
    assert.deepEqual(await returned.json(), { usage: { cost: 0.014 } })
    const receipt = await readFile(join(root, 'journal', 'dispatch-1.json'), 'utf8')
    assert.doesNotMatch(receipt, /offline-fixture-key|authorization/iu)
  })
})

await test('runtime rejects a historical control bundle with a different source closure', async () => {
  await withFixtureRoot(async (root) => {
    const fetch = async () => response({})
    const candidateRuntime: CandidateRuntimePort = {
      async run() {
        return { status: 'unknown' as const, reason: 'fixture' }
      },
      async dispose() {},
    }
    const segmenter: SegmentationPort = {
      async segment() {
        return {
          status: 'unknown',
          reason: 'unused',
          metadata: {
            method: 'fixture',
            backend: 'fixture',
            durationMs: 0,
            input: { width: 1, height: 1 },
          },
        }
      },
      async settle() {},
      async dispose() {},
    }
    const fixtureOptionsValue = fixtureOptions(root, fetch, candidateRuntime, segmenter)
    const fixtureEngine = fixtureOptionsValue.controlEngine
    const options: H8FreshRuntimePortOptions = {
      ...fixtureOptionsValue,
      controlEngine: {
        kind: 'verified-historical-v02',
        sourceClosureSha256: '0'.repeat(64),
        snapshotReceiptSha256: '1'.repeat(64),
        processRegionSeededCase: fixtureEngine.processRegionSeededCase,
        assertRecorderHealthy: fixtureEngine.assertRecorderHealthy,
        createClassifier: fixtureEngine.createClassifier,
        createOpenRouterDecisions: fixtureEngine.createOpenRouterDecisions,
        createNativeCategoricalPresencePort: fixtureEngine.createNativeCategoricalPresencePort,
        createMobileSamSegmenter: async () => segmenter,
      },
    }
    await assert.rejects(createH8FreshRuntimePorts(options), /Historical control engine identity/u)
  })
})

await test('cancellation after asynchronous admission rolls back without a physical call', async () => {
  await withFixtureRoot(async (root) => {
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const controller = new AbortController()
    const admit = ledger.admitPhysical.bind(ledger)
    ledger.admitPhysical = async (reservedUsd) => {
      const reservation = await admit(reservedUsd)
      controller.abort(new Error('cancelled during admission fixture'))
      return reservation
    }
    let fetchCalls = 0
    const body = JSON.stringify({ model: 'openai/gpt-6-luna' })
    const boundary = createCampaignFetchBoundary({
      ledger,
      reservedUsd: 0.55,
      profileId: PROFILE_CANDIDATE_ID,
      opaqueCaseId: 'boundary-fixture-case',
      caseExecutionIdentitySha256: digest('boundary-case-identity'),
      endpoint: '/api/v1/chat/completions',
      journalDirectory: join(root, 'journal'),
      signal: controller.signal,
      baseFetch: async () => {
        fetchCalls++
        return visionReply('openai/gpt-6-luna')
      },
      readCurrentProviderCall: () => ({
        physicalId: 1,
        logicalId: 1,
        requestSha256: digest('logical'),
        requestBodySha256: digest(body),
      }),
    })
    await assert.rejects(
      boundary.fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body }),
    )
    assert.equal(fetchCalls, 0)
    assert.equal(ledger.snapshot().physicalDispatchCount, 0)
    assert.equal(ledger.snapshot().inFlightReservations.length, 0)
    assert.equal(boundary.entries.length, 0)
  })
})

await test('cancellation after persisted intent but before fetch also rolls back without dispatch', async () => {
  await withFixtureRoot(async (root) => {
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const controller = new AbortController()
    const recordIntent = ledger.recordDispatchIntent.bind(ledger)
    ledger.recordDispatchIntent = async (reservationId) => {
      await recordIntent(reservationId)
      controller.abort(new Error('cancelled after intent fixture'))
    }
    let fetchCalls = 0
    const body = JSON.stringify({ model: 'openai/gpt-6-luna' })
    const boundary = createCampaignFetchBoundary({
      ledger,
      reservedUsd: 0.55,
      profileId: PROFILE_CANDIDATE_ID,
      opaqueCaseId: 'boundary-fixture-case',
      caseExecutionIdentitySha256: digest('boundary-case-identity'),
      endpoint: '/api/v1/chat/completions',
      journalDirectory: join(root, 'journal'),
      signal: controller.signal,
      baseFetch: async () => {
        fetchCalls++
        return visionReply('openai/gpt-6-luna')
      },
      readCurrentProviderCall: () => ({
        physicalId: 1,
        logicalId: 1,
        requestSha256: digest('logical'),
        requestBodySha256: digest(body),
      }),
    })
    await assert.rejects(
      boundary.fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body }),
    )
    assert.equal(fetchCalls, 0)
    assert.equal(ledger.snapshot().physicalDispatchCount, 0)
    assert.equal(ledger.snapshot().inFlightReservations.length, 0)
    assert.equal(boundary.entries.length, 0)
  })
})

await test('campaign fetch boundary retains unknown cost after a dispatched transport error', async () => {
  await withFixtureRoot(async (root) => {
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const body = '{"model":"openai/gpt-6-luna"}'
    const controller = new AbortController()
    const boundary = createCampaignFetchBoundary({
      ledger,
      reservedUsd: 0.55,
      profileId: PROFILE_CANDIDATE_ID,
      opaqueCaseId: 'boundary-fixture-case',
      caseExecutionIdentitySha256: digest('boundary-case-identity'),
      endpoint: '/api/v1/chat/completions',
      journalDirectory: join(root, 'journal'),
      signal: controller.signal,
      baseFetch: async () => {
        controller.abort(new Error('offline cancellation fixture'))
        throw new Error('offline transport rejected after invocation')
      },
      readCurrentProviderCall: () => ({
        physicalId: 1,
        logicalId: 1,
        requestSha256: digest('logical'),
        requestBodySha256: digest(body),
      }),
    })
    await assert.rejects(
      boundary.fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body }),
    )
    assert.equal(ledger.snapshot().physicalDispatchCount, 1)
    assert.equal(ledger.snapshot().unknownReserveUsd, 0.55)
    assert.equal(boundary.entries[0]?.dispatchState, 'confirmed')
    assert.equal(boundary.entries[0]?.physicalId, 1)
    assert.equal(boundary.entries[0]?.costUsd, null)
  })
})

await test('aborted response body is cancelled and joined before unknown settlement', async () => {
  await withFixtureRoot(async (root) => {
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const controller = new AbortController()
    const requestBody = JSON.stringify({ model: 'openai/gpt-6-luna' })
    const boundary = createCampaignFetchBoundary({
      ledger,
      reservedUsd: 0.55,
      profileId: PROFILE_CANDIDATE_ID,
      opaqueCaseId: 'boundary-fixture-case',
      caseExecutionIdentitySha256: digest('boundary-case-identity'),
      endpoint: '/api/v1/chat/completions',
      journalDirectory: join(root, 'journal'),
      signal: controller.signal,
      baseFetch: async () => {
        const stream = new ReadableStream<Uint8Array>({
          start() {},
          cancel() {
            cancelled = true
            return Promise.resolve()
          },
        })
        setTimeout(() => controller.abort(new Error('response deadline fixture')), 5)
        return new Response(stream, { headers: { 'Content-Type': 'application/json' } })
      },
      readCurrentProviderCall: () => ({
        physicalId: 1,
        logicalId: 1,
        requestSha256: digest('logical'),
        requestBodySha256: digest(requestBody),
      }),
    })
    let cancelled = false
    await assert.rejects(
      boundary.fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        body: requestBody,
      }),
    )
    assert.equal(cancelled, true)
    assert.equal(ledger.snapshot().physicalDispatchCount, 1)
    assert.equal(ledger.snapshot().unknownReserveUsd, 0.55)
    assert.equal(boundary.entries[0]?.costUsd, null)
  })
})

await test('candidate port uses ordinary Luna vision route and retains its original-canvas mask', async () => {
  await withFixtureRoot(async (root, source) => {
    let requestBody: unknown
    let decisionCalls = 0
    const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as unknown
      assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions')
      return visionReply('openai/gpt-6-luna', 0.002)
    }
    const candidateRuntime: CandidateRuntimePort = {
      async run(input) {
        assert.equal(input.authoredTarget, 'the authored visible sign')
        const request: DecisionRequest = {
          state: ['use the image and target only'],
          questions: {
            selection: {
              type: 'choice',
              rankingSize: 1,
              instructions: 'Choose a visible result.',
              criteria: { visible: 'The target is visible.', absent: 'The target is absent.' },
            },
          },
        }
        const decision = await input.decision.decide(request, input.signal)
        decisionCalls++
        assert.equal(decision.answers.selection?.type, 'ranked-choice')
        const pixels = maskBytes(64, 48, { left: 10, top: 8, width: 6, height: 5 })
        const packed = packBinaryLsb0V1(64, 48, pixels)
        const resultMask = new Uint8Array(packed.byteLength)
        resultMask.set(packed)
        const cutout = new Uint8Array(6 * 5 * 4).fill(255)
        return {
          status: 'located' as const,
          family: 'D' as const,
          alias: 'D00',
          sourceAlias: 'D00',
          originalEncodedSha256: digest(input.encodedImage),
          sourceFrame: { sha256: digest('oriented-frame'), width: 64, height: 48 },
          mask: { format: 'binary-lsb0' as const, width: 64, height: 48, data: resultMask },
          region: { left: 10, top: 8, width: 6, height: 5 },
          center: { x: 13, y: 10.5 },
          cutout: { data: cutout, width: 6, height: 5, format: 'rgba8' as const },
        }
      },
      async dispose() {},
    }
    const emptySegmenter: SegmentationPort = {
      async segment() {
        return {
          status: 'unknown',
          reason: 'unused',
          metadata: {
            method: 'fixture',
            backend: 'fixture',
            durationMs: 0,
            input: { width: 1, height: 1 },
          },
        }
      },
      async settle() {},
      async dispose() {},
    }
    const runtimePorts = await createH8FreshRuntimePortsForOfflineFixture(
      fixtureOptions(root, fetch, candidateRuntime, emptySegmenter),
    )
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    try {
      const result = await runtimePorts.candidatePort.execute(
        {
          opaqueCaseId: 'opaque-local-route-id',
          sourceBytes: source,
          targetTaskText: 'the authored visible sign',
        },
        {
          profileId: PROFILE_CANDIDATE_ID,
          reservedUsdPerFetch: 0.55,
          ledger,
        },
      )
      const body = z
        .object({
          model: z.string().optional(),
          provider: z
            .object({
              only: z.array(z.string()).optional(),
              allow_fallbacks: z.boolean().optional(),
              sort: z.string().optional(),
            })
            .optional(),
          max_tokens: z.number().optional(),
          max_completion_tokens: z.number().optional(),
          reasoning: z.object({ effort: z.string() }).optional(),
        })
        .passthrough()
        .parse(requestBody)
      assert.equal(body.model, 'openai/gpt-6-luna')
      assert.deepEqual(body.provider?.only, ['openai'])
      assert.equal(body.provider?.allow_fallbacks, false)
      assert.equal(body.provider?.sort, undefined)
      assert.equal(body.max_tokens ?? body.max_completion_tokens, 4096)
      assert.equal(body.reasoning?.effort, 'medium')
      assert.equal(decisionCalls, 1)
      assert.equal(
        result.outputRow.caseState,
        'success',
        JSON.stringify({
          row: result.outputRow,
          logical: result.logicalReceipts,
          physical: result.physicalReceipts,
        }),
      )
      assert.equal(result.outputRow.cutoutPresent, true)
      assert.equal(result.physicalReceipts.length, 1)
      assert.equal(result.physicalReceipts[0]?.physicalId, 1)
      assert.equal(result.physicalReceipts[0]?.costUsd, 0.002)
      const maskSha = result.outputRow.maskPackedSha256!
      const mask = runtimePorts.artifacts.masksBySha256.get(maskSha)!
      assert.equal(digest(mask.packedBytes), maskSha)
      assert.deepEqual(
        unpackBinaryLsb0V1(mask.width, mask.height, mask.packedBytes),
        maskBytes(64, 48, { left: 10, top: 8, width: 6, height: 5 }),
      )
      assert.equal(runtimePorts.artifacts.cutoutsBySha256.size, 1)
      const cutout = runtimePorts.artifacts.cutoutsByProfileAndCase.get(
        `${PROFILE_CANDIDATE_ID}:opaque-local-route-id`,
      )
      assert.equal(cutout?.format, 'rgba8')
      assert.equal(digest(cutout?.bytes ?? new Uint8Array()), cutout?.sha256)
      const reopenedCutout = await readFile(cutout!.path)
      assert.equal(reopenedCutout.byteLength, cutout?.bytes.byteLength)
      assert.equal(digest(reopenedCutout), cutout?.sha256)
      assert.equal(result.caseArtifactSidecars?.[0]?.kind, 'candidate-cutout-rgba')
      assert.equal(ledger.snapshot().knownCostUsd, 0.002)
    } finally {
      await runtimePorts.dispose()
    }
  })
})

await test('flat candidate selects its explicit native recipe and preserves profile receipts', async () => {
  await withFixtureRoot(async (root, source) => {
    let selectedRecipeId: string | undefined
    let fetchCalls = 0
    let candidateLimitRejected = false
    let returnUnknown = false
    let omitV2Recipe = false
    const candidateRuntime: CandidateRuntimePort = {
      async run(input) {
        if (returnUnknown)
          return {
            status: 'unknown' as const,
            ...(omitV2Recipe ? {} : { recipeId: PROFILE_FLAT_CANDIDATE_ID }),
            reason: 'verified flat unknown result',
          }
        for (let index = 0; index < 5; index++) {
          try {
            await input.decision.decide(
              {
                state: ['offline flat recipe fixture'],
                questions: {
                  selection: {
                    type: 'choice',
                    rankingSize: 1,
                    instructions: 'Choose a visible result.',
                    criteria: {
                      visible: 'The target is visible.',
                      absent: 'The target is absent.',
                    },
                  },
                },
              },
              input.signal,
            )
          } catch {
            candidateLimitRejected = index === 4
            if (index !== 4) throw new Error('Flat fixture unexpectedly exhausted before call five')
          }
        }
        const pixels = maskBytes(64, 48, { left: 10, top: 8, width: 6, height: 5 })
        const packed = packBinaryLsb0V1(64, 48, pixels)
        const resultMask = new Uint8Array(packed.byteLength)
        resultMask.set(packed)
        return {
          status: 'located' as const,
          recipeId: PROFILE_FLAT_CANDIDATE_ID,
          family: 'D' as const,
          alias: 'D00',
          sourceAlias: 'D00',
          originalEncodedSha256: digest(input.encodedImage),
          sourceFrame: { sha256: digest('flat-frame'), width: 64, height: 48 },
          mask: { format: 'binary-lsb0' as const, width: 64, height: 48, data: resultMask },
          region: { left: 10, top: 8, width: 6, height: 5 },
          center: { x: 13, y: 10.5 },
          cutout: {
            data: new Uint8Array(6 * 5 * 4).fill(255),
            width: 6,
            height: 5,
            format: 'rgba8' as const,
          },
        }
      },
      async dispose() {},
    }
    const segmenter: SegmentationPort = {
      async segment() {
        return {
          status: 'unknown',
          reason: 'unused',
          metadata: {
            method: 'fixture',
            backend: 'fixture',
            durationMs: 0,
            input: { width: 1, height: 1 },
          },
        }
      },
      async settle() {},
      async dispose() {},
    }
    const options = fixtureOptions(
      root,
      async () => {
        fetchCalls++
        return visionReply('openai/gpt-6-luna', 0.002)
      },
      candidateRuntime,
      segmenter,
    )
    options.sourceCanvasByOpaqueCaseId = new Map([
      ['flat-candidate-case', { width: 64, height: 48 }],
      ['flat-candidate-missing-id', { width: 64, height: 48 }],
    ])
    options.nativeRuntime.recipeId = PROFILE_FLAT_CANDIDATE_ID
    options.createCandidateRuntime = (recipeId) => {
      selectedRecipeId = recipeId
      return candidateRuntime
    }
    const runtimePorts = await createH8FreshRuntimePortsForOfflineFixture(options)
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    try {
      const result = await runtimePorts.candidatePort.execute(
        {
          opaqueCaseId: 'flat-candidate-case',
          sourceBytes: source,
          targetTaskText: 'the authored visible sign',
        },
        {
          profileId: PROFILE_FLAT_CANDIDATE_ID,
          reservedUsdPerFetch: 0.55,
          ledger,
        },
      )
      assert.equal(selectedRecipeId, PROFILE_FLAT_CANDIDATE_ID)
      assert.equal(result.outputRow.profileId, PROFILE_FLAT_CANDIDATE_ID)
      assert.equal(
        result.outputRow.caseState,
        'success',
        JSON.stringify({ row: result.outputRow, caseError: result.caseError }),
      )
      assert.equal(result.caseArtifactSidecars?.[0]?.profileId, PROFILE_FLAT_CANDIDATE_ID)
      assert.equal(candidateLimitRejected, true)
      assert.equal(
        runtimePorts.artifacts.cutoutsByProfileAndCase.get(
          `${PROFILE_FLAT_CANDIDATE_ID}:flat-candidate-case`,
        )?.format,
        'rgba8',
      )
      assert.equal(runtimePorts.fetchJournal[0]?.profileId, PROFILE_FLAT_CANDIDATE_ID)
      assert.equal(result.physicalReceipts.length, 4)
      assert.equal(fetchCalls, 4)
      assert.equal(ledger.snapshot().physicalDispatchCount, 4)

      returnUnknown = true
      const unknown = await runtimePorts.candidatePort.execute(
        {
          opaqueCaseId: 'flat-candidate-case',
          sourceBytes: source,
          targetTaskText: 'the authored visible sign',
        },
        {
          profileId: PROFILE_FLAT_CANDIDATE_ID,
          reservedUsdPerFetch: 0.55,
          ledger,
        },
      )
      assert.equal(unknown.outputRow.profileId, PROFILE_FLAT_CANDIDATE_ID)
      assert.equal(unknown.outputRow.caseState, 'unknown')
      assert.equal(fetchCalls, 4)

      omitV2Recipe = true
      const missingRecipe = await runtimePorts.candidatePort.execute(
        {
          opaqueCaseId: 'flat-candidate-missing-id',
          sourceBytes: source,
          targetTaskText: 'the authored visible sign',
        },
        {
          profileId: PROFILE_FLAT_CANDIDATE_ID,
          reservedUsdPerFetch: 0.55,
          ledger,
        },
      )
      assert.equal(missingRecipe.outputRow.caseState, 'error')
      assert.match(missingRecipe.caseError ?? '', /flat profile/u)
      assert.equal(fetchCalls, 4)
    } finally {
      await runtimePorts.dispose()
    }
  })
})

await test('candidate port refuses selected or returned V1/V2 recipe swaps before paid dispatch', async () => {
  await withFixtureRoot(async (root, source) => {
    let fetchCalls = 0
    let runtimeFactoryCalls = 0
    let includeUnexpectedV2Recipe = false
    const candidateRuntime: CandidateRuntimePort = {
      async run() {
        return {
          status: 'unknown',
          reason: 'wrong recipe result',
          ...(includeUnexpectedV2Recipe ? { recipeId: PROFILE_FLAT_CANDIDATE_ID } : {}),
        }
      },
      async dispose() {},
    }
    const segmenter: SegmentationPort = {
      async segment() {
        return {
          status: 'unknown',
          reason: 'unused',
          metadata: {
            method: 'fixture',
            backend: 'fixture',
            durationMs: 0,
            input: { width: 1, height: 1 },
          },
        }
      },
      async settle() {},
      async dispose() {},
    }
    const options = fixtureOptions(
      root,
      async () => {
        fetchCalls++
        return visionReply('openai/gpt-6-luna', 0.002)
      },
      candidateRuntime,
      segmenter,
    )
    options.sourceCanvasByOpaqueCaseId = new Map([
      ['flat-candidate-case', { width: 64, height: 48 }],
      ['opaque-local-route-id', { width: 64, height: 48 }],
    ])
    options.createCandidateRuntime = () => {
      runtimeFactoryCalls++
      return candidateRuntime
    }
    options.nativeRuntime.recipeId = PROFILE_CANDIDATE_ID
    const runtimePorts = await createH8FreshRuntimePortsForOfflineFixture(options)
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    try {
      await assert.rejects(
        runtimePorts.candidatePort.execute(
          {
            opaqueCaseId: 'flat-candidate-case',
            sourceBytes: source,
            targetTaskText: 'the authored visible sign',
          },
          {
            profileId: PROFILE_FLAT_CANDIDATE_ID,
            reservedUsdPerFetch: 0.55,
            ledger,
          },
        ),
        /Selected native recipe does not match the candidate profile/u,
      )
      assert.equal(runtimeFactoryCalls, 1)
      assert.equal(fetchCalls, 0)
      assert.equal(ledger.snapshot().physicalDispatchCount, 0)
      assert.equal(runtimePorts.fetchJournal.length, 0)

      includeUnexpectedV2Recipe = true
      const unexpectedV2Identity = await runtimePorts.candidatePort.execute(
        {
          opaqueCaseId: 'opaque-local-route-id',
          sourceBytes: source,
          targetTaskText: 'the authored visible sign',
        },
        {
          profileId: PROFILE_CANDIDATE_ID,
          reservedUsdPerFetch: 0.55,
          ledger,
        },
      )
      assert.equal(unexpectedV2Identity.outputRow.caseState, 'error')
      assert.match(unexpectedV2Identity.caseError ?? '', /V1 candidate result/u)
      assert.equal(fetchCalls, 0)
      assert.equal(ledger.snapshot().physicalDispatchCount, 0)
      assert.equal(runtimePorts.fetchJournal.length, 0)
    } finally {
      await runtimePorts.dispose()
    }
  })
})

await test('control port uses the categorical decisions route and embeds the cropped mask on source canvas', async () => {
  await withFixtureRoot(async (root, source) => {
    const engineCalls = {
      caseKernel: 0,
      classifierFactory: 0,
      decisionsFactory: 0,
      categoricalWrapper: 0,
      segmenterFactory: 0,
      segment: 0,
    }
    const requests: Array<{ url: string; body: unknown }> = []
    const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(url)
      const body = JSON.parse(String(init?.body)) as unknown
      requests.push({ url: requestUrl, body })
      return alphaReply(body, 0.001)
    }
    const candidateRuntime: CandidateRuntimePort = {
      async run() {
        return { status: 'unknown' as const, reason: 'fixture' }
      },
      async dispose() {},
    }
    const segmenter: SegmentationPort = {
      async segment(input) {
        engineCalls.segment++
        const width = input.image.width
        const height = input.image.height
        const pixels = maskBytes(width, height, { left: 0, top: 0, width, height })
        return {
          status: 'segmented' as const,
          mask: { data: pixels, width, height, format: 'binary-u8' as const },
          metadata: {
            method: 'mobile-sam-seed-region-v1',
            backend: 'mobile-sam',
            durationMs: 1,
            input: { width, height },
          },
        }
      },
      async settle() {},
      async dispose() {},
    }
    const options = fixtureOptions(root, fetch, candidateRuntime, segmenter)
    const fixtureEngine = options.controlEngine
    if (fixtureEngine.kind !== 'offline-fixture-only')
      throw new TypeError('Expected an explicit offline control fixture')
    options.controlEngine = {
      ...fixtureEngine,
      async processRegionSeededCase(args) {
        engineCalls.caseKernel++
        return fixtureEngine.processRegionSeededCase(args)
      },
      assertRecorderHealthy(recorder) {
        return fixtureEngine.assertRecorderHealthy(recorder)
      },
      createClassifier(classifierOptions) {
        engineCalls.classifierFactory++
        return fixtureEngine.createClassifier(classifierOptions)
      },
      createOpenRouterDecisions(decisionOptions) {
        engineCalls.decisionsFactory++
        return fixtureEngine.createOpenRouterDecisions(decisionOptions)
      },
      createNativeCategoricalPresencePort(nativePort) {
        engineCalls.categoricalWrapper++
        return fixtureEngine.createNativeCategoricalPresencePort(nativePort)
      },
      createControlSegmenter() {
        engineCalls.segmenterFactory++
        return fixtureEngine.createControlSegmenter()
      },
    }
    const runtimePorts = await createH8FreshRuntimePortsForOfflineFixture(options)
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    try {
      const result = await runtimePorts.controlPort.execute(
        {
          opaqueCaseId: 'opaque-control-route-id',
          sourceBytes: source,
          targetTaskText: 'the authored visible sign',
        },
        {
          profileId: PROFILE_CONTROL_ID,
          reservedUsdPerFetch: 0.12,
          ledger,
        },
      )
      assert.ok(requests.length > 0)
      assert.deepEqual(engineCalls, {
        caseKernel: 1,
        classifierFactory: 1,
        decisionsFactory: 1,
        categoricalWrapper: 1,
        segmenterFactory: 1,
        segment: 1,
      })
      assert.ok(requests.every((item) => item.url === 'https://openrouter.ai/api/alpha/decisions'))
      assert.ok(
        requests.every((item) =>
          z
            .object({ model: z.string() })
            .passthrough()
            .parse(item.body)
            .model.startsWith('openai/gpt-6-luna-decisions'),
        ),
      )
      for (const item of requests) {
        const request = z
          .object({
            provider: z
              .object({
                only: z.array(z.string()).optional(),
                allow_fallbacks: z.boolean().optional(),
                sort: z.string().optional(),
              })
              .optional(),
          })
          .passthrough()
          .parse(item.body)
        assert.deepEqual(request.provider?.only, ['openai'])
        assert.equal(request.provider?.allow_fallbacks, false)
        assert.equal(request.provider?.sort, undefined)
      }
      assert.equal(result.outputRow.caseState, 'success')
      assert.equal(result.outputRow.cutoutPresent, true)
      const cutout = runtimePorts.artifacts.cutoutsByProfileAndCase.get(
        `${PROFILE_CONTROL_ID}:opaque-control-route-id`,
      )
      assert.equal(cutout?.format, 'png')
      assert.equal(digest(cutout?.bytes ?? new Uint8Array()), cutout?.sha256)
      const reopenedCutout = await readFile(cutout!.path)
      assert.equal(reopenedCutout.byteLength, cutout?.bytes.byteLength)
      assert.equal(digest(reopenedCutout), cutout?.sha256)
      assert.deepEqual({ width: cutout?.width, height: cutout?.height }, { width: 64, height: 48 })
      assert.equal(result.caseArtifactSidecars?.[0]?.kind, 'control-cutout-png')
      assert.deepEqual(result.caseArtifactSidecars?.[0]?.sourceOffset, { x: 0, y: 0 })
      assert.equal(result.physicalReceipts.length, requests.length)
      const maskSha = result.outputRow.maskPackedSha256!
      const stored = runtimePorts.artifacts.masksBySha256.get(maskSha)!
      const pixels = unpackBinaryLsb0V1(stored.width, stored.height, stored.packedBytes)
      assert.equal(stored.width, 64)
      assert.equal(stored.height, 48)
      assert.deepEqual(pixels, maskBytes(64, 48, { left: 0, top: 0, width: 64, height: 48 }))
      assert.equal(ledger.snapshot().physicalDispatchCount, requests.length)
      assert.equal(ledger.snapshot().knownCostUsd, requests.length * 0.001)
      const maskOnDisk = await readFile(stored.path)
      assert.equal(digest(maskOnDisk), maskSha)
    } finally {
      await runtimePorts.dispose()
    }
  })
})

await test('control rejects EXIF-rotated JPEGs unsupported by the frozen loader before dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-exif-control-'))
  const raw = await sharp({
    create: { width: 19, height: 53, channels: 3, background: { r: 50, g: 70, b: 90 } },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer()
  const originalDigest = digest(raw)
  let segmenterCalls = 0
  let fetchCalls = 0
  const candidateRuntime: CandidateRuntimePort = {
    async run() {
      return { status: 'unknown' as const, reason: 'fixture' }
    },
    async dispose() {},
  }
  const segmenter: SegmentationPort = {
    async segment(input) {
      segmenterCalls++
      const pixels = maskBytes(input.image.width, input.image.height, {
        left: 0,
        top: 0,
        width: input.image.width,
        height: input.image.height,
      })
      return {
        status: 'segmented' as const,
        mask: {
          data: pixels,
          width: input.image.width,
          height: input.image.height,
          format: 'binary-u8' as const,
        },
        metadata: {
          method: 'mobile-sam-seed-region-v1',
          backend: 'mobile-sam',
          durationMs: 1,
          input: { width: input.image.width, height: input.image.height },
        },
      }
    },
    async settle() {},
    async dispose() {},
  }
  try {
    const options = fixtureOptions(
      root,
      async (_url, init) => {
        fetchCalls++
        return alphaReply(JSON.parse(String(init?.body)))
      },
      candidateRuntime,
      segmenter,
    )
    options.sourceCanvasByOpaqueCaseId = new Map([
      ['opaque-exif-control-id', { width: 53, height: 19 }],
    ])
    const runtimePorts = await createH8FreshRuntimePortsForOfflineFixture(options)
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    try {
      await assert.rejects(
        runtimePorts.controlPort.execute(
          {
            opaqueCaseId: 'opaque-exif-control-id',
            sourceBytes: raw,
            targetTaskText: 'a visible sign',
          },
          { profileId: PROFILE_CONTROL_ID, reservedUsdPerFetch: 0.12, ledger },
        ),
        /frozen upright-image loader/u,
      )
      assert.equal(segmenterCalls, 0)
      assert.equal(fetchCalls, 0)
      assert.equal(ledger.snapshot().physicalDispatchCount, 0)
      assert.equal(ledger.snapshot().inFlightReservations.length, 0)
      assert.equal(digest(raw), originalDigest)
    } finally {
      await runtimePorts.dispose()
    }
  } finally {
    raw.fill(0)
    await rm(root, { recursive: true, force: true })
  }
})

await test('control passes upright JPEG bytes unchanged through the frozen loader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-upright-control-'))
  const raw = await sharp({
    create: { width: 19, height: 53, channels: 3, background: { r: 40, g: 60, b: 80 } },
  })
    .jpeg()
    .toBuffer()
  const originalDigest = digest(raw)
  let observed: { width: number; height: number } | undefined
  const candidateRuntime: CandidateRuntimePort = {
    async run() {
      return { status: 'unknown' as const, reason: 'fixture' }
    },
    async dispose() {},
  }
  const segmenter: SegmentationPort = {
    async segment(input) {
      observed = { width: input.image.width, height: input.image.height }
      const pixels = maskBytes(input.image.width, input.image.height, {
        left: 0,
        top: 0,
        width: input.image.width,
        height: input.image.height,
      })
      return {
        status: 'segmented' as const,
        mask: {
          data: pixels,
          width: input.image.width,
          height: input.image.height,
          format: 'binary-u8' as const,
        },
        metadata: {
          method: 'mobile-sam-seed-region-v1',
          backend: 'mobile-sam',
          durationMs: 1,
          input: { width: input.image.width, height: input.image.height },
        },
      }
    },
    async settle() {},
    async dispose() {},
  }
  try {
    const options = fixtureOptions(
      root,
      async (_url, init) => alphaReply(JSON.parse(String(init?.body))),
      candidateRuntime,
      segmenter,
    )
    options.sourceCanvasByOpaqueCaseId = new Map([
      ['opaque-upright-jpeg-control-id', { width: 19, height: 53 }],
    ])
    const runtimePorts = await createH8FreshRuntimePortsForOfflineFixture(options)
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    try {
      const result = await runtimePorts.controlPort.execute(
        {
          opaqueCaseId: 'opaque-upright-jpeg-control-id',
          sourceBytes: raw,
          targetTaskText: 'a visible sign',
        },
        { profileId: PROFILE_CONTROL_ID, reservedUsdPerFetch: 0.12, ledger },
      )
      assert.deepEqual(observed, { width: 19, height: 53 })
      assert.equal(result.outputRow.caseState, 'success')
      const cutout = runtimePorts.artifacts.cutoutsByProfileAndCase.get(
        `${PROFILE_CONTROL_ID}:opaque-upright-jpeg-control-id`,
      )
      assert.equal(cutout?.format, 'png')
      assert.equal(digest(cutout?.bytes ?? new Uint8Array()), cutout?.sha256)
      const reopenedCutout = await readFile(cutout!.path)
      assert.equal(reopenedCutout.byteLength, cutout?.bytes.byteLength)
      assert.equal(digest(reopenedCutout), cutout?.sha256)
      assert.equal(digest(raw), originalDigest)
      assert.ok(ledger.snapshot().physicalDispatchCount > 0)
    } finally {
      await runtimePorts.dispose()
    }
  } finally {
    raw.fill(0)
    await rm(root, { recursive: true, force: true })
  }
})

await test('decision adapter preflight failure creates no physical ledger call', async () => {
  await withFixtureRoot(async (root) => {
    let calls = 0
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const boundary = createCampaignFetchBoundary({
      ledger,
      reservedUsd: 0.55,
      profileId: PROFILE_CANDIDATE_ID,
      opaqueCaseId: 'boundary-fixture-case',
      caseExecutionIdentitySha256: digest('boundary-case-identity'),
      endpoint: '/api/v1/chat/completions',
      journalDirectory: join(root, 'journal'),
      baseFetch: async () => {
        calls++
        return visionReply('openai/gpt-6-luna')
      },
      readCurrentProviderCall: () => undefined,
    })
    let rejected = false
    try {
      await boundary.fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'openai/gpt-6-luna' }),
      })
    } catch {
      rejected = true
    }
    assert.equal(rejected, true)
    assert.equal(calls, 0)
    assert.equal(ledger.snapshot().physicalDispatchCount, 0)
    assert.equal(boundary.entries.length, 0)
  })
})

await test('chat provider refusal becomes geometry-free unknown only with explicit freeze policy', async () => {
  await withFixtureRoot(async (root, source) => {
    let fetchCalls = 0
    const fetch = async () => {
      fetchCalls++
      return response({
        id: 'offline-refusal',
        model: 'openai/gpt-6-luna',
        provider: 'OpenAI',
        choices: [{ index: 0, finish_reason: 'stop', message: { refusal: 'test marker' } }],
      })
    }
    const candidateRuntime: CandidateRuntimePort = {
      async run(input) {
        await input.decision.decide(
          {
            state: ['controlled request fixture'],
            questions: {
              selection: {
                type: 'choice',
                rankingSize: 1,
                instructions: 'Choose one option.',
                criteria: { visible: 'Visible.', absent: 'Absent.' },
              },
            },
          },
          input.signal,
        )
        throw new Error('Adapter unexpectedly accepted a refusal')
      },
      async dispose() {},
    }
    const emptySegmenter: SegmentationPort = {
      async segment() {
        return {
          status: 'unknown',
          reason: 'unused',
          metadata: {
            method: 'fixture',
            backend: 'fixture',
            durationMs: 0,
            input: { width: 1, height: 1 },
          },
        }
      },
      async settle() {},
      async dispose() {},
    }
    const runtimePorts = await createH8FreshRuntimePortsForOfflineFixture(
      fixtureOptions(root, fetch, candidateRuntime, emptySegmenter),
    )
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const artifactStore = new ImmutableCaseArtifactStore(join(root, 'case-store'))
    const identity = {
      freezeCommitmentSha256: digest('freeze'),
      sourceManifestSha256: digest('source-manifest'),
      recipeIdentitySha256: digest('recipe'),
      requestPolicyIdentitySha256: digest('request-policy'),
      pairedScheduleSha256: digest('schedule'),
      selectionCommitmentSha256: digest('selection'),
      opaqueCaseId: 'opaque-local-route-id',
      profileId: PROFILE_CANDIDATE_ID,
      sourceBytesSha256: digest(source),
      targetTaskSha256: digest('the authored visible sign'),
      sourceCanvasWidth: 64,
      sourceCanvasHeight: 48,
      executionPolicySha256: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY.policySha256,
    }
    const identityRecord = artifactStore.identity(identity)
    const startedAtIso = '2026-11-01T10:00:00.000Z'
    await artifactStore.begin(identity, startedAtIso)
    try {
      const result = await runtimePorts.candidatePort.execute(
        {
          opaqueCaseId: 'opaque-local-route-id',
          sourceBytes: source,
          targetTaskText: 'the authored visible sign',
        },
        {
          profileId: PROFILE_CANDIDATE_ID,
          reservedUsdPerFetch: 0.55,
          ledger,
          caseExecutionIdentitySha256: identityRecord.sha256,
          executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
        },
      )
      assert.equal(fetchCalls, 1)
      assert.equal(result.outputRow.caseState, 'unknown')
      assert.equal(result.outputRow.box, null)
      assert.equal(result.outputRow.cutoutPresent, false)
      assert.equal(result.outputRow.maskPackedSha256, null)
      assert.equal(
        result.outputRow.providerRefusalEvidence?.protocol,
        'openrouter-chat-message-refusal-v1',
      )
      assert.equal(result.logicalReceipts[0]?.outcome, 'failed')
      assert.equal(result.logicalReceipts[0]?.errorCode, 'INVALID_RESPONSE')
      assert.equal(result.physicalReceipts[0]?.chargeState, 'unknown')
      assert.equal(result.physicalReceipts[0]?.settled, true)
      assert.equal(ledger.snapshot().unknownReserveUsd, 0.55)
      await artifactStore.complete({
        identitySha256: identityRecord.sha256,
        result,
        durationMs: 1,
        startedAtIso,
        completedAtIso: '2026-11-01T10:00:00.001Z',
        knownCostUsd: 0,
        unknownDispatchCount: 1,
        identity,
        blobs: new Map(),
      })
      const reopened = await artifactStore.load(identityRecord.sha256, identity)
      assert.equal(
        reopened?.result.outputRow.providerRefusalEvidence?.requestBodySha256,
        result.outputRow.providerRefusalEvidence?.requestBodySha256,
      )

      const defaultPorts = await createH8FreshRuntimePortsForOfflineFixture(
        fixtureOptions(join(root, 'default-run'), fetch, candidateRuntime, emptySegmenter),
      )
      const defaultLedger = await CampaignLedger.open(join(root, 'default-ledger.json'))
      try {
        const defaultResult = await defaultPorts.candidatePort.execute(
          {
            opaqueCaseId: 'opaque-local-route-id',
            sourceBytes: source,
            targetTaskText: 'the authored visible sign',
          },
          { profileId: PROFILE_CANDIDATE_ID, reservedUsdPerFetch: 0.55, ledger: defaultLedger },
        )
        assert.equal(fetchCalls, 2, JSON.stringify(defaultResult))
        assert.equal(defaultResult.outputRow.caseState, 'error')
        assert.equal(defaultResult.outputRow.providerRefusalEvidence, undefined)
        assert.equal(defaultResult.logicalReceipts[0]?.errorCode, 'INVALID_RESPONSE')
      } finally {
        await defaultPorts.dispose()
      }
    } finally {
      await runtimePorts.dispose()
    }
  })
})

await test('native named 502 refusal becomes unknown only after bound journal and cleanup', async () => {
  await withFixtureRoot(async (root, source) => {
    let fetchCalls = 0
    const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls++
      const request = z
        .object({ questions: z.record(z.unknown()) })
        .passthrough()
        .parse(JSON.parse(String(init?.body)) as unknown)
      if (fetchCalls < 3) return alphaReply(request, 0.001)
      const questionId = Object.keys(request.questions)[0]
      assert.ok(questionId)
      return new Response(
        JSON.stringify({
          error: { code: 502, message: `OpenAI refused to answer question "${questionId}"` },
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const candidateRuntime: CandidateRuntimePort = {
      async run() {
        return { status: 'unknown' as const, reason: 'native test does not use candidate' }
      },
      async dispose() {},
    }
    const segmenter: SegmentationPort = {
      async segment(input) {
        const pixels = maskBytes(input.image.width, input.image.height, {
          left: 0,
          top: 0,
          width: input.image.width,
          height: input.image.height,
        })
        return {
          status: 'segmented' as const,
          mask: {
            data: pixels,
            width: input.image.width,
            height: input.image.height,
            format: 'binary-u8' as const,
          },
          metadata: {
            method: 'mobile-sam-seed-region-v1',
            backend: 'mobile-sam',
            durationMs: 1,
            input: { width: input.image.width, height: input.image.height },
          },
        }
      },
      async settle() {},
      async dispose() {},
    }
    const runtimePorts = await createH8FreshRuntimePortsForOfflineFixture(
      fixtureOptions(root, fetch, candidateRuntime, segmenter),
    )
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    try {
      const result = await runtimePorts.controlPort.execute(
        {
          opaqueCaseId: 'opaque-control-route-id',
          sourceBytes: source,
          targetTaskText: 'the authored visible sign',
        },
        {
          profileId: PROFILE_CONTROL_ID,
          reservedUsdPerFetch: 0.12,
          ledger,
          executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
        },
      )
      assert.equal(fetchCalls, 3)
      assert.equal(result.outputRow.caseState, 'unknown')
      assert.equal(
        result.outputRow.providerRefusalEvidence?.protocol,
        'openrouter-native-named-refusal-v1',
      )
      assert.equal(result.outputRow.providerRefusalEvidence?.responseStatus, 502)
      assert.equal(result.logicalReceipts.at(-1)?.outcome, 'failed')
      assert.equal(result.logicalReceipts.at(-1)?.errorCode, 'PROVIDER')
      assert.equal(result.physicalReceipts.at(-1)?.settled, true)
      assert.equal(result.physicalReceipts.at(-1)?.chargeState, 'unknown')
      assert.equal(result.logicalReceipts.length, 3)
      assert.deepEqual(
        result.logicalReceipts.slice(0, 2).map((receipt) => receipt.outcome),
        ['resolved', 'resolved'],
      )
      assert.equal(ledger.snapshot().unknownReserveUsd, 0.12)
      assert.equal(ledger.snapshot().inFlightReservations.length, 0)
    } finally {
      await runtimePorts.dispose()
    }
  })
})

await test('single named native typed refusal at HTTP 200 is bound to its requested question', async () => {
  await withFixtureRoot(async (root, source) => {
    let fetchCalls = 0
    const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls++
      const request = z
        .object({ questions: z.record(z.unknown()) })
        .passthrough()
        .parse(JSON.parse(String(init?.body)) as unknown)
      const questionId = Object.keys(request.questions)[0]
      assert.ok(questionId)
      return response({
        model: 'openai/gpt-6-luna-decisions',
        provider: 'OpenAI',
        answers: [{ type: 'refusal', name: questionId }],
      })
    }
    const candidateRuntime: CandidateRuntimePort = {
      async run() {
        return { status: 'unknown' as const, reason: 'native test does not use candidate' }
      },
      async dispose() {},
    }
    const segmenter: SegmentationPort = {
      async segment() {
        throw new Error('Refusal should stop before segmentation')
      },
      async settle() {},
      async dispose() {},
    }
    const runtimePorts = await createH8FreshRuntimePortsForOfflineFixture(
      fixtureOptions(root, fetch, candidateRuntime, segmenter),
    )
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    try {
      const result = await runtimePorts.controlPort.execute(
        {
          opaqueCaseId: 'opaque-control-route-id',
          sourceBytes: source,
          targetTaskText: 'the authored visible sign',
        },
        {
          profileId: PROFILE_CONTROL_ID,
          reservedUsdPerFetch: 0.12,
          ledger,
          executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
        },
      )
      assert.equal(fetchCalls, 1)
      assert.equal(result.outputRow.caseState, 'unknown')
      assert.equal(
        result.outputRow.providerRefusalEvidence?.protocol,
        'openrouter-native-named-refusal-v1',
      )
      assert.equal(result.outputRow.providerRefusalEvidence?.responseStatus, 200)
      assert.equal(result.outputRow.providerRefusalEvidence?.scope, 'question')
      assert.equal(result.logicalReceipts[0]?.outcome, 'failed')
      assert.equal(result.logicalReceipts[0]?.errorCode, 'INVALID_RESPONSE')
      assert.equal(result.physicalReceipts[0]?.settled, true)
    } finally {
      await runtimePorts.dispose()
    }
  })
})

await test('cleanup failure keeps a captured native refusal technical with receipts intact', async () => {
  await withFixtureRoot(async (root, source) => {
    let fetchCalls = 0
    const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls++
      const request = z
        .object({ questions: z.record(z.unknown()) })
        .passthrough()
        .parse(JSON.parse(String(init?.body)) as unknown)
      const questionId = Object.keys(request.questions)[0]
      assert.ok(questionId)
      return new Response(
        JSON.stringify({
          error: { code: 502, message: `OpenAI refused to answer question "${questionId}"` },
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const candidateRuntime: CandidateRuntimePort = {
      async run() {
        return { status: 'unknown' as const, reason: 'fixture' }
      },
      async dispose() {},
    }
    const segmenter: SegmentationPort = {
      async segment() {
        throw new Error('Refusal should prevent segmentation')
      },
      async settle() {},
      async dispose() {},
    }
    const options = fixtureOptions(root, fetch, candidateRuntime, segmenter)
    if (options.controlEngine.kind !== 'offline-fixture-only')
      throw new TypeError('Expected offline test control engine')
    const kernel = options.controlEngine.processRegionSeededCase
    options.controlEngine = {
      ...options.controlEngine,
      async processRegionSeededCase(args) {
        const result = await kernel(args)
        await rm(args.root, { recursive: true, force: false })
        return result
      },
    }
    const runtimePorts = await createH8FreshRuntimePortsForOfflineFixture(options)
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    try {
      const result = await runtimePorts.controlPort.execute(
        {
          opaqueCaseId: 'opaque-control-route-id',
          sourceBytes: source,
          targetTaskText: 'the authored visible sign',
        },
        {
          profileId: PROFILE_CONTROL_ID,
          reservedUsdPerFetch: 0.12,
          ledger,
          executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
        },
      )
      assert.equal(fetchCalls, 1)
      assert.equal(result.outputRow.caseState, 'error')
      assert.equal(result.outputRow.providerRefusalEvidence, undefined)
      assert.equal(result.logicalReceipts[0]?.outcome, 'failed')
      assert.equal(result.logicalReceipts[0]?.errorCode, 'PROVIDER')
      assert.equal(result.physicalReceipts[0]?.dispatchState, 'confirmed')
      assert.equal(result.physicalReceipts[0]?.settled, true)
      assert.equal(ledger.snapshot().physicalDispatchCount, 1)
    } finally {
      await runtimePorts.dispose()
    }
  })
})

await test('cleanup failure after successful control artifacts clears sidecars and returns technical receipts', async () => {
  await withFixtureRoot(async (root, source) => {
    let fetchCalls = 0
    const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls++
      return alphaReply(JSON.parse(String(init?.body)) as unknown, 0.001)
    }
    const candidateRuntime: CandidateRuntimePort = {
      async run() {
        return { status: 'unknown' as const, reason: 'fixture' }
      },
      async dispose() {},
    }
    const segmenter: SegmentationPort = {
      async segment(input) {
        const pixels = maskBytes(input.image.width, input.image.height, {
          left: 0,
          top: 0,
          width: input.image.width,
          height: input.image.height,
        })
        return {
          status: 'segmented' as const,
          mask: {
            data: pixels,
            width: input.image.width,
            height: input.image.height,
            format: 'binary-u8' as const,
          },
          metadata: {
            method: 'mobile-sam-seed-region-v1',
            backend: 'mobile-sam',
            durationMs: 1,
            input: { width: input.image.width, height: input.image.height },
          },
        }
      },
      async settle() {},
      async dispose() {},
    }
    const options = fixtureOptions(root, fetch, candidateRuntime, segmenter)
    options.removeTemporaryCaseRoot = async () => {
      throw new Error('controlled cleanup fault')
    }
    const runtimePorts = await createH8FreshRuntimePortsForOfflineFixture(options)
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    try {
      const result = await runtimePorts.controlPort.execute(
        {
          opaqueCaseId: 'opaque-control-route-id',
          sourceBytes: source,
          targetTaskText: 'the authored visible sign',
        },
        {
          profileId: PROFILE_CONTROL_ID,
          reservedUsdPerFetch: 0.12,
          ledger,
          executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
        },
      )
      assert.ok(fetchCalls > 0)
      assert.ok(
        runtimePorts.artifacts.cutoutsByProfileAndCase.has(
          `${PROFILE_CONTROL_ID}:opaque-control-route-id`,
        ),
      )
      assert.equal(result.outputRow.caseState, 'error')
      assert.equal(result.outputRow.box, null)
      assert.equal(result.outputRow.cutoutPresent, false)
      assert.equal(result.outputRow.maskPackedSha256, null)
      assert.equal(result.outputRow.providerRefusalEvidence, undefined)
      assert.equal(result.caseArtifactSidecars?.length ?? 0, 0)
      assert.ok(result.physicalReceipts.length > 0)
      assert.ok(result.physicalReceipts.every((receipt) => receipt.settled))
      assert.match(result.caseError ?? '', /controlled cleanup fault/u)
    } finally {
      await runtimePorts.dispose()
    }
  })
})
