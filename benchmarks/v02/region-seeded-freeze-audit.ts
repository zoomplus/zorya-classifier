import { z } from 'zod'
import {
  checkedRegionNoImageRecipe,
  checkedRegionSeededRecipe,
  regionPresenceFirstCheckedNoImageProfile,
  regionPresenceFirstCheckedProfile,
  regionSeededAssets,
} from './region-seeded-runner.js'
import { hashCanonical } from './protocol.js'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const profileRouteSchema = z
  .object({
    model: z.string().min(1),
    provider: z.string().min(1),
    providerName: z.string().min(1),
    apiEndpoint: z.string().min(1),
    allowFallbacks: z.literal(false),
  })
  .strict()
const manifestDescriptorSchema = z
  .object({ sha256: digestSchema, cases: z.number().int().positive() })
  .strict()
const taskHashSchema = z.object({ caseId: z.string().min(1), taskSha256: digestSchema }).strict()
const classificationClassSchema = z
  .object({ id: z.enum(['present', 'absent']), description: z.string().min(1) })
  .strict()
const promptPolicySchema = z
  .object({
    targetPolicy: z.literal('target-plus-neutral-instruction-v1'),
    classificationClasses: z.tuple([classificationClassSchema, classificationClassSchema]),
    classificationInstruction: z.literal(
      'Use only the supplied image. Choose exactly one closed label.',
    ),
    extraction: z.string().min(1),
    noImageControl: z.literal(
      'Remove all image parts at DecisionPort boundary; assert no image part at actual fetch; no segmentation, OCR, or hidden CV.',
    ),
    presenceFirstGate: z.literal(
      'Reuse the existing closed classification result. Run no region search or segmentation unless classification succeeded with value present; absent and failed classifications are retained with extraction skipped.',
    ),
  })
  .strict()
const candidateManifestSchema = z
  .object({
    profileId: z.literal(regionPresenceFirstCheckedProfile.id),
    phase: z.literal('dev'),
    variant: z.literal('region-seeded-sam'),
    checkedRegion: z.literal(true),
    producerSourceSha256: digestSchema,
    route: profileRouteSchema,
    manifests: z.array(manifestDescriptorSchema).length(3),
    taskHashes: z.array(taskHashSchema).length(40),
    budget: z
      .object({
        maxPhysicalCalls: z.literal(250),
        maxCostUsd: z.literal(5),
        unknownCostReserveUsd: z.literal(0.05),
      })
      .strict(),
    variantSha256: digestSchema,
    promptPolicy: promptPolicySchema,
  })
  .passthrough()
const freezeSchema = z
  .object({
    schema: z.literal('region-seeded-development-control-r2-freeze-v1'),
    phase: z.literal('dev'),
    producerSourceSha256: digestSchema,
    route: profileRouteSchema,
    inputs: z.array(manifestDescriptorSchema).length(3),
    profileIds: z
      .object({
        candidate: z.literal(regionPresenceFirstCheckedProfile.id),
        control: z.literal(regionPresenceFirstCheckedNoImageProfile.id),
      })
      .strict(),
    variantSha256: z.object({ candidate: digestSchema, control: digestSchema }).strict(),
    promptPolicies: z
      .object({ candidate: promptPolicySchema, control: promptPolicySchema })
      .strict(),
  })
  .passthrough()

export const regionSeededV3Prompts = Object.freeze({
  candidate: Object.freeze({
    targetPolicy: 'target-plus-neutral-instruction-v1' as const,
    classificationClasses: [
      {
        id: 'present' as const,
        description: 'The target in the question is visible in this image.',
      },
      {
        id: 'absent' as const,
        description: 'The target in the question is not visible in this image.',
      },
    ] as const,
    classificationInstruction:
      'Use only the supplied image. Choose exactly one closed label.' as const,
    extraction:
      'Original three-choice region search once; full-source MobileSAM seed-region extraction; up to two closed visible-box containment checks, with at most one native enclosing-mask expansion and one recheck; no separate extent search.',
    noImageControl:
      'Remove all image parts at DecisionPort boundary; assert no image part at actual fetch; no segmentation, OCR, or hidden CV.' as const,
    presenceFirstGate:
      'Reuse the existing closed classification result. Run no region search or segmentation unless classification succeeded with value present; absent and failed classifications are retained with extraction skipped.' as const,
  }),
  control: Object.freeze({
    targetPolicy: 'target-plus-neutral-instruction-v1' as const,
    classificationClasses: [
      {
        id: 'present' as const,
        description: 'The target in the question is visible in this image.',
      },
      {
        id: 'absent' as const,
        description: 'The target in the question is not visible in this image.',
      },
    ] as const,
    classificationInstruction:
      'Use only the supplied image. Choose exactly one closed label.' as const,
    extraction:
      'Paired no-image control runs only the original three-choice region search; no segmentation or visible-box checks.',
    noImageControl:
      'Remove all image parts at DecisionPort boundary; assert no image part at actual fetch; no segmentation, OCR, or hidden CV.' as const,
    presenceFirstGate:
      'Reuse the existing closed classification result. Run no region search or segmentation unless classification succeeded with value present; absent and failed classifications are retained with extraction skipped.' as const,
  }),
})

type CandidateManifest = z.infer<typeof candidateManifestSchema>

function variantHash(
  manifest: CandidateManifest,
  variant: 'region-seeded-sam' | 'no-image-control',
  promptPolicy: z.infer<typeof promptPolicySchema>,
): string {
  const policy = {
    ...(variant === 'region-seeded-sam' ? checkedRegionSeededRecipe : checkedRegionNoImageRecipe),
    maxPhysicalCalls: manifest.budget.maxPhysicalCalls,
    maxCostUsd: manifest.budget.maxCostUsd,
    requireClassifiedPresence: true as const,
  }
  return hashCanonical({
    profileId:
      variant === 'region-seeded-sam'
        ? regionPresenceFirstCheckedProfile.id
        : regionPresenceFirstCheckedNoImageProfile.id,
    phase: 'dev',
    variant,
    requireClassifiedPresence: true,
    checkedRegion: true,
    route: manifest.route,
    policy,
    promptPolicy,
    manifests: manifest.manifests,
    taskHashes: manifest.taskHashes,
    source: manifest.producerSourceSha256,
    nativeAssets: variant === 'region-seeded-sam' ? regionSeededAssets : null,
  })
}

/**
 * Verify both DEV v3 profile identities from a completed candidate manifest and a
 * prospective per-profile freeze. This reads metadata only; it never loads images,
 * truths, credentials, or provider results.
 */
export function verifyRegionSeededControlR2Freeze(
  candidateManifestValue: unknown,
  freezeValue: unknown,
): { candidateVariantSha256: string; controlVariantSha256: string } {
  const manifest = candidateManifestSchema.parse(candidateManifestValue)
  const freeze = freezeSchema.parse(freezeValue)
  const expected = createRegionSeededControlR2Identity(manifest)
  if (
    freeze.producerSourceSha256 !== manifest.producerSourceSha256 ||
    hashCanonical(freeze.route) !== hashCanonical(manifest.route) ||
    hashCanonical(freeze.inputs) !== hashCanonical(manifest.manifests)
  )
    throw new TypeError('Freeze source, route, or input manifests do not match the candidate run')
  if (hashCanonical(freeze.promptPolicies) !== hashCanonical(expected.promptPolicies))
    throw new TypeError('Freeze prompt policies must match each profile-specific v3 task')
  if (
    hashCanonical(freeze.profileIds) !== hashCanonical(expected.profileIds) ||
    hashCanonical(freeze.variantSha256) !== hashCanonical(expected.variantSha256)
  )
    throw new TypeError('Freeze variant identity does not match the canonical producer payload')
  return {
    candidateVariantSha256: expected.variantSha256.candidate,
    controlVariantSha256: expected.variantSha256.control,
  }
}

/** Create the only accepted pair of identities from the completed candidate manifest. */
export function createRegionSeededControlR2Identity(candidateManifestValue: unknown) {
  const manifest = candidateManifestSchema.parse(candidateManifestValue)
  const candidatePrompt = promptPolicySchema.parse(regionSeededV3Prompts.candidate)
  const controlPrompt = promptPolicySchema.parse(regionSeededV3Prompts.control)
  if (hashCanonical(manifest.promptPolicy) !== hashCanonical(candidatePrompt))
    throw new TypeError('Candidate manifest prompt policy does not match the frozen v3 task')
  const candidateVariantSha256 = variantHash(manifest, 'region-seeded-sam', candidatePrompt)
  const controlVariantSha256 = variantHash(manifest, 'no-image-control', controlPrompt)
  if (candidateVariantSha256 !== manifest.variantSha256)
    throw new TypeError('Candidate manifest variant identity does not match its canonical payload')
  return {
    profileIds: {
      candidate: regionPresenceFirstCheckedProfile.id,
      control: regionPresenceFirstCheckedNoImageProfile.id,
    },
    variantSha256: {
      candidate: candidateVariantSha256,
      control: controlVariantSha256,
    },
    promptPolicies: {
      candidate: candidatePrompt,
      control: controlPrompt,
    },
  }
}
