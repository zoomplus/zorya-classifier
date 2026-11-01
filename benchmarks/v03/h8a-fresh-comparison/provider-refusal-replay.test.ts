import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ClassifierError } from '../../../src/entities/errors.js'
import { recordProvider } from '../../v02/recording.js'
import { RunBudget } from '../../v02/budget.js'
import { buildSyntheticPhaseFreeze } from './test-fixtures.js'
import { buildSyntheticAnnotationBundle } from './test-fixtures.js'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import { buildDevScreenSelection } from './dev-screen-sampling.js'
import { buildCaseArtifactIdentity } from './dev-screen-runner.js'
import { assembleDev40Closeouts } from './dev-closeout-assembly.js'
import { ImmutableCaseArtifactStore } from './case-artifact-store.js'
import { CampaignLedger } from './campaign-ledger.js'
import { validateImmutableCloseouts } from './evaluator.js'
import { hashIdentity } from './hash-identity.js'
import { outputRowSchema, phaseFreezeSchema } from './schemas.js'
import { PROFILE_CANDIDATE_ID, PROFILE_SCOPE_CANDIDATE_ID, PHASE_DEV40_ID } from './constants.js'
import {
  PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
  PROVIDER_REFUSAL_REPLAY_POLICY_SHA256,
  providerRefusalReplayEvidenceSchema,
  remapProviderRefusalReplayEvidence,
  assertProviderRefusalReplayEvidence,
  buildProviderRefusalReplayEvidence,
} from './provider-refusal-replay.js'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

await test('legacy freeze JSON and policy hash remain stable when opt-in is omitted', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const parsed = phaseFreezeSchema.parse(freeze)
  assert.equal(Object.hasOwn(parsed, 'executionPolicy'), false)
  assert.equal(JSON.stringify(parsed), JSON.stringify(freeze))
  const legacyRow = {
    schema: 'h8a-fresh-output-row-v1' as const,
    opaqueCaseId: 'legacy-case',
    profileId: PROFILE_CANDIDATE_ID,
    executionValidity: 'valid' as const,
    caseState: 'unknown' as const,
    box: null,
    cutoutPresent: false,
    maskPackedSha256: null,
    logicalReceiptIds: [],
    physicalReceiptIds: [],
  }
  const parsedRow = outputRowSchema.parse(legacyRow)
  assert.equal(Object.hasOwn(parsedRow, 'providerRefusalEvidence'), false)
  assert.equal(JSON.stringify(parsedRow), JSON.stringify(legacyRow))
  assert.match(PROVIDER_REFUSAL_REPLAY_POLICY_SHA256, /^[a-f0-9]{64}$/u)
  assert.equal(
    PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY.policySha256,
    PROVIDER_REFUSAL_REPLAY_POLICY_SHA256,
  )
})

await test('immutable case store and two-case DEV closeout preserve refusal links through ID remapping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-refusal-closeout-'))
  try {
    const synthetic = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const base = synthetic.freeze
    const annotations = buildSyntheticAnnotationBundle(
      base.phaseId,
      base.freezeId,
      base.producerCases,
      base.pairedSchedule,
    )
    const freeze = phaseFreezeSchema.parse({
      ...base,
      executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
      evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
    })
    const selection = buildDevScreenSelection(freeze, annotations)
    const store = new ImmutableCaseArtifactStore(join(root, 'artifacts'))
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const cases = freeze.producerCases.slice(0, 2)
    const candidateProfile = freeze.profileBindings[0]!.profileId
    const reserve = freeze.conservativeCostProof.profileDispatchUpperBounds.find(
      (item) => item.profileId === candidateProfile,
    )!.maxUsdPerPhysicalDispatch
    for (const producer of cases) {
      const identity = buildCaseArtifactIdentity(freeze, selection, producer, candidateProfile)
      const opened = await store.begin(identity, '2026-11-01T10:00:00.000Z')
      await ledger.recordLogicalAttempt({
        profileId: candidateProfile,
        opaqueCaseId: producer.opaqueCaseId,
      })
      const reservationId = await ledger.admitPhysical(reserve, {
        profileId: candidateProfile,
        opaqueCaseId: producer.opaqueCaseId,
      })
      await ledger.recordDispatchIntent(reservationId)
      const globalPhysicalId = await ledger.markDispatched(reservationId)
      await ledger.settle(reservationId, null)
      const logicalId = 1
      const requestSha256 = sha256(`request:${producer.opaqueCaseId}`)
      const requestBodySha256 = sha256(`body:${producer.opaqueCaseId}`)
      const evidence = providerRefusalReplayEvidenceSchema.parse({
        schema: 'h8a-provider-refusal-replay-evidence-v1',
        policyId: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY.policyId,
        policySha256: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY.policySha256,
        hypothesisSha256: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY.hypothesisSha256,
        protocol: 'openrouter-chat-message-refusal-v1',
        scope: 'request',
        responseStatus: 200,
        errorCode: 'INVALID_RESPONSE',
        opaqueCaseId: producer.opaqueCaseId,
        profileId: candidateProfile,
        caseExecutionIdentitySha256: opened.identitySha256,
        logicalReceiptId: logicalId,
        physicalReceiptId: reservationId,
        globalPhysicalId,
        recorderLogicalId: 1,
        recorderPhysicalId: 1,
        requestSha256,
        requestBodySha256,
      })
      const result = {
        outputRow: {
          schema: 'h8a-fresh-output-row-v1' as const,
          opaqueCaseId: producer.opaqueCaseId,
          profileId: candidateProfile,
          executionValidity: 'valid' as const,
          caseState: 'unknown' as const,
          box: null,
          cutoutPresent: false,
          maskPackedSha256: null,
          logicalReceiptIds: [logicalId],
          physicalReceiptIds: [reservationId],
          providerRefusalEvidence: evidence,
        },
        logicalReceipts: [
          {
            logicalId,
            opaqueCaseId: producer.opaqueCaseId,
            profileId: candidateProfile,
            requestSha256,
            physicalIds: [reservationId],
            outcome: 'failed' as const,
            errorCode: 'INVALID_RESPONSE',
          },
        ],
        physicalReceipts: [
          {
            receiptId: reservationId,
            physicalId: globalPhysicalId,
            logicalId,
            dispatchState: 'confirmed' as const,
            settled: true,
            costUsd: null,
            chargeState: 'unknown' as const,
          },
        ],
      }
      await store.complete({
        identitySha256: opened.identitySha256,
        result,
        durationMs: 1,
        startedAtIso: '2026-11-01T10:00:00.000Z',
        completedAtIso: '2026-11-01T10:00:00.001Z',
        knownCostUsd: 0,
        unknownDispatchCount: 1,
        identity,
        blobs: new Map(),
      })
    }
    const assembled = await assembleDev40Closeouts({
      freeze,
      annotations,
      selection,
      artifactRoot: join(root, 'artifacts'),
      ledger,
      closedAtIso: '2026-11-01T10:01:00.000Z',
    })
    const refusalRows = assembled.candidateCloseout.outputRows.slice(0, 2)
    assert.ok(refusalRows.every((row) => row.providerRefusalEvidence))
    assert.deepEqual(
      refusalRows.map((row) => row.providerRefusalEvidence?.logicalReceiptId),
      [1, 2],
    )
    assert.deepEqual(
      refusalRows.map((row) => row.providerRefusalEvidence?.recorderLogicalId),
      [1, 1],
    )
    assert.equal(assembled.candidateCloseout.outputRows[0]?.caseState, 'unknown')
    assert.equal(assembled.candidateCloseout.outputRows[1]?.caseState, 'unknown')

    const tamperedRows = [...assembled.candidateCloseout.outputRows]
    const secondRow = tamperedRows[1]!
    tamperedRows[1] = {
      ...secondRow,
      providerRefusalEvidence: {
        ...secondRow.providerRefusalEvidence!,
        globalPhysicalId: secondRow.providerRefusalEvidence!.globalPhysicalId + 1,
      },
    }
    const body = {
      freezeId: assembled.candidateCloseout.freezeId,
      freezeCommitmentSha256: assembled.candidateCloseout.freezeCommitmentSha256,
      phaseId: assembled.candidateCloseout.phaseId,
      profileId: assembled.candidateCloseout.profileId,
      closedAtIso: assembled.candidateCloseout.closedAtIso,
      cohortCommitmentSha256: assembled.candidateCloseout.cohortCommitmentSha256,
      producerClosureSha256: assembled.candidateCloseout.producerClosureSha256,
      recipeIdentitySha256: assembled.candidateCloseout.recipeIdentitySha256,
      requestPolicyIdentitySha256: assembled.candidateCloseout.requestPolicyIdentitySha256,
      outputRows: tamperedRows,
      logicalReceipts: assembled.candidateCloseout.logicalReceipts,
      physicalReceipts: assembled.candidateCloseout.physicalReceipts,
      logicalAttemptCount: assembled.candidateCloseout.logicalAttemptCount,
      physicalDispatchCount: assembled.candidateCloseout.physicalDispatchCount,
      uncertainDispatchCount: assembled.candidateCloseout.uncertainDispatchCount,
    }
    const tamperedCandidate = {
      schema: 'h8a-fresh-immutable-closeout-v1' as const,
      ...body,
      closeoutSha256: hashIdentity(body),
    }
    assert.throws(() =>
      validateImmutableCloseouts({
        freeze,
        candidateCloseout: tamperedCandidate,
        controlCloseout: assembled.controlCloseout,
      }),
    )

    const remapped = remapProviderRefusalReplayEvidence(
      refusalRows[1]!.providerRefusalEvidence!,
      new Map([[2, 22]]),
      new Map([[2, 33]]),
    )
    assert.equal(remapped.logicalReceiptId, 22)
    assert.equal(remapped.physicalReceiptId, 33)
    assert.equal(
      remapped.globalPhysicalId,
      refusalRows[1]!.providerRefusalEvidence!.globalPhysicalId,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('only actual request-bound chat refusal with a complete settled receipt graph yields typed unknown evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-refusal-policy-'))
  try {
    const route = {
      model: 'openai/gpt-6-luna',
      provider: 'openai',
      providerName: 'OpenAI',
      apiEndpoint: '/api/v1/chat/completions',
      allowFallbacks: false as const,
    }
    const budget = new RunBudget(1, 0.55, 0.12)
    const recorder = recordProvider(
      (fetch) => ({
        async decide(_request, signal) {
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: route.model,
              provider: { only: ['openai'], allow_fallbacks: false, require_parameters: true },
              messages: [],
            }),
          })
          await response.text()
          throw new ClassifierError('INVALID_RESPONSE', 'Adapter rejected refusal response')
        },
      }),
      budget,
      join(root, 'provider-receipts'),
      route,
      async () =>
        new Response(
          JSON.stringify({
            id: 'refusal-response',
            model: route.model,
            provider: route.providerName,
            choices: [{ index: 0, finish_reason: 'stop', message: { refusal: 'private marker' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    const abort = new AbortController()
    await assert.rejects(
      recorder.port.decide(
        {
          state: ['controlled'],
          questions: {
            selection: {
              type: 'choice',
              rankingSize: 1,
              instructions: 'Select one.',
              criteria: { visible: 'Visible.', absent: 'Absent.' },
            },
          },
        },
        abort.signal,
      ),
      (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_RESPONSE',
    )
    const physicalCall = recorder.calls[0]
    const logicalCall = recorder.logicalCalls[0]
    assert.ok(physicalCall)
    assert.ok(logicalCall)
    assert.equal(physicalCall.httpStatus, 200)
    assert.equal(physicalCall.errorCode, 'INVALID_RESPONSE')
    assert.equal(physicalCall.providerRefusal?.protocol, 'openrouter-chat-message-refusal-v1')
    assert.equal(budget.snapshot().unknownCostCalls, 1)
    assert.equal(budget.snapshot().inFlightCalls, 0)

    const identitySha256 = sha256('case identity')
    const journal = [
      {
        reservationId: physicalCall.reservationId,
        physicalId: 44,
        profileId: PROFILE_CANDIDATE_ID,
        opaqueCaseId: 'opaque-case',
        caseExecutionIdentitySha256: identitySha256,
        logicalId: logicalCall.logicalId,
        recorderPhysicalId: physicalCall.physicalId,
        requestSha256: physicalCall.requestSha256,
        requestBodySha256: physicalCall.requestBodySha256,
        endpoint: '/api/v1/chat/completions' as const,
        dispatchState: 'confirmed' as const,
        settled: true,
        costUsd: null,
        httpStatus: physicalCall.httpStatus,
      },
    ]
    const logicalReceipts = [
      {
        logicalId: logicalCall.logicalId,
        opaqueCaseId: 'opaque-case',
        profileId: PROFILE_CANDIDATE_ID,
        requestSha256: logicalCall.requestSha256,
        physicalIds: [physicalCall.reservationId],
        outcome: 'failed' as const,
        errorCode: 'INVALID_RESPONSE',
      },
    ]
    const physicalReceipts = [
      {
        receiptId: physicalCall.reservationId,
        physicalId: 44,
        logicalId: logicalCall.logicalId,
        dispatchState: 'confirmed' as const,
        settled: true,
        costUsd: null,
        chargeState: 'unknown' as const,
      },
    ]
    const evidenceInput = {
      executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
      errorCode: 'INVALID_RESPONSE',
      profileId: PROFILE_CANDIDATE_ID,
      opaqueCaseId: 'opaque-case',
      caseExecutionIdentitySha256: identitySha256,
      recorder,
      journal,
      logicalReceipts,
      physicalReceipts,
      signal: abort.signal,
    }
    const evidence = buildProviderRefusalReplayEvidence(evidenceInput)
    assert.ok(evidence)
    const scopeEvidence = buildProviderRefusalReplayEvidence({
      ...evidenceInput,
      profileId: PROFILE_SCOPE_CANDIDATE_ID,
      journal: journal.map((entry) => ({ ...entry, profileId: PROFILE_SCOPE_CANDIDATE_ID })),
      logicalReceipts: logicalReceipts.map((receipt) => ({
        ...receipt,
        profileId: PROFILE_SCOPE_CANDIDATE_ID,
      })),
    })
    assert.equal(scopeEvidence?.profileId, PROFILE_SCOPE_CANDIDATE_ID)
    const aborted = new AbortController()
    aborted.abort(new Error('controlled cancellation'))
    assert.equal(
      buildProviderRefusalReplayEvidence({ ...evidenceInput, signal: aborted.signal }),
      undefined,
    )
    assert.equal(
      buildProviderRefusalReplayEvidence({
        ...evidenceInput,
        journal: [{ ...journal[0]!, dispatchState: 'uncertain' as const }],
      }),
      undefined,
    )
    assert.equal(
      buildProviderRefusalReplayEvidence({
        ...evidenceInput,
        physicalReceipts: [{ ...physicalReceipts[0]!, costUsd: 0, chargeState: 'known' as const }],
      }),
      undefined,
    )
    const output = {
      caseState: 'unknown',
      executionValidity: 'valid',
      box: null,
      cutoutPresent: false,
      maskPackedSha256: null,
      logicalReceiptIds: [logicalCall.logicalId],
      physicalReceiptIds: [physicalCall.reservationId],
    }
    assert.equal(
      assertProviderRefusalReplayEvidence({
        evidence,
        executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
        opaqueCaseId: 'opaque-case',
        profileId: PROFILE_CANDIDATE_ID,
        output,
        logicalReceipts,
        physicalReceipts,
        identitySha256,
      }).requestBodySha256,
      physicalCall.requestBodySha256,
    )
    assert.throws(() =>
      assertProviderRefusalReplayEvidence({
        evidence: { ...evidence, globalPhysicalId: 45 },
        executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
        opaqueCaseId: 'opaque-case',
        profileId: PROFILE_CANDIDATE_ID,
        output: { ...output, box: { left: 0, top: 0, width: 1, height: 1 } },
        logicalReceipts,
        physicalReceipts,
        identitySha256,
      }),
    )
    assert.throws(() =>
      assertProviderRefusalReplayEvidence({
        evidence,
        executionPolicy: {
          ...PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
          policySha256: sha256('wrong'),
        },
        opaqueCaseId: 'opaque-case',
        profileId: PROFILE_CANDIDATE_ID,
        output,
        logicalReceipts,
        physicalReceipts,
      }),
    )
    assert.throws(() =>
      assertProviderRefusalReplayEvidence({
        evidence,
        executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
        opaqueCaseId: 'opaque-case',
        profileId: PROFILE_CANDIDATE_ID,
        output,
        logicalReceipts,
        physicalReceipts: [{ ...physicalReceipts[0]!, chargeState: 'known' }],
      }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
