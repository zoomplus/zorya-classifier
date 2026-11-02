import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { DecisionPort, DecisionRequest } from '../../../src/entities/contracts.js'
import type { SegmentationPort } from '../../../src/entities/segmentation.js'
import { createClassifier } from '../../../src/app/create-classifier.js'
import { createOpenRouterDecisions } from '../../../src/openrouter.js'
import { assertRecorderHealthy, processRegionSeededCase } from '../../v02/region-seeded-runner.js'
import { nativeSelectorRuntimeFactoryOptions } from './native-selector-runtime-binding.js'
import {
  createH8FreshRuntimePortsForOfflineFixture,
  type CandidateRuntimePort,
} from './runtime-ports.js'
import { hashIdentity } from './hash-identity.js'
import { PROFILE_FLAT_CANDIDATE_ID } from './constants.js'
import {
  assertNativeSelectorQualExecutionPolicyInheritance,
  isVerifiedNativeSelectorQualAdmission,
  nativeSelectorQualAdmissionSnapshot,
} from './native-selector-qual-admission.js'
import {
  assembleNativeSelectorQualCloseouts,
  buildNativeSelectorQualCaseArtifactIdentity,
  runNativeSelectorQual120,
} from './native-selector-qual-runner.js'
import { PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY } from './provider-refusal-replay.js'
import type { H8aFreshProfileId } from './profiles.js'
import { buildOfflineAdmission } from './native-selector-qual-offline-fixtures.js'

await test('QUAL source admission accepts UI diagnostic pHash overlap but rejects photo near-hash overlap', async () => {
  const uiRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-ui-phash-'))
  const photoRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-photo-phash-'))
  try {
    const { admission } = await buildOfflineAdmission(uiRoot)
    assert.equal(isVerifiedNativeSelectorQualAdmission(admission), true)
    await assert.rejects(
      buildOfflineAdmission(photoRoot, true),
      /QUAL source groups intersect DEV or excluded groups/u,
    )
  } finally {
    await rm(uiRoot, { recursive: true, force: true })
    await rm(photoRoot, { recursive: true, force: true })
  }
})

await test('QUAL freeze retains the selected DEV deadline, native limits, timeout, and execution policy', async () => {
  const namespaceRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-freeze-policy-'))
  try {
    const { admission } = await buildOfflineAdmission(namespaceRoot)
    assert.doesNotThrow(() =>
      assertNativeSelectorQualExecutionPolicyInheritance(admission.freeze, admission.freeze),
    )
    for (const tamperedFreeze of [
      {
        ...admission.freeze,
        deadlineIso: new Date(Date.parse(admission.freeze.deadlineIso) + 1_000).toISOString(),
      },
      {
        ...admission.freeze,
        nativeLimits: {
          ...admission.freeze.nativeLimits,
          maxPendingNativeJobs: admission.freeze.nativeLimits.maxPendingNativeJobs + 1,
        },
      },
      {
        ...admission.freeze,
        timeoutRetryPolicy: {
          ...admission.freeze.timeoutRetryPolicy,
          sharedAbsoluteTimeoutMs: 239_000,
        },
      },
      {
        ...admission.freeze,
        timeoutRetryPolicy: {
          ...admission.freeze.timeoutRetryPolicy,
          absoluteCaseTimeoutSeconds: 239,
        },
      },
      {
        ...admission.freeze,
        pairedSchedule: admission.freeze.pairedSchedule.map((row) =>
          row.stratum === 'photo' ? { ...row, candidateArmFirst: true } : row,
        ),
      },
    ])
      assert.throws(
        () => assertNativeSelectorQualExecutionPolicyInheritance(admission.freeze, tamperedFreeze),
        /execution policy differs/u,
      )
    assert.throws(
      () =>
        assertNativeSelectorQualExecutionPolicyInheritance(
          {
            ...admission.freeze,
            executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
          },
          admission.freeze,
        ),
      /execution policy differs/u,
    )
  } finally {
    await rm(namespaceRoot, { recursive: true, force: true })
  }
})

await test('QUAL runner identity requires a privately verified admission token', () => {
  assert.equal(
    isVerifiedNativeSelectorQualAdmission({ schema: 'h8a-native-selector-qual120-protocol-v1' }),
    false,
  )
  assert.equal(typeof buildNativeSelectorQualCaseArtifactIdentity, 'function')
})

await test('QUAL paired runner settles a controlled public-native receipt with global and local IDs', async () => {
  const namespaceRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-native-runner-'))
  const { admission } = await buildOfflineAdmission(namespaceRoot)
  const binding = nativeSelectorRuntimeFactoryOptions()
  const fixtureCanvas = admission.freeze.producerCases[0]!
  const calls: string[] = []
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    calls.push(String(input))
    assert.equal(String(input), 'https://openrouter.ai/api/alpha/decisions')
    const body = JSON.parse(String(init?.body ?? '')) as {
      questions: Record<string, { criteria: Record<string, string> }>
    }
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([questionId, question]) => {
        const choices = Object.keys(question.criteria)
        assert.deepEqual(choices, ['present', 'absent'])
        return [
          questionId,
          { type: 'choice', choice: 'absent', probabilities: { present: 0, absent: 1 } },
        ]
      }),
    )
    return new Response(
      JSON.stringify({
        id: 'offline-qual-native',
        model: 'openai/gpt-6-luna-decisions',
        provider: 'OpenAI',
        usage: { cost: 0.01 },
        answers,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }
  const candidateRuntime: CandidateRuntimePort = {
    async run(input) {
      if (!input.presenceDecision) throw new Error('QUAL native presence port is missing')
      const state = await input.imageState(
        {
          bytes: new Uint8Array(input.encodedImage),
          width: fixtureCanvas.sourceCanvasWidth,
          height: fixtureCanvas.sourceCanvasHeight,
        },
        input.signal,
      )
      const request: DecisionRequest = {
        state,
        questions: {
          selection: {
            type: 'choice',
            rankingSize: 1,
            instructions: 'Choose whether the target is present.',
            criteria: { present: 'The target is visible.', absent: 'The target is not visible.' },
          },
        },
      }
      const answer = await input.presenceDecision.decide(request, input.signal)
      if (
        answer.answers.selection?.type !== 'choice' ||
        answer.answers.selection.choice !== 'absent'
      )
        throw new Error('Controlled native adapter did not return the admitted absent choice')
      return {
        recipeId: PROFILE_FLAT_CANDIDATE_ID,
        status: 'unknown',
        reason: 'offline controlled absent',
      }
    },
    async dispose() {},
  }
  const unusedSegmenter: SegmentationPort = {
    async segment() {
      return {
        status: 'unknown',
        reason: 'unused offline control',
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
  let ports: Awaited<ReturnType<typeof createH8FreshRuntimePortsForOfflineFixture>> | undefined
  try {
    ports = await createH8FreshRuntimePortsForOfflineFixture({
      apiKey: 'offline-fixture-key',
      artifactRoot: join(namespaceRoot, 'runtime-artifacts'),
      temporaryRoot: join(namespaceRoot, 'runtime-temporary'),
      maskArtifactDirectory: join(namespaceRoot, 'runtime-masks'),
      cutoutArtifactDirectory: join(namespaceRoot, 'runtime-cutouts'),
      nativeRuntime: {
        pythonExecutable: 'unused-offline-fixture',
        assetRoot: join(namespaceRoot, 'assets-not-opened'),
        ...binding.nativeRuntime,
      },
      candidateProfileId: binding.candidateProfileId,
      selectionPolicyId: binding.selectionPolicyId,
      mobileSam: { encoderPath: 'unused', decoderPath: 'unused' },
      sourceCanvasByOpaqueCaseId: new Map(
        admission.freeze.producerCases.map((row) => [
          row.opaqueCaseId,
          { width: row.sourceCanvasWidth, height: row.sourceCanvasHeight },
        ]),
      ),
      controlEngine: {
        kind: 'offline-fixture-only',
        processRegionSeededCase,
        assertRecorderHealthy,
        createClassifier,
        createOpenRouterDecisions,
        createNativeCategoricalPresencePort(_nativePort: DecisionPort) {
          throw new Error('QUAL test must not create historical candidate control')
        },
        createControlSegmenter: () => unusedSegmenter,
      },
      fetch: fetcher,
      createCandidateRuntime(recipeId, _runtimeBinding) {
        assert.equal(recipeId, PROFILE_FLAT_CANDIDATE_ID)
        return candidateRuntime
      },
    })
    const controlPort = {
      async execute(input: { opaqueCaseId: string }, context: { profileId: H8aFreshProfileId }) {
        return {
          outputRow: {
            schema: 'h8a-fresh-output-row-v1' as const,
            opaqueCaseId: input.opaqueCaseId,
            profileId: context.profileId,
            executionValidity: 'valid' as const,
            caseState: 'not_found' as const,
            box: null,
            cutoutPresent: false,
            maskPackedSha256: null,
            logicalReceiptIds: [1],
            physicalReceiptIds: [],
          },
          logicalReceipts: [
            {
              logicalId: 1,
              opaqueCaseId: input.opaqueCaseId,
              profileId: context.profileId,
              requestSha256: hashIdentity({ caseId: input.opaqueCaseId, arm: 'control' }),
              physicalIds: [],
              outcome: 'preflight_failed' as const,
              errorCode: 'OFFLINE_CONTROL_STUB',
            },
          ],
          physicalReceipts: [],
        }
      },
    }
    const result = await runNativeSelectorQual120({
      admission,
      candidatePort: ports.candidatePort,
      controlPort,
      runtimeArtifacts: ports.artifacts,
      disposeRuntime: ports.dispose,
    })
    assert.equal(calls.length, 120)
    const receipts = result.candidateCloseout.physicalReceipts
    assert.equal(receipts.length, 120)
    assert.equal(receipts[0]?.physicalId, 318)
    assert.equal(receipts[0]?.receiptId, 1)
    assert.notEqual(receipts[0]?.physicalId, receipts[0]?.receiptId)
    assert.equal(receipts[0]?.chargeState, 'known')
    assert.equal(result.candidateCloseout.physicalDispatchCount, 120)
  } finally {
    if (ports) await ports.dispose()
    await rm(namespaceRoot, { recursive: true, force: true })
  }
})

await test('offline-only verified QUAL admission runs paired arms and retains full partial closeouts', async () => {
  const namespaceRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-runner-'))
  let disposeCalls = 0
  let candidateCalls = 0
  try {
    const { admission } = await buildOfflineAdmission(namespaceRoot)
    assert.equal(isVerifiedNativeSelectorQualAdmission(admission), true)
    const firstProducer = admission.freeze.producerCases[0]!
    const originalTarget = firstProducer.targetTaskText
    firstProducer.targetTaskText = `${originalTarget} changed after admission`
    assert.throws(
      () => nativeSelectorQualAdmissionSnapshot(admission),
      /changed after source validation/u,
    )
    firstProducer.targetTaskText = originalTarget
    const makePort = (candidate: boolean) => ({
      async execute(input: { opaqueCaseId: string }, context: { profileId: H8aFreshProfileId }) {
        if (candidate) {
          candidateCalls++
        }
        return {
          outputRow: {
            schema: 'h8a-fresh-output-row-v1' as const,
            opaqueCaseId: input.opaqueCaseId,
            profileId: context.profileId,
            executionValidity: 'valid' as const,
            caseState: 'not_found' as const,
            box: null,
            cutoutPresent: false,
            maskPackedSha256: null,
            logicalReceiptIds: [1],
            physicalReceiptIds: [],
          },
          logicalReceipts: [
            {
              logicalId: 1,
              opaqueCaseId: input.opaqueCaseId,
              profileId: context.profileId,
              requestSha256: hashIdentity({
                opaqueCaseId: input.opaqueCaseId,
                profileId: context.profileId,
              }),
              physicalIds: [],
              outcome: 'resolved' as const,
            },
          ],
          physicalReceipts: [],
        }
      },
    })
    const runtimeArtifacts = {
      masksBySha256: new Map(),
      cutoutsBySha256: new Map(),
      cutoutsByProfileAndCase: new Map(),
    }
    const result = await runNativeSelectorQual120({
      admission,
      candidatePort: makePort(true),
      controlPort: makePort(false),
      runtimeArtifacts,
      async disposeRuntime() {
        disposeCalls++
      },
      now: () => new Date().toISOString(),
    })
    assert.equal(candidateCalls, 120)
    assert.equal(disposeCalls, 1)
    assert.equal(result.candidateCloseout.outputRows.length, 120)
    assert.equal(result.controlCloseout.outputRows.length, 120)
    assert.equal(result.candidateCloseout.outputRows[0]?.caseState, 'not_found')
    const closed = await assembleNativeSelectorQualCloseouts(admission)
    assert.equal(closed.candidateCloseout.outputRows.length, 120)
    assert.equal(closed.controlCloseout.outputRows.length, 120)
    const crashRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-crash-closeout-'))
    try {
      const { admission: interruptedAdmission } = await buildOfflineAdmission(crashRoot)
      const recovered = await assembleNativeSelectorQualCloseouts(interruptedAdmission)
      assert.equal(recovered.candidateCloseout.outputRows.length, 120)
      assert.equal(recovered.controlCloseout.outputRows.length, 120)
      assert.ok(
        recovered.candidateCloseout.outputRows.every((row) => row.caseState === 'unstarted'),
      )
      assert.ok(recovered.controlCloseout.outputRows.every((row) => row.caseState === 'unstarted'))
      assert.equal(recovered.candidateCloseout.physicalDispatchCount, 0)
      assert.equal(recovered.controlCloseout.physicalDispatchCount, 0)
    } finally {
      await rm(crashRoot, { recursive: true, force: true })
    }
  } finally {
    await rm(namespaceRoot, { recursive: true, force: true })
  }
})
