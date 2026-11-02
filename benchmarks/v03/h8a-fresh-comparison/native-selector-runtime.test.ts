import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import test from 'node:test'
import { z } from 'zod'
import type { DecisionPort, DecisionRequest } from '../../../src/entities/contracts.js'
import { ClassifierError } from '../../../src/entities/errors.js'
import type { SegmentationPort } from '../../../src/entities/segmentation.js'
import { createH6ContextComposer, createSharpH6Presentation } from '../h6-context-composer.js'
import { PROFILE_FLAT_CANDIDATE_ID, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID } from './constants.js'
import { CampaignLedger } from './campaign-ledger.js'
import type { CandidateRuntimePort, OfflineFixtureRuntimePortOptions } from './runtime-ports.js'
import {
  createH8FreshRuntimePortsForOfflineFixture,
  type CandidateRuntimeBinding,
} from './runtime-ports.js'
import { assertRecorderHealthy, processRegionSeededCase } from '../../v02/region-seeded-runner.js'
import { createClassifier } from '../../../src/app/create-classifier.js'
import { createOpenRouterDecisions } from '../../../src/openrouter.js'
import { packBinaryLsb0V1 } from './packed-binary-lsb0.js'
import { nativeSelectorRuntimeFactoryOptions } from './native-selector-runtime-binding.js'
import type { Recorder } from '../../v02/recording.js'

const digest = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex')
const MODEL = 'openai/gpt-6-luna-decisions'
const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
const presenceDecisionRequest: DecisionRequest = {
  state: [],
  questions: {
    selection: {
      type: 'choice',
      rankingSize: 1,
      instructions: 'Choose whether the target is present.',
      criteria: {
        present: 'The target is visible.',
        absent: 'The target is absent.',
      },
    },
  },
}
const recordedRequestSchema = z
  .object({
    model: z.string(),
    provider: z.object({ only: z.array(z.string()), allow_fallbacks: z.boolean() }).strict(),
    state: z.array(
      z.union([
        z.string(),
        z
          .object({
            type: z.literal('image_url'),
            image_url: z.object({ url: z.string(), detail: z.literal('high') }).strict(),
          })
          .strict(),
      ]),
    ),
    questions: z.record(
      z.string(),
      z
        .object({
          type: z.literal('choice'),
          rankingSize: z.union([z.literal(1), z.literal(4)]).optional(),
          instructions: z.string(),
          criteria: z.record(z.string(), z.string()),
        })
        .strict(),
    ),
  })
  .strict()
type RecordedRequest = z.infer<typeof recordedRequestSchema>
const nativeWireEvidenceSchema = z
  .object({
    schema: z.literal('h8a-native-selector-wire-evidence-v1'),
    responseSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    responseByteLength: z.number().int().positive(),
    questions: z.array(
      z
        .object({
          questionId: z.enum(['selection', 'presence']),
          validity: z.enum(['valid', 'missing', 'invalid']),
          scores: z.array(z.object({ value: z.number().finite() }).passthrough()),
        })
        .passthrough(),
    ),
  })
  .passthrough()

await test('v5 sends H6 presence, nominations and final selection through one capped public native route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-selector-v5-'))
  const source = await sharp({
    create: { width: 64, height: 48, channels: 4, background: { r: 90, g: 70, b: 40, alpha: 1 } },
  })
    .png()
    .toBuffer()
  const calls: Array<{ url: string; body: RecordedRequest }> = []
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    const raw = String(init?.body ?? '')
    const body = recordedRequestSchema.parse(JSON.parse(raw))
    calls.push({ url, body })
    const questions = body.questions
    const answers = Object.fromEntries(
      Object.entries(questions).map(([questionId, question]) => {
        const keys = Object.keys(question.criteria)
        const choice = keys[0]!
        const score = 1 / keys.length
        return [
          questionId,
          {
            type: 'choice',
            choice,
            probabilities: Object.fromEntries([...keys].reverse().map((key) => [key, score])),
          },
        ]
      }),
    )
    return new Response(
      JSON.stringify({ id: 'controlled-native', model: MODEL, provider: 'OpenAI', answers }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }

  const candidateRuntime: CandidateRuntimePort = {
    async run(input) {
      const decoded = await sharp(input.encodedImage)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const width = decoded.info.width
      const height = decoded.info.height
      const candidates = (family: 'D' | 'U') =>
        Array.from({ length: 5 }, (_, index) => {
          const pixels = new Uint8Array(width * height)
          const left = 5 + index * 8
          for (let y = 7; y < 14; y++) pixels.fill(1, y * width + left, y * width + left + 5)
          return {
            id: `${family}${String(index).padStart(2, '0')}`,
            family,
            mask: {
              format: 'binary-lsb0' as const,
              width,
              height,
              data: new Uint8Array(packBinaryLsb0V1(width, height, pixels)),
            },
          }
        })
      const composer = createH6ContextComposer({
        decision: input.decision,
        ...(input.presenceDecision ? { presenceDecision: input.presenceDecision } : {}),
        imageState: input.imageState,
        presentation: createSharpH6Presentation(),
        queryPolicyId: 'strict-authored-scope-v1',
        presencePolicyId: 'control-binary-v1',
        budgetRecord: { admit() {}, settle() {} },
      })
      const composed = await composer.compose({
        image: { data: new Uint8Array(decoded.data), width, height, format: 'rgba8' },
        target: input.authoredTarget,
        exclusions: [],
        families: { D: candidates('D'), U: candidates('U') },
        signal: input.signal,
      })
      assert.equal(composed.status, 'located')
      if (composed.status !== 'located') throw new Error('fixture unexpectedly failed selection')
      assert.deepEqual(composed.presence.selection.probabilities, { present: 0.5, absent: 0.5 })
      assert.equal(composed.presence.selection.probabilityRoundingStep, undefined)
      assert.deepEqual(
        composed.nominations.map((item) => item.topFour),
        [
          ['D00', 'D01', 'D02', 'D03'],
          ['U00', 'U01', 'U02', 'U03'],
        ],
      )
      assert.deepEqual(composed.nominations[0]?.selection.probabilities, {
        D00: 1 / 6,
        D01: 1 / 6,
        D02: 1 / 6,
        D03: 1 / 6,
        D04: 1 / 6,
        none: 1 / 6,
      })
      assert.equal(composed.nominations[0]?.selection.probabilityRoundingStep, undefined)
      assert.equal(composed.finalSelection.choice, 'D00')
      assert.equal(composed.finalSelection.probabilityRoundingStep, undefined)
      assert.equal(Object.values(composed.finalSelection.probabilities ?? {}).length, 9)
      assert.ok(
        Object.values(composed.finalSelection.probabilities ?? {}).every(
          (score) => score === 1 / 9,
        ),
      )

      const request: DecisionRequest = {
        state: ['selector-cap-probe'],
        questions: {
          selection: {
            type: 'choice',
            rankingSize: 1,
            instructions: 'Choose the supplied closed label.',
            criteria: {
              probe: 'The supplied probe label.',
              other: 'The other supplied label.',
            },
          },
        },
      }
      await assert.rejects(
        input.decision.decide(request, input.signal),
        (error: unknown) => error instanceof ClassifierError && error.code === 'PROVIDER',
      )

      const originalSourceSha256 = digest(input.encodedImage)
      return {
        recipeId: PROFILE_FLAT_CANDIDATE_ID,
        status: 'located' as const,
        family: composed.family,
        alias: composed.alias,
        sourceAlias: composed.sourceAlias,
        originalEncodedSha256: originalSourceSha256,
        sourceFrame: { sha256: originalSourceSha256, width, height },
        mask: {
          format: 'binary-lsb0' as const,
          width,
          height,
          data: new Uint8Array(composed.mask.data),
        },
        region: { ...composed.region },
        center: {
          x: composed.region.left + composed.region.width / 2,
          y: composed.region.top + composed.region.height / 2,
        },
      }
    },
    async dispose() {},
  }
  const unusedSegmenter: SegmentationPort = {
    async segment() {
      return {
        status: 'unknown',
        reason: 'unused in candidate route',
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
  const selectorRuntime = nativeSelectorRuntimeFactoryOptions()
  const options: OfflineFixtureRuntimePortOptions = {
    apiKey: 'offline-fixture-key',
    artifactRoot: join(root, 'artifacts'),
    temporaryRoot: join(root, 'temporary'),
    maskArtifactDirectory: join(root, 'masks'),
    cutoutArtifactDirectory: join(root, 'cutouts'),
    nativeRuntime: {
      pythonExecutable: 'unused',
      assetRoot: join(root, 'assets-not-opened'),
      ...selectorRuntime.nativeRuntime,
    },
    selectionPolicyId: selectorRuntime.selectionPolicyId,
    candidateProfileId: selectorRuntime.candidateProfileId,
    mobileSam: {
      encoderPath: join(root, 'unused-encoder'),
      decoderPath: join(root, 'unused-decoder'),
    },
    sourceCanvasByOpaqueCaseId: new Map([['selector-case', { width: 64, height: 48 }]]),
    controlEngine: {
      kind: 'offline-fixture-only',
      processRegionSeededCase,
      assertRecorderHealthy,
      createClassifier,
      createOpenRouterDecisions,
      createNativeCategoricalPresencePort(_nativePort: DecisionPort) {
        throw new Error('historical control native factory must not be consulted by v5')
      },
      createControlSegmenter: () => unusedSegmenter,
    },
    fetch: fetcher,
    createCandidateRuntime(recipeId, binding: CandidateRuntimeBinding) {
      assert.equal(recipeId, PROFILE_FLAT_CANDIDATE_ID)
      assert.deepEqual(binding, {
        candidateProfileId: selectorRuntime.candidateProfileId,
        ...selectorRuntime.nativeRuntime,
        selectionPolicyId: selectorRuntime.selectionPolicyId,
      })
      return candidateRuntime
    },
  }

  try {
    Reflect.deleteProperty(options, 'selectionPolicyId')
    await assert.rejects(
      createH8FreshRuntimePortsForOfflineFixture(options),
      /Native-selector profile requires/u,
    )
    Reflect.set(options, 'selectionPolicyId', 'native-categorical-all-stages-v1')
    Reflect.set(options, 'nativeRuntime', {
      ...options.nativeRuntime,
      queryPolicyId: 'legacy-v1',
    })
    await assert.rejects(
      createH8FreshRuntimePortsForOfflineFixture(options),
      /Native-selector profile requires/u,
    )
    Reflect.set(options, 'nativeRuntime', {
      ...options.nativeRuntime,
      queryPolicyId: 'strict-authored-scope-v1',
    })
    Reflect.set(options, 'selectionPolicyId', 'wrong-selector-policy')
    await assert.rejects(
      createH8FreshRuntimePortsForOfflineFixture(options),
      /Native-selector profile requires/u,
    )
    let selectorPolicyReads = 0
    Object.defineProperty(options, 'selectionPolicyId', {
      configurable: true,
      enumerable: true,
      get() {
        selectorPolicyReads++
        return 'native-categorical-all-stages-v1'
      },
    })
    const ports = await createH8FreshRuntimePortsForOfflineFixture(options)
    assert.equal(selectorPolicyReads, 1)
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    try {
      const result = await ports.candidatePort.execute(
        {
          opaqueCaseId: 'selector-case',
          sourceBytes: source,
          targetTaskText: 'the visible target',
        },
        { profileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID, reservedUsdPerFetch: 0.12, ledger },
      )
      assert.equal(result.outputRow.caseState, 'success', result.caseError)
      assert.deepEqual(result.outputRow.box, { left: 5, top: 7, width: 5, height: 7 })
      assert.equal(calls.length, 4)
      assert.deepEqual(
        calls.map(({ url }) => url),
        Array(4).fill(ENDPOINT),
      )
      for (const { body } of calls) {
        assert.equal(body.model, MODEL)
        assert.deepEqual(body.provider, { only: ['openai'], allow_fallbacks: false })
        const state = body.state
        assert.ok(
          state.some((part) => typeof part === 'string' && part.includes('sourceImageTransform')),
        )
        const images = state.filter((part) => typeof part !== 'string')
        assert.ok(images.length > 0)
        assert.ok(images.every((part) => part.image_url.url.startsWith('data:image/png;base64,')))
      }
      const questionCounts = calls.map(({ body }) => Object.keys(body.questions).length)
      assert.deepEqual(questionCounts, [1, 1, 1, 1])
      const transformedStates = calls.map(({ body }) =>
        body.state.find(
          (part): part is string =>
            typeof part === 'string' && part.includes('sourceImageTransform'),
        ),
      )
      assert.ok(
        transformedStates.every((value) => value?.includes('"source":{"width":64,"height":48}')),
      )
      assert.equal(ledger.snapshot().physicalDispatchCount, 4)
      assert.equal(result.logicalReceipts.length, 5)
      assert.equal(result.physicalReceipts.length, 4)
      assert.deepEqual(
        result.physicalReceipts.map((receipt) => receipt.logicalId),
        [1, 2, 3, 4],
      )
      assert.equal(result.logicalReceipts[4]?.outcome, 'preflight_failed')
      const receiptDirectories = await readdir(join(root, 'artifacts', 'provider-receipts'), {
        withFileTypes: true,
      })
      const wireEvidence: z.infer<typeof nativeWireEvidenceSchema>[] = []
      for (const directory of receiptDirectories) {
        if (!directory.isDirectory()) continue
        for (const name of await readdir(
          join(root, 'artifacts', 'provider-receipts', directory.name),
        )) {
          if (!name.startsWith('native-wire-')) continue
          wireEvidence.push(
            nativeWireEvidenceSchema.parse(
              JSON.parse(
                await readFile(
                  join(root, 'artifacts', 'provider-receipts', directory.name, name),
                  'utf8',
                ),
              ),
            ),
          )
        }
      }
      assert.equal(wireEvidence.length, 4)
      assert.ok(
        wireEvidence.every((item) => item.schema === 'h8a-native-selector-wire-evidence-v1'),
      )
      assert.ok(wireEvidence.every((item) => /^[a-f0-9]{64}$/u.test(item.responseSha256)))
      assert.ok(wireEvidence.every((item) => item.responseByteLength > 0))
      assert.ok(wireEvidence.every((item) => item.questions.length === 1))
      assert.ok(wireEvidence.every((item) => item.questions[0]?.validity === 'valid'))
    } finally {
      await ports.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function selectorProbeRuntime(): CandidateRuntimePort {
  return {
    async run(input) {
      if (!input.presenceDecision) throw new Error('v5 presence decision port was not injected')
      const state = await input.imageState(
        { bytes: input.encodedImage, width: 64, height: 48 },
        input.signal,
      )
      const request: DecisionRequest = { ...presenceDecisionRequest, state }
      const result = await input.presenceDecision.decide(request, input.signal)
      const answer = result.answers.selection
      if (answer?.type !== 'choice') throw new Error('native presence returned the wrong answer')
      return {
        recipeId: PROFILE_FLAT_CANDIDATE_ID,
        status: 'unknown',
        reason: answer.choice === 'absent' ? 'target-absent' : 'probe-ended',
      }
    },
    async dispose() {},
  }
}

await test('v5 absent, invalid native mass and cancellation retain one-route physical evidence', async () => {
  for (const scenario of [
    'absent',
    'invalid-mass',
    'cancel-pending',
    'wire-persistence-failure',
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), `native-selector-v5-${scenario}-`))
    const source = await sharp({
      create: { width: 64, height: 48, channels: 4, background: { r: 30, g: 40, b: 50, alpha: 1 } },
    })
      .png()
      .toBuffer()
    let fetchCalls = 0
    let markStarted: (() => void) | undefined
    let resolveFetch: ((response: Response) => void) | undefined
    const fetchStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    const fetcher: typeof globalThis.fetch = async (input, init) => {
      fetchCalls++
      assert.equal(String(input), ENDPOINT)
      const body = recordedRequestSchema.parse(JSON.parse(String(init?.body ?? '')))
      assert.equal(body.model, MODEL)
      if (scenario === 'cancel-pending') {
        markStarted?.()
        return pendingFetch
      }
      const probabilities =
        scenario === 'absent' || scenario === 'wire-persistence-failure'
          ? { present: 0, absent: 1 }
          : { present: 0.25, absent: 0.25 }
      return new Response(
        JSON.stringify({
          id: `controlled-${scenario}`,
          model: MODEL,
          provider: 'OpenAI',
          usage: {
            cost:
              scenario === 'invalid-mass' || scenario === 'wire-persistence-failure' ? 0.06 : 0.01,
          },
          answers: {
            selection: {
              type: 'choice',
              choice:
                scenario === 'absent' || scenario === 'wire-persistence-failure'
                  ? 'absent'
                  : 'present',
              probabilities,
            },
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }
    const unusedSegmenter: SegmentationPort = {
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
    const candidateRuntime = selectorProbeRuntime()
    const fixedReceiptDirectory = join(root, 'artifacts', 'provider-receipts', 'wire-failure')
    let runtimeRecorder: Recorder | undefined
    let recorderHookCalls = 0
    if (scenario === 'wire-persistence-failure') {
      await mkdir(fixedReceiptDirectory, { recursive: true })
      await writeFile(
        join(fixedReceiptDirectory, 'native-wire-1.json'),
        'preexisting immutable receipt\n',
        { flag: 'wx' },
      )
    }
    const options: OfflineFixtureRuntimePortOptions = {
      apiKey: 'offline-fixture-key',
      artifactRoot: join(root, 'artifacts'),
      temporaryRoot: join(root, 'temporary'),
      maskArtifactDirectory: join(root, 'masks'),
      cutoutArtifactDirectory: join(root, 'cutouts'),
      nativeRuntime: {
        pythonExecutable: 'unused',
        assetRoot: join(root, 'assets-not-opened'),
        recipeId: PROFILE_FLAT_CANDIDATE_ID,
        queryPolicyId: 'strict-authored-scope-v1',
        presencePolicyId: 'control-binary-v1',
      },
      selectionPolicyId: 'native-categorical-all-stages-v1',
      candidateProfileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
      mobileSam: { encoderPath: 'unused', decoderPath: 'unused' },
      sourceCanvasByOpaqueCaseId: new Map([[scenario, { width: 64, height: 48 }]]),
      controlEngine: {
        kind: 'offline-fixture-only',
        processRegionSeededCase,
        assertRecorderHealthy,
        createClassifier,
        createOpenRouterDecisions,
        createNativeCategoricalPresencePort(_nativePort: DecisionPort) {
          throw new Error('historical control native factory must not be consulted by v5')
        },
        createControlSegmenter: () => unusedSegmenter,
      },
      fetch: fetcher,
      ...(scenario === 'wire-persistence-failure'
        ? {
            receiptDirectoryForTest: () => fixedReceiptDirectory,
            recorderForTest: (_caseId, _route, recorder) => {
              recorderHookCalls++
              runtimeRecorder = recorder
            },
          }
        : {}),
      createCandidateRuntime: () => candidateRuntime,
    }
    const ports = await createH8FreshRuntimePortsForOfflineFixture(options)
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const controller = new AbortController()
    try {
      if (scenario === 'cancel-pending') {
        let settled = false
        const running = ports.candidatePort
          .execute(
            { opaqueCaseId: scenario, sourceBytes: source, targetTaskText: 'the visible target' },
            {
              profileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
              reservedUsdPerFetch: 0.12,
              ledger,
              signal: controller.signal,
            },
          )
          .then(
            (value) => {
              settled = true
              return value
            },
            (error: unknown) => {
              settled = true
              throw error
            },
          )
        await fetchStarted
        controller.abort(new Error('controlled caller cancellation'))
        await new Promise((resolve) => setTimeout(resolve, 25))
        assert.equal(settled, false, 'execution must remain pending while physical fetch is open')
        resolveFetch?.(
          new Response(
            JSON.stringify({
              id: 'cancelled-native',
              model: MODEL,
              provider: 'OpenAI',
              answers: {
                selection: {
                  type: 'choice',
                  choice: 'present',
                  probabilities: { present: 1, absent: 0 },
                },
              },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        )
        const result = await running
        assert.equal(result.outputRow.caseState, 'cancelled')
        assert.equal(result.physicalReceipts.length, 1)
        assert.equal(result.physicalReceipts[0]?.settled, true)
        assert.equal(result.logicalReceipts[0]?.errorCode, 'ABORTED')
      } else {
        const result = await ports.candidatePort.execute(
          { opaqueCaseId: scenario, sourceBytes: source, targetTaskText: 'the visible target' },
          { profileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID, reservedUsdPerFetch: 0.12, ledger },
        )
        if (scenario === 'absent') {
          assert.equal(result.outputRow.caseState, 'not_found')
          assert.equal(result.physicalReceipts.length, 1)
          assert.equal(result.logicalReceipts.length, 1)
          assert.equal(fetchCalls, 1)
        } else {
          assert.equal(result.outputRow.caseState, 'error')
          assert.notEqual(result.outputRow.caseState, 'not_found')
          assert.equal(result.logicalReceipts[0]?.outcome, 'failed')
          assert.equal(result.physicalReceipts.length, 1)
          assert.equal(result.physicalReceipts[0]?.settled, true)
          assert.equal(fetchCalls, 1)
          if (scenario === 'invalid-mass') {
            assert.equal(result.logicalReceipts[0]?.errorCode, 'INVALID_RESPONSE')
          } else {
            assert.equal(result.logicalReceipts[0]?.errorCode, 'PROVIDER')
            assert.equal(
              recorderHookCalls,
              1,
              'offline recorder hook must reach the current public adapter',
            )
            assert.ok(runtimeRecorder)
            assert.equal(runtimeRecorder.calls.length, 1)
            assert.equal(runtimeRecorder.calls[0]?.httpStatus, 200)
            assert.equal(runtimeRecorder.calls[0]?.wireReceipt?.usageCostUsd, 0.06)
            assert.ok(
              runtimeRecorder.persistenceFailures?.some(
                (failure) =>
                  failure.stage === 'physical-http' && failure.errorCode === 'PERSISTENCE_ERROR',
              ),
              'native wire collision must be recorded as a persistence failure',
            )
            assert.equal(ledger.snapshot().knownCostUsd, 0.06)
            assert.equal(
              await readFile(join(fixedReceiptDirectory, 'native-wire-1.json'), 'utf8'),
              'preexisting immutable receipt\n',
            )
            const persisted = await readdir(fixedReceiptDirectory)
            assert.deepEqual(
              persisted.filter((name) => name === 'physical-http-1.json'),
              ['physical-http-1.json'],
            )
            assert.equal(persisted.filter((name) => name === 'native-wire-1.json').length, 1)
          }
          if (scenario === 'invalid-mass') {
            const receiptDirectories = await readdir(join(root, 'artifacts', 'provider-receipts'), {
              withFileTypes: true,
            })
            const evidencePath = receiptDirectories
              .filter((entry) => entry.isDirectory())
              .map((entry) =>
                join(root, 'artifacts', 'provider-receipts', entry.name, 'native-wire-1.json'),
              )
            let invalidEvidence: z.infer<typeof nativeWireEvidenceSchema> | undefined
            for (const path of evidencePath) {
              try {
                invalidEvidence = nativeWireEvidenceSchema.parse(
                  JSON.parse(await readFile(path, 'utf8')),
                )
                break
              } catch (error) {
                if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT'))
                  throw error
              }
            }
            assert.ok(invalidEvidence)
            assert.equal(invalidEvidence.questions[0]?.validity, 'invalid')
            assert.equal(invalidEvidence.questions[0]?.scores[0]?.value, 0.25)
            assert.equal(ledger.snapshot().knownCostUsd, 0.06)
          }
        }
      }
      assert.equal(ledger.snapshot().physicalDispatchCount, 1)
    } finally {
      await ports.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
})
