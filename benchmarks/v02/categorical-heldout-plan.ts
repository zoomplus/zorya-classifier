import { createHash } from 'node:crypto'
import { z } from 'zod'

export const heldoutTargetPolicies = Object.freeze(['target-plus-neutral-instruction-v1'] as const)
type HeldoutTargetPolicy = (typeof heldoutTargetPolicies)[number]
export const categoricalMethodSelectionSha256 =
  'fabb05c2c472c30a8cb20a5f9b6d697b932d94aedc43976359746463ef8708b9'

export const heldoutCandidatePolicy = Object.freeze({
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
  maxPhysicalCalls: 600,
  maxCostUsd: 10,
  unknownCostReserveUsd: 0.05,
  retries: 0,
  fallback: false,
  latencyEnvironment: 'heldout-development-soak-unranked',
  latencyRankingEligible: false,
})

export const heldoutNoImagePolicy = Object.freeze({
  timeoutMs: 120_000,
  maxInFlight: 1,
  maxInFlightCases: 1,
  concurrency: 1,
  maxQueue: 0,
  boxTolerancePx: 8,
  maxExtentPasses: 3,
  maxPhysicalCallsPerCase: 6,
  worstCasePhysicalCalls: 240,
  maxPhysicalCalls: 300,
  maxCostUsd: 5,
  unknownCostReserveUsd: 0.05,
  classifyMaxOutputTokens: 1024,
  locateMaxOutputTokens: 4096,
  retries: 0,
  fallback: false,
  latencyEnvironment: 'heldout-no-image-control-unranked',
  latencyRankingEligible: false,
})

export const heldoutNoImageRoute = Object.freeze({
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

interface HeldoutManifestPin {
  group: 'photo' | 'ui' | 'map'
  sha256: string
  cases: number
}

export interface HeldoutRunFreeze {
  schema: 'categorical-heldout-run-freeze-v1'
  phase: 'heldout'
  targetPolicy: HeldoutTargetPolicy
  methodSelectionSha256: string
  manifests: readonly HeldoutManifestPin[]
  producerSourceSha256: string
  noImageProducerSourceSha256: string
  candidateBudget: {
    maxPhysicalCalls: 600
    maxCostUsd: 10
    unknownCostReserveUsd: 0.05
  }
  noImageBudget: {
    maxPhysicalCalls: 300
    maxCostUsd: 5
    unknownCostReserveUsd: 0.05
  }
}

const heldoutFreezeSchema = z
  .object({
    schema: z.literal('categorical-heldout-run-freeze-v1'),
    phase: z.literal('heldout'),
    targetPolicy: z.literal('target-plus-neutral-instruction-v1'),
    methodSelectionSha256: z.literal(categoricalMethodSelectionSha256),
    manifests: z
      .array(
        z
          .object({
            group: z.enum(['photo', 'ui', 'map']),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            cases: z.number().int().positive(),
          })
          .strict(),
      )
      .length(3),
    producerSourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    noImageProducerSourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    candidateBudget: z
      .object({
        maxPhysicalCalls: z.literal(600),
        maxCostUsd: z.literal(10),
        unknownCostReserveUsd: z.literal(0.05),
      })
      .strict(),
    noImageBudget: z
      .object({
        maxPhysicalCalls: z.literal(300),
        maxCostUsd: z.literal(5),
        unknownCostReserveUsd: z.literal(0.05),
      })
      .strict(),
  })
  .strict()

const verifiedFreezes = new WeakSet<object>()

type VerifiedHeldoutFreeze = HeldoutRunFreeze

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export interface HeldoutCandidatePlan {
  runIdPrefix: string
  profileId: string
  phase: 'heldout'
  purpose: 'full frozen HELDOUT photo, independent UI and independent map producer pass'
  targetPolicy: HeldoutTargetPolicy
  methodSelectionSha256: string
  producerSourceSha256: string
  noImageProducerSourceSha256: string
  /** Only the pinned producer source closure; never a truth/evaluator digest. */
  sourceRole: 'producer-only'
  manifests: readonly HeldoutManifestPin[]
  expectedCases: { photo: 40; ui: 20; map: 20; total: 80 }
  budget: typeof heldoutCandidatePolicy
  route: {
    model: 'openai/gpt-6-luna-decisions'
    provider: 'openai'
    providerName: 'OpenAI'
    apiEndpoint: '/api/alpha/decisions'
    allowFallbacks: false
  }
}

export interface HeldoutNoImagePlan {
  runIdPrefix: string
  profileId: 'deepseek-flash-no-image-photo-heldout-v1'
  phase: 'heldout'
  purpose: 'full frozen HELDOUT photo-only no-image text control run'
  targetPolicy: HeldoutTargetPolicy
  methodSelectionSha256: string
  producerSourceSha256: string
  noImageProducerSourceSha256: string
  sourceRole: 'producer-only'
  manifest: HeldoutManifestPin
  expectedCases: 40
  budget: typeof heldoutNoImagePolicy
  route: typeof heldoutNoImageRoute
}

const sha256Pattern = /^[a-f0-9]{64}$/u

export function assertHeldoutFreezeDigest(actualSha256: string, expectedSha256: string): void {
  if (
    !sha256Pattern.test(actualSha256) ||
    !sha256Pattern.test(expectedSha256) ||
    actualSha256 !== expectedSha256
  )
    throw new TypeError('Heldout freeze file hash does not match the externally pinned digest')
}

export function verifyHeldoutFreezeBytes(
  bytes: Uint8Array,
  expectedSha256: string,
): VerifiedHeldoutFreeze {
  const actualSha256 = createHash('sha256').update(bytes).digest('hex')
  assertHeldoutFreezeDigest(actualSha256, expectedSha256)
  const freeze = heldoutFreezeSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
  deepFreeze(freeze)
  verifiedFreezes.add(freeze)
  return freeze
}

export function assertVerifiedHeldoutFreeze(
  freeze: unknown,
): asserts freeze is VerifiedHeldoutFreeze {
  if (!freeze || typeof freeze !== 'object' || !verifiedFreezes.has(freeze))
    throw new TypeError('HELDOUT dispatch requires the externally pinned verified freeze file')
}

function assertTargetPolicy(value: string): asserts value is HeldoutTargetPolicy {
  if (!heldoutTargetPolicies.includes(value as HeldoutTargetPolicy))
    throw new TypeError('Heldout target policy must be selected by the frozen DEV comparison')
}

function assertManifestPins(pins: readonly HeldoutManifestPin[]): void {
  const expected = [
    { group: 'photo', cases: 40 },
    { group: 'ui', cases: 20 },
    { group: 'map', cases: 20 },
  ] as const
  if (
    pins.length !== expected.length ||
    pins.some(
      (pin, index) =>
        pin.group !== expected[index]?.group ||
        pin.cases !== expected[index]?.cases ||
        !sha256Pattern.test(pin.sha256),
    ) ||
    pins[0]?.sha256 !== freshProposalHeldoutPhotoManifestSha256 ||
    pins[1]?.sha256 !== freshProposalHeldoutUiManifestSha256
  )
    throw new TypeError('Heldout inputs must be the frozen 40-photo, 20-UI and 20-map set')
}

function assertBudget<T extends Record<string, unknown>>(
  actual: T,
  expected: Record<string, unknown>,
  name: string,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw new TypeError(`${name} ${key} differs from frozen policy`)
  }
}

export function buildHeldoutPlans(freezeInput: unknown): {
  candidate: HeldoutCandidatePlan
  noImage: HeldoutNoImagePlan
} {
  const freeze = heldoutFreezeSchema.parse(freezeInput)
  if (freeze.schema !== 'categorical-heldout-run-freeze-v1' || freeze.phase !== 'heldout')
    throw new TypeError('A separate categorical HELDOUT freeze is required')
  if (!sha256Pattern.test(freeze.producerSourceSha256))
    throw new TypeError('Heldout producer source digest is malformed')
  assertTargetPolicy(freeze.targetPolicy)
  assertManifestPins(freeze.manifests)
  assertBudget(
    freeze.candidateBudget,
    {
      maxPhysicalCalls: 600,
      maxCostUsd: 10,
      unknownCostReserveUsd: 0.05,
    },
    'Candidate budget',
  )
  assertBudget(
    freeze.noImageBudget,
    {
      maxPhysicalCalls: 300,
      maxCostUsd: 5,
      unknownCostReserveUsd: 0.05,
    },
    'No-image budget',
  )

  const suffix = 'target-plus-neutral'
  const photoManifest = freeze.manifests[0]
  if (!photoManifest) throw new TypeError('Heldout photo manifest is missing')
  return {
    candidate: {
      runIdPrefix: `v02-categorical-heldout-${suffix}`,
      profileId: `native-luna-categorical-presence-sam-heldout-${suffix}-v1`,
      phase: 'heldout',
      purpose: 'full frozen HELDOUT photo, independent UI and independent map producer pass',
      targetPolicy: freeze.targetPolicy,
      methodSelectionSha256: freeze.methodSelectionSha256,
      producerSourceSha256: freeze.producerSourceSha256,
      noImageProducerSourceSha256: freeze.noImageProducerSourceSha256,
      sourceRole: 'producer-only',
      manifests: freeze.manifests.map((manifest) => ({ ...manifest })),
      expectedCases: { photo: 40, ui: 20, map: 20, total: 80 },
      budget: heldoutCandidatePolicy,
      route: {
        model: 'openai/gpt-6-luna-decisions',
        provider: 'openai',
        providerName: 'OpenAI',
        apiEndpoint: '/api/alpha/decisions',
        allowFallbacks: false,
      },
    },
    noImage: {
      runIdPrefix: 'v02-deepseek-no-image-heldout-photo',
      profileId: 'deepseek-flash-no-image-photo-heldout-v1',
      phase: 'heldout',
      purpose: 'full frozen HELDOUT photo-only no-image text control run',
      targetPolicy: freeze.targetPolicy,
      methodSelectionSha256: freeze.methodSelectionSha256,
      producerSourceSha256: freeze.producerSourceSha256,
      noImageProducerSourceSha256: freeze.noImageProducerSourceSha256,
      sourceRole: 'producer-only',
      manifest: { ...photoManifest },
      expectedCases: 40,
      budget: heldoutNoImagePolicy,
      route: heldoutNoImageRoute,
    },
  }
}

export const freshProposalHeldoutPhotoManifestSha256 =
  '5d125e853ed93558ab634e406ca90cf931569953279c1630d49dcf239b9baa79'
export const freshProposalHeldoutUiManifestSha256 =
  '1bf7940fd92fdc1f7fa295296dfc5f84c5f4c32ccc41b7a2e80a0059bff918c3'
