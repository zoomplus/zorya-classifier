import { createHash } from 'node:crypto'
import { z } from 'zod'
import { providerRefusalObservationSchema } from '../../v02/provider-refusal.js'
import type { ProviderRefusalObservation } from '../../v02/provider-refusal.js'
import type { Recorder } from '../../v02/recording.js'
import {
  acceptsResponseModel,
  unexpectedResponseProvider,
} from '../../../src/infrastructure/decision-transport/route-identity.js'
import type { CampaignFetchJournalEntry } from './campaign-fetch-boundary.js'
import type { H8aFreshProfileId } from './profiles.js'
import {
  PROFILE_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  PROFILE_SCOPE_CANDIDATE_ID,
  PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
} from './constants.js'

const PROVIDER_REFUSAL_REPLAY_POLICY_ID = 'h8a-provider-reported-refusal-replay-v1'
const PROVIDER_REFUSAL_HYPOTHESIS_SHA256 =
  'c4ccc40c47b8341a5ea2445b71733d64a5ca8fe8111c7343d1099ebf707d950b'

const providerRefusalReplayPolicyBody = {
  schema: 'h8a-provider-refusal-replay-policy-v1',
  policyId: PROVIDER_REFUSAL_REPLAY_POLICY_ID,
  hypothesisSha256: PROVIDER_REFUSAL_HYPOTHESIS_SHA256,
  observationProtocols: [
    'openrouter-native-named-refusal-v1',
    'openrouter-chat-message-refusal-v1',
  ],
} as const

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export const PROVIDER_REFUSAL_REPLAY_POLICY_SHA256 = sha256Json(providerRefusalReplayPolicyBody)

const providerRefusalReplayPolicyBodySchema = z
  .object({
    schema: z.literal('h8a-provider-refusal-replay-policy-v1'),
    policyId: z.literal(PROVIDER_REFUSAL_REPLAY_POLICY_ID),
    hypothesisSha256: z.literal(PROVIDER_REFUSAL_HYPOTHESIS_SHA256),
    observationProtocols: z.tuple([
      z.literal('openrouter-native-named-refusal-v1'),
      z.literal('openrouter-chat-message-refusal-v1'),
    ]),
  })
  .strict()

export const providerRefusalReplayExecutionPolicySchema = providerRefusalReplayPolicyBodySchema
  .extend({ policySha256: z.literal(PROVIDER_REFUSAL_REPLAY_POLICY_SHA256) })
  .strict()

export const PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY = Object.freeze(
  providerRefusalReplayExecutionPolicySchema.parse({
    ...providerRefusalReplayPolicyBody,
    policySha256: PROVIDER_REFUSAL_REPLAY_POLICY_SHA256,
  }),
)

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const questionIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u)

const refusalEvidenceBaseSchema = z
  .object({
    schema: z.literal('h8a-provider-refusal-replay-evidence-v1'),
    policyId: z.literal(PROVIDER_REFUSAL_REPLAY_POLICY_ID),
    policySha256: z.literal(PROVIDER_REFUSAL_REPLAY_POLICY_SHA256),
    hypothesisSha256: z.literal(PROVIDER_REFUSAL_HYPOTHESIS_SHA256),
    opaqueCaseId: z.string().min(1),
    profileId: z.enum([
      PROFILE_CANDIDATE_ID,
      PROFILE_FLAT_CANDIDATE_ID,
      PROFILE_SCOPE_CANDIDATE_ID,
      PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
      PROFILE_CONTROL_ID,
    ]),
    caseExecutionIdentitySha256: digestSchema,
    logicalReceiptId: z.number().int().positive(),
    physicalReceiptId: z.number().int().positive(),
    globalPhysicalId: z.number().int().positive(),
    recorderLogicalId: z.number().int().positive(),
    recorderPhysicalId: z.number().int().positive(),
    requestSha256: digestSchema,
    requestBodySha256: digestSchema,
  })
  .strict()

const namedRefusalEvidenceSchema = refusalEvidenceBaseSchema
  .extend({
    protocol: z.literal('openrouter-native-named-refusal-v1'),
    scope: z.literal('question'),
    questionId: questionIdSchema,
    responseStatus: z.union([z.literal(200), z.literal(502)]),
    errorCode: z.enum(['PROVIDER', 'INVALID_RESPONSE']),
  })
  .strict()

const chatRefusalEvidenceSchema = z
  .object({
    ...refusalEvidenceBaseSchema.shape,
    protocol: z.literal('openrouter-chat-message-refusal-v1'),
    scope: z.literal('request'),
    responseStatus: z.literal(200),
    errorCode: z.literal('INVALID_RESPONSE'),
  })
  .strict()

export const providerRefusalReplayEvidenceSchema = z
  .discriminatedUnion('protocol', [namedRefusalEvidenceSchema, chatRefusalEvidenceSchema])
  .superRefine((evidence, context) => {
    if (
      evidence.protocol === 'openrouter-native-named-refusal-v1' &&
      evidence.errorCode !== (evidence.responseStatus === 502 ? 'PROVIDER' : 'INVALID_RESPONSE')
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Refusal adapter error code mismatch',
      })
  })

export type ProviderRefusalReplayExecutionPolicy = z.infer<
  typeof providerRefusalReplayExecutionPolicySchema
>
export type ProviderRefusalReplayEvidence = z.infer<typeof providerRefusalReplayEvidenceSchema>

export function remapProviderRefusalReplayEvidence(
  rawEvidence: ProviderRefusalReplayEvidence,
  logicalIdMap: ReadonlyMap<number, number>,
  physicalReceiptIdMap: ReadonlyMap<number, number>,
): ProviderRefusalReplayEvidence {
  const evidence = providerRefusalReplayEvidenceSchema.parse(rawEvidence)
  return providerRefusalReplayEvidenceSchema.parse({
    ...evidence,
    logicalReceiptId: logicalIdMap.get(evidence.logicalReceiptId) ?? evidence.logicalReceiptId,
    physicalReceiptId:
      physicalReceiptIdMap.get(evidence.physicalReceiptId) ?? evidence.physicalReceiptId,
  })
}

interface ExpectedRoute {
  model: string
  provider: string
  providerName: string
  apiEndpoint: '/api/v1/chat/completions' | '/api/alpha/decisions'
  allowFallbacks: false
}

interface PhysicalCaseReceipt {
  receiptId: number
  physicalId: number | null
  logicalId: number
  dispatchState: 'confirmed' | 'uncertain' | 'prefetch_cancelled'
  settled: boolean
  costUsd: number | null
  chargeState: 'known' | 'unknown' | 'reserved_prefetch_cancelled'
}

interface LogicalCaseReceipt {
  logicalId: number
  opaqueCaseId: string
  profileId: H8aFreshProfileId
  requestSha256: string
  physicalIds: number[]
  outcome: string
  errorCode?: string | undefined
}

function sameRoute(actual: Recorder['calls'][number]['route'], expected: ExpectedRoute): boolean {
  return (
    actual.model === expected.model &&
    actual.provider === expected.provider &&
    actual.providerName === expected.providerName &&
    actual.apiEndpoint === expected.apiEndpoint &&
    actual.allowFallbacks === false &&
    expected.allowFallbacks === false
  )
}

function matchingRoute(
  profileId: H8aFreshProfileId,
  route: Recorder['calls'][number]['route'],
): ExpectedRoute | undefined {
  if (
    profileId === PROFILE_CANDIDATE_ID ||
    profileId === PROFILE_FLAT_CANDIDATE_ID ||
    profileId === PROFILE_SCOPE_CANDIDATE_ID
  ) {
    const expected = {
      model: 'openai/gpt-6-luna',
      provider: 'openai',
      providerName: 'OpenAI',
      apiEndpoint: '/api/v1/chat/completions',
      allowFallbacks: false,
    } as const
    return sameRoute(route, expected) ? expected : undefined
  }
  if (profileId === PROFILE_NATIVE_PRESENCE_CANDIDATE_ID) {
    const expectedRoutes = [
      {
        model: 'openai/gpt-6-luna-decisions',
        provider: 'openai',
        providerName: 'OpenAI',
        apiEndpoint: '/api/alpha/decisions',
        allowFallbacks: false,
      },
      {
        model: 'openai/gpt-6-luna',
        provider: 'openai',
        providerName: 'OpenAI',
        apiEndpoint: '/api/v1/chat/completions',
        allowFallbacks: false,
      },
    ] as const
    return expectedRoutes.find((expected) => sameRoute(route, expected))
  }
  if (profileId === PROFILE_CONTROL_ID) {
    const expected = {
      model: 'openai/gpt-6-luna-decisions',
      provider: 'openai',
      providerName: 'OpenAI',
      apiEndpoint: '/api/alpha/decisions',
      allowFallbacks: false,
    } as const
    return sameRoute(route, expected) ? expected : undefined
  }
  return undefined
}

function acceptsReportedRouteIdentity(
  call: Recorder['calls'][number],
  route: ExpectedRoute,
): boolean {
  const wire = call.wireReceipt
  if (!wire) return false
  if (
    wire.responseModel !== null &&
    !acceptsResponseModel(wire.responseModel, { model: route.model })
  )
    return false
  if (
    wire.responseProvider !== null &&
    unexpectedResponseProvider(wire.responseProvider, {
      provider: route.provider,
      providerName: route.providerName,
    })
  )
    return false
  return true
}

/** Return evidence only when the final failed logical request is fully linked and settled. */
export function buildProviderRefusalReplayEvidence(input: {
  executionPolicy: unknown
  errorCode: string | undefined
  profileId: H8aFreshProfileId
  opaqueCaseId: string
  caseExecutionIdentitySha256: string
  recorder: Recorder
  journal: readonly CampaignFetchJournalEntry[]
  logicalReceipts: readonly LogicalCaseReceipt[]
  physicalReceipts: readonly PhysicalCaseReceipt[]
  signal: AbortSignal
}): ProviderRefusalReplayEvidence | undefined {
  const policy = providerRefusalReplayExecutionPolicySchema.safeParse(input.executionPolicy)
  if (!policy.success || input.signal.aborted || !input.errorCode) return undefined
  if (!input.recorder.persistenceFailures || input.recorder.persistenceFailures.length !== 0)
    return undefined
  const { calls, logicalCalls } = input.recorder
  if (calls.length === 0 || logicalCalls.length === 0) return undefined
  const lastCall = calls.at(-1)
  const lastLogical = logicalCalls.at(-1)
  if (!lastCall || !lastLogical || lastCall.logicalId !== lastLogical.logicalId) return undefined
  if (lastCall.errorCode !== input.errorCode || lastLogical.errorCode !== input.errorCode)
    return undefined
  if (lastLogical.physicalIds.length !== 1 || lastLogical.physicalIds[0] !== lastCall.physicalId)
    return undefined
  if (lastCall.receipt !== null || lastCall.httpStatus === null || !lastCall.wireReceipt)
    return undefined
  if (lastCall.wireReceipt.bodyRead !== 'parsed') return undefined
  const observationResult = providerRefusalObservationSchema.safeParse(lastCall.providerRefusal)
  if (!observationResult.success) return undefined
  const observation: ProviderRefusalObservation = observationResult.data
  const expectedRoute = matchingRoute(input.profileId, lastCall.route)
  if (!expectedRoute || !acceptsReportedRouteIdentity(lastCall, expectedRoute)) return undefined
  if (
    observation.physicalId !== lastCall.physicalId ||
    observation.route !== expectedRoute.apiEndpoint ||
    observation.requestSha256 !== lastCall.requestSha256 ||
    observation.requestBodySha256 !== lastCall.requestBodySha256 ||
    observation.responseStatus !== lastCall.httpStatus
  )
    return undefined
  if (
    lastCall.wireReceipt.responseDisposition !==
    (observation.protocol === 'openrouter-native-named-refusal-v1' &&
    observation.responseStatus === 502
      ? 'error-envelope'
      : observation.protocol === 'openrouter-native-named-refusal-v1'
        ? 'typed-decisions-response'
        : 'chat-refusal')
  )
    return undefined
  const expectedErrorCode =
    observation.protocol === 'openrouter-native-named-refusal-v1' &&
    observation.responseStatus === 502
      ? 'PROVIDER'
      : 'INVALID_RESPONSE'
  if (input.errorCode !== expectedErrorCode) return undefined
  const finalJournal = input.journal.at(-1)
  if (!finalJournal) return undefined
  if (
    input.journal.length !== calls.length ||
    logicalCalls.length !== calls.length ||
    input.logicalReceipts.length !== logicalCalls.length ||
    input.physicalReceipts.length !== input.journal.length ||
    new Set(input.logicalReceipts.map((receipt) => receipt.logicalId)).size !==
      input.logicalReceipts.length ||
    new Set(input.physicalReceipts.map((receipt) => receipt.receiptId)).size !==
      input.physicalReceipts.length
  )
    return undefined
  const seenJournalIds = new Set<number>()
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]
    const logical = logicalCalls[index]
    const entry = input.journal[index]
    if (!call || !logical || !entry) return undefined
    if (
      logical.physicalIds.length !== 1 ||
      logical.physicalIds[0] !== call.physicalId ||
      call.logicalId !== logical.logicalId ||
      call.requestSha256 !== logical.requestSha256 ||
      entry.recorderPhysicalId !== call.physicalId ||
      entry.logicalId !== logical.logicalId ||
      entry.requestSha256 !== call.requestSha256 ||
      entry.requestBodySha256 !== call.requestBodySha256 ||
      entry.profileId !== input.profileId ||
      entry.opaqueCaseId !== input.opaqueCaseId ||
      entry.caseExecutionIdentitySha256 !== input.caseExecutionIdentitySha256 ||
      entry.endpoint !== expectedRoute.apiEndpoint ||
      entry.httpStatus !== call.httpStatus ||
      entry.dispatchState !== 'confirmed' ||
      !entry.settled ||
      entry.physicalId === null ||
      !Number.isSafeInteger(entry.physicalId) ||
      entry.errorCode !== undefined ||
      seenJournalIds.has(entry.reservationId)
    )
      return undefined
    const linkedLogicalReceipt = input.logicalReceipts.find(
      (receipt) => receipt.logicalId === logical.logicalId,
    )
    const linkedPhysicalReceipt = input.physicalReceipts.find(
      (receipt) => receipt.receiptId === entry.reservationId,
    )
    if (
      !linkedLogicalReceipt ||
      !linkedPhysicalReceipt ||
      linkedLogicalReceipt.opaqueCaseId !== input.opaqueCaseId ||
      linkedLogicalReceipt.profileId !== input.profileId ||
      linkedLogicalReceipt.requestSha256 !== logical.requestSha256 ||
      !linkedLogicalReceipt.physicalIds.includes(entry.reservationId) ||
      linkedLogicalReceipt.outcome !== (index < calls.length - 1 ? 'resolved' : 'failed') ||
      (index < calls.length - 1 && linkedLogicalReceipt.errorCode !== undefined) ||
      linkedPhysicalReceipt.logicalId !== logical.logicalId ||
      linkedPhysicalReceipt.physicalId !== entry.physicalId ||
      linkedPhysicalReceipt.costUsd !== entry.costUsd ||
      linkedPhysicalReceipt.dispatchState !== 'confirmed' ||
      !linkedPhysicalReceipt.settled ||
      linkedPhysicalReceipt.chargeState !==
        (linkedPhysicalReceipt.costUsd === null ? 'unknown' : 'known')
    )
      return undefined
    seenJournalIds.add(entry.reservationId)
    if (index < calls.length - 1 && logical.errorCode !== undefined) return undefined
  }
  const logicalReceipt = input.logicalReceipts.find(
    (receipt) => receipt.logicalId === lastLogical.logicalId,
  )
  const physicalReceipt = input.physicalReceipts.find(
    (receipt) => receipt.receiptId === finalJournal.reservationId,
  )
  if (
    !logicalReceipt ||
    !physicalReceipt ||
    logicalReceipt.opaqueCaseId !== input.opaqueCaseId ||
    logicalReceipt.profileId !== input.profileId ||
    logicalReceipt.requestSha256 !== lastCall.requestSha256 ||
    logicalReceipt.outcome !== 'failed' ||
    logicalReceipt.errorCode !== input.errorCode ||
    !logicalReceipt.physicalIds.includes(finalJournal.reservationId) ||
    physicalReceipt.logicalId !== logicalReceipt.logicalId ||
    physicalReceipt.physicalId !== finalJournal.physicalId ||
    physicalReceipt.dispatchState !== 'confirmed' ||
    !physicalReceipt.settled ||
    physicalReceipt.chargeState !== (physicalReceipt.costUsd === null ? 'unknown' : 'known')
  )
    return undefined
  const baseEvidence = {
    schema: 'h8a-provider-refusal-replay-evidence-v1' as const,
    policyId: policy.data.policyId,
    policySha256: policy.data.policySha256,
    hypothesisSha256: policy.data.hypothesisSha256,
    responseStatus: observation.responseStatus,
    errorCode: input.errorCode,
    opaqueCaseId: input.opaqueCaseId,
    profileId: input.profileId,
    caseExecutionIdentitySha256: input.caseExecutionIdentitySha256,
    logicalReceiptId: logicalReceipt.logicalId,
    physicalReceiptId: physicalReceipt.receiptId,
    globalPhysicalId: finalJournal.physicalId,
    recorderLogicalId: lastCall.logicalId,
    recorderPhysicalId: lastCall.physicalId,
    requestSha256: lastCall.requestSha256,
    requestBodySha256: lastCall.requestBodySha256,
  }
  const rawEvidence =
    observation.protocol === 'openrouter-native-named-refusal-v1'
      ? {
          ...baseEvidence,
          protocol: observation.protocol,
          scope: observation.scope,
          questionId: observation.questionId,
        }
      : {
          ...baseEvidence,
          protocol: observation.protocol,
          scope: observation.scope,
        }
  const parsedEvidence = providerRefusalReplayEvidenceSchema.safeParse(rawEvidence)
  return parsedEvidence.success ? parsedEvidence.data : undefined
}

export function assertProviderRefusalReplayEvidence(input: {
  evidence: unknown
  executionPolicy: unknown
  opaqueCaseId: string
  profileId: string
  output: {
    caseState: string
    executionValidity: string
    box: unknown
    cutoutPresent: boolean
    maskPackedSha256: string | null
    logicalReceiptIds: readonly number[]
    physicalReceiptIds: readonly number[]
  }
  logicalReceipts: readonly LogicalCaseReceipt[]
  physicalReceipts: readonly PhysicalCaseReceipt[]
  identitySha256?: string
}): ProviderRefusalReplayEvidence {
  const policy = providerRefusalReplayExecutionPolicySchema.safeParse(input.executionPolicy)
  const parsed = providerRefusalReplayEvidenceSchema.safeParse(input.evidence)
  if (!policy.success || !parsed.success) throw new RangeError('Unbound refusal replay evidence')
  const evidence = parsed.data
  if (
    evidence.policyId !== policy.data.policyId ||
    evidence.policySha256 !== policy.data.policySha256 ||
    evidence.hypothesisSha256 !== policy.data.hypothesisSha256 ||
    evidence.opaqueCaseId !== input.opaqueCaseId ||
    evidence.profileId !== input.profileId ||
    (input.identitySha256 !== undefined &&
      evidence.caseExecutionIdentitySha256 !== input.identitySha256)
  )
    throw new RangeError('Refusal evidence does not match the opted-in execution identity')
  if (
    input.output.caseState !== 'unknown' ||
    input.output.executionValidity !== 'valid' ||
    input.output.box !== null ||
    input.output.cutoutPresent ||
    input.output.maskPackedSha256 !== null
  )
    throw new RangeError('Refusal replay output must be geometry-free unknown')
  if (
    !input.output.logicalReceiptIds.includes(evidence.logicalReceiptId) ||
    !input.output.physicalReceiptIds.includes(evidence.physicalReceiptId)
  )
    throw new RangeError('Refusal evidence is not linked from its output row')
  const logical = input.logicalReceipts.find((item) => item.logicalId === evidence.logicalReceiptId)
  const physical = input.physicalReceipts.find(
    (item) => item.receiptId === evidence.physicalReceiptId,
  )
  if (
    !logical ||
    !physical ||
    logical.logicalId !== physical.logicalId ||
    logical.opaqueCaseId !== evidence.opaqueCaseId ||
    logical.profileId !== evidence.profileId ||
    logical.requestSha256 !== evidence.requestSha256 ||
    logical.outcome !== 'failed' ||
    logical.errorCode !== evidence.errorCode ||
    !logical.physicalIds.includes(physical.receiptId) ||
    physical.dispatchState !== 'confirmed' ||
    !physical.settled ||
    physical.physicalId !== evidence.globalPhysicalId ||
    physical.chargeState !== (physical.costUsd === null ? 'unknown' : 'known')
  )
    throw new RangeError('Refusal evidence receipt graph does not match its observed failure')
  return evidence
}
