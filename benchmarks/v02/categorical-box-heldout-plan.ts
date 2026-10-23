import { createHash } from 'node:crypto'
import { z } from 'zod'

const boxHeldoutSelectionVersion = 'box-confirmation-dev-method-selection-v1' as const
export const boxHeldoutMethodSelectionSha256 =
  '3b576871c36d904203ef06e0cf26af5847a71a92c2df3647725d532238258c5e'
export const boxHeldoutProfileIds = Object.freeze({
  candidate: 'native-luna-box-confirmation-sam-target-plus-neutral-heldout-v1',
  noImage: 'deepseek-flash-no-image-photo-box-confirmation-heldout-v1',
})

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
export const boxHeldoutCandidatePolicy = Object.freeze({
  timeoutMs: 120_000,
  maxInFlight: 2,
  maxInFlightCases: 2,
  nativeMaxActive: 1,
  nativeMaxWaiting: 2,
  nativeThreads: 2,
  boxTolerancePx: 8,
  maxExtentPasses: 3,
  maxPhysicalCallsPerCase: 6,
  expectedCaseCount: 80,
  worstCasePhysicalCalls: 480,
  retries: 0,
  fallback: false,
  maxPhysicalCalls: 600,
  maxCostUsd: 10,
  unknownCostReserveUsd: 0.05,
  latencyEnvironment: 'heldout-development-soak-unranked',
  latencyRankingEligible: false,
})
export const boxHeldoutNoImagePolicy = Object.freeze({
  timeoutMs: 120_000,
  concurrency: 1,
  maxQueue: 0,
  boxTolerancePx: 8,
  maxExtentPasses: 3,
  retries: 0,
  fallback: false,
  maxPhysicalCalls: 300,
  maxCostUsd: 5,
  unknownCostReserveUsd: 0.05,
  classifyMaxOutputTokens: 1024,
  locateMaxOutputTokens: 4096,
  maxInFlight: 1,
  maxInFlightCases: 1,
  maxPhysicalCallsPerCase: 6,
  worstCasePhysicalCalls: 240,
  latencyEnvironment: 'heldout-no-image-control-unranked',
  latencyRankingEligible: false,
})
export const boxHeldoutNoImageRoute = Object.freeze({
  id: 'together-deepseek-flash-text-v1',
  model: 'deepseek/deepseek-v4.1-flash',
  provider: 'together',
  providerName: 'Together',
  apiEndpoint: '/api/v1/chat/completions',
  allowFallbacks: false,
  responseFormat: 'json-schema',
  reasoningEffort: 'none',
  promptVariant: 'grammar-plus-examples',
  transportVariant: 'none-json-schema',
  imagePartsRemoved: true,
  imageEncoder: null,
  objectProposals: null,
  segmentation: false,
  ocr: false,
})
const manifestPinSchema = z
  .object({
    group: z.enum(['photo', 'ui', 'map']),
    sha256: hashSchema,
    cases: z.number().int().positive(),
  })
  .strict()
const candidateBudgetSchema = z
  .object({
    maxPhysicalCalls: z.literal(600),
    maxCostUsd: z.literal(10),
    unknownCostReserveUsd: z.literal(0.05),
    maxPhysicalCallsPerCase: z.literal(6),
    maxInFlightCases: z.literal(2),
    timeoutMs: z.literal(120_000),
    nativeMaxActive: z.literal(1),
    nativeMaxWaiting: z.literal(2),
    nativeThreads: z.literal(2),
    boxTolerancePx: z.literal(8),
    maxExtentPasses: z.literal(3),
    retries: z.literal(0),
    fallback: z.literal(false),
  })
  .strict()
const controlBudgetSchema = z
  .object({
    maxPhysicalCalls: z.literal(300),
    maxCostUsd: z.literal(5),
    unknownCostReserveUsd: z.literal(0.05),
    maxPhysicalCallsPerCase: z.literal(6),
    maxInFlightCases: z.literal(1),
    timeoutMs: z.literal(120_000),
    boxTolerancePx: z.literal(8),
    maxExtentPasses: z.literal(3),
    retries: z.literal(0),
    fallback: z.literal(false),
    classifyMaxOutputTokens: z.literal(1024),
    locateMaxOutputTokens: z.literal(4096),
    imagePartsRemoved: z.literal(true),
    imageEncoder: z.null(),
    objectProposals: z.null(),
    segmentation: z.literal(false),
    ocr: z.literal(false),
  })
  .strict()

const boxHeldoutFreezeSchema = z
  .object({
    schema: z.literal('categorical-box-heldout-run-freeze-v1'),
    phase: z.literal('heldout'),
    profileId: z.literal(boxHeldoutProfileIds.candidate),
    selectionVersion: z.literal(boxHeldoutSelectionVersion),
    methodSelectionSha256: z.literal(boxHeldoutMethodSelectionSha256),
    targetPolicy: z.literal('target-plus-neutral-instruction-v1'),
    manifests: z.tuple([manifestPinSchema, manifestPinSchema, manifestPinSchema]),
    producerSourceSha256: hashSchema,
    noImageProducerSourceSha256: hashSchema,
    candidateBudget: candidateBudgetSchema,
    noImageBudget: controlBudgetSchema,
  })
  .strict()
  .superRefine((freeze, context) => {
    const expected = [
      { group: 'photo', cases: 40 },
      { group: 'ui', cases: 20 },
      { group: 'map', cases: 20 },
    ] as const
    for (const [index, pin] of freeze.manifests.entries()) {
      if (pin.group !== expected[index]?.group || pin.cases !== expected[index]?.cases)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['manifests', index],
          message: 'Box HELDOUT inputs must be ordered 40-photo, 20-UI and 20-map groups',
        })
    }
  })

const verifiedFreezes = new WeakSet<object>()

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

type VerifiedBoxHeldoutFreeze = z.infer<typeof boxHeldoutFreezeSchema>
type BoxHeldoutManifestPin = z.infer<typeof manifestPinSchema>

export interface BoxHeldoutCandidatePlan {
  runIdPrefix: 'v02-box-confirmation-heldout-target-plus-neutral'
  profileId: typeof boxHeldoutProfileIds.candidate
  phase: 'heldout'
  purpose: 'full frozen HELDOUT box-confirmation photo, independent UI and independent map pass'
  targetPolicy: 'target-plus-neutral-instruction-v1'
  methodSelectionSha256: string
  producerSourceSha256: string
  noImageProducerSourceSha256: string
  sourceRole: 'producer-only'
  manifests: readonly BoxHeldoutManifestPin[]
  expectedCases: { photo: 40; ui: 20; map: 20; total: 80 }
  budget: typeof boxHeldoutCandidatePolicy
  route: {
    model: 'openai/gpt-6-luna-decisions'
    provider: 'openai'
    providerName: 'OpenAI'
    apiEndpoint: '/api/alpha/decisions'
    allowFallbacks: false
  }
}

export interface BoxHeldoutNoImagePlan {
  runIdPrefix: 'v02-box-confirmation-no-image-heldout-photo'
  profileId: typeof boxHeldoutProfileIds.noImage
  phase: 'heldout'
  purpose: 'full frozen HELDOUT photo-only no-image control for box-confirmation target policy'
  targetPolicy: 'target-plus-neutral-instruction-v1'
  methodSelectionSha256: string
  producerSourceSha256: string
  noImageProducerSourceSha256: string
  sourceRole: 'producer-only'
  manifest: BoxHeldoutManifestPin
  expectedCases: 40
  budget: typeof boxHeldoutNoImagePolicy
  route: typeof boxHeldoutNoImageRoute
}

export function verifyBoxHeldoutFreezeBytes(
  bytes: Uint8Array,
  expectedSha256: string,
): VerifiedBoxHeldoutFreeze {
  if (!hashSchema.safeParse(expectedSha256).success)
    throw new TypeError('Box HELDOUT freeze requires an external SHA-256 pin')
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expectedSha256)
    throw new TypeError('Box HELDOUT freeze bytes differ from the external SHA-256 pin')
  const parsed = deepFreeze(
    boxHeldoutFreezeSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8'))),
  )
  verifiedFreezes.add(parsed)
  return parsed
}

export function assertVerifiedBoxHeldoutFreeze(
  value: unknown,
): asserts value is VerifiedBoxHeldoutFreeze {
  if (!value || typeof value !== 'object' || !verifiedFreezes.has(value))
    throw new TypeError('Box HELDOUT execution requires externally pinned freeze bytes')
}

export function buildBoxHeldoutPlans(freezeInput: unknown): {
  candidate: BoxHeldoutCandidatePlan
  noImage: BoxHeldoutNoImagePlan
} {
  assertVerifiedBoxHeldoutFreeze(freezeInput)
  const freeze = boxHeldoutFreezeSchema.parse(freezeInput)
  const manifests = freeze.manifests.map((pin) => ({ ...pin }))
  const photo = manifests[0]
  if (!photo) throw new TypeError('Box HELDOUT photo pin is missing')
  return deepFreeze({
    candidate: {
      runIdPrefix: 'v02-box-confirmation-heldout-target-plus-neutral',
      profileId: boxHeldoutProfileIds.candidate,
      phase: 'heldout',
      purpose:
        'full frozen HELDOUT box-confirmation photo, independent UI and independent map pass',
      targetPolicy: freeze.targetPolicy,
      methodSelectionSha256: freeze.methodSelectionSha256,
      producerSourceSha256: freeze.producerSourceSha256,
      noImageProducerSourceSha256: freeze.noImageProducerSourceSha256,
      sourceRole: 'producer-only',
      manifests,
      expectedCases: { photo: 40, ui: 20, map: 20, total: 80 },
      budget: boxHeldoutCandidatePolicy,
      route: {
        model: 'openai/gpt-6-luna-decisions',
        provider: 'openai',
        providerName: 'OpenAI',
        apiEndpoint: '/api/alpha/decisions',
        allowFallbacks: false,
      },
    },
    noImage: {
      runIdPrefix: 'v02-box-confirmation-no-image-heldout-photo',
      profileId: boxHeldoutProfileIds.noImage,
      phase: 'heldout',
      purpose: 'full frozen HELDOUT photo-only no-image control for box-confirmation target policy',
      targetPolicy: freeze.targetPolicy,
      methodSelectionSha256: freeze.methodSelectionSha256,
      producerSourceSha256: freeze.producerSourceSha256,
      noImageProducerSourceSha256: freeze.noImageProducerSourceSha256,
      sourceRole: 'producer-only',
      manifest: photo,
      expectedCases: 40,
      budget: boxHeldoutNoImagePolicy,
      route: boxHeldoutNoImageRoute,
    },
  })
}
