import { z } from 'zod'
import { resolve } from 'node:path'
import { hashIdentity } from './hash-identity.js'
import { isWithinDirectory, readPinnedReplayFile } from './dev-replay-files.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const MAX_PREPARATION_BYTES = 1_048_576
const MAX_GROUP_SPLIT_BYTES = 1_048_576
const MAX_HISTORICAL_PIXELS_BYTES = 4_194_304

export const nativeSelectorQualHistoricalExclusionsSchema = z
  .object({
    sourceGroupSplit: z
      .object({ path: z.string().min(1), sha256: digest, bytes: z.number().int().positive() })
      .strict(),
    historicalPixels: z
      .object({ path: z.string().min(1), sha256: digest, bytes: z.number().int().positive() })
      .strict(),
  })
  .strict()

const historicalGroupSplitSchema = z
  .object({
    schema: z.literal('h8a-dev-source-group-split-v1'),
    devSourceGroupIds: z.array(z.string().min(1)),
    qualificationSourceGroupIds: z.array(z.string().min(1)),
    exclusionSourceGroupIds: z.array(z.string().min(1)),
    devCommitmentSha256: digest,
    qualificationCommitmentSha256: digest,
    exclusionCommitmentSha256: digest,
  })
  .strict()

const historicalPixelsSchema = z
  .object({
    schema: z.literal('study2-prior-pixel-exclusion-index-v1'),
    algorithm: z.literal('benchmarks/v03/fresh-dev/imaging.py:perceptual_hash64_from_rgb'),
    sha256Implementation: z.literal(
      'ea06f305375ced9341d07ef5afcdc615f0b93afc340939a2bc2c654bd97495f1',
    ),
    maximumDistanceRejected: z.literal(4),
    rows: z
      .array(
        z
          .object({
            encodedSha256: digest,
            decodedRgbSha256: digest,
            perceptualHash64: z.string().regex(/^[a-f0-9]{16}$/u),
          })
          .strict(),
      )
      .length(348),
  })
  .strict()

const preparationSchema = z
  .object({
    schema: z.literal('h8a-independent-dev40-v2-preparation-v1'),
    sourceGroupSplit: z.object({ path: z.string().min(1), sha256: digest }).strict(),
    historicalPixels: z.object({ path: z.string().min(1), sha256: digest }).strict(),
  })
  .passthrough()

export interface VerifiedHistoricalExclusionSets {
  devSourceGroups: readonly string[]
  sourceGroups: readonly string[]
  encodedHashes: readonly string[]
  pillowRgbHashes: readonly string[]
  perceptualHashes: readonly string[]
}

const normalizeSourceGroup = (value: string): string => value.replace(/\/+$/u, '')

function resolvePinnedPath(path: string, root: string): string {
  return resolve(root, path)
}

export async function verifyNativeSelectorQualHistoricalExclusions(input: {
  sourceAuditReferences: readonly { path: string; sha256: string }[]
  exposed: z.infer<typeof nativeSelectorQualHistoricalExclusionsSchema>
  offlineNamespaceRoot?: string
  expectedDevSourceGroups?: readonly string[]
}): Promise<VerifiedHistoricalExclusionSets> {
  const offlineRoot = input.offlineNamespaceRoot
  const artifactRoot = offlineRoot ?? '/root/.codex/artifacts'
  const preparationRef = input.sourceAuditReferences.find((ref) =>
    offlineRoot
      ? isWithinDirectory(offlineRoot, ref.path)
      : ref.path ===
        '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/execution-v2/preparation.json',
  )
  if (!preparationRef)
    throw new RangeError('Corrected QUAL parent source audit does not pin its preparation record')
  if (
    !offlineRoot &&
    preparationRef.sha256 !== '0346ed656f1c5fc4be7e353e266cb73cba466e4dc6c08201af49b45fae74b032'
  )
    throw new RangeError('Corrected QUAL parent preparation digest differs from its pinned lineage')
  if (offlineRoot && !isWithinDirectory(offlineRoot, preparationRef.path))
    throw new RangeError('Offline historical preparation escapes its disposable namespace')
  const preparationBytes = await readPinnedReplayFile(
    preparationRef.path,
    preparationRef.sha256,
    MAX_PREPARATION_BYTES,
  )
  if (!offlineRoot && preparationBytes.byteLength !== 5_876)
    throw new RangeError('Pinned historical preparation byte count changed')
  const preparation = preparationSchema.parse(JSON.parse(preparationBytes.toString('utf8')))
  const expectedGroupPath = resolvePinnedPath(preparation.sourceGroupSplit.path, artifactRoot)
  const expectedPixelsPath = resolvePinnedPath(preparation.historicalPixels.path, artifactRoot)
  if (
    expectedGroupPath !== input.exposed.sourceGroupSplit.path ||
    preparation.sourceGroupSplit.sha256 !== input.exposed.sourceGroupSplit.sha256 ||
    expectedPixelsPath !== input.exposed.historicalPixels.path ||
    preparation.historicalPixels.sha256 !== input.exposed.historicalPixels.sha256
  )
    throw new RangeError('QUAL historical exclusion refs differ from the parent-linked preparation')
  for (const ref of [input.exposed.sourceGroupSplit, input.exposed.historicalPixels]) {
    if (offlineRoot && !isWithinDirectory(offlineRoot, ref.path))
      throw new RangeError('Offline historical exclusion escapes its disposable namespace')
    if (!offlineRoot && !isWithinDirectory('/root/.codex/artifacts', ref.path))
      throw new RangeError('Historical exclusion ref escapes the trusted artifact root')
  }
  const groupBytes = await readPinnedReplayFile(
    input.exposed.sourceGroupSplit.path,
    input.exposed.sourceGroupSplit.sha256,
    MAX_GROUP_SPLIT_BYTES,
  )
  const pixelsBytes = await readPinnedReplayFile(
    input.exposed.historicalPixels.path,
    input.exposed.historicalPixels.sha256,
    MAX_HISTORICAL_PIXELS_BYTES,
  )
  if (
    groupBytes.byteLength !== input.exposed.sourceGroupSplit.bytes ||
    pixelsBytes.byteLength !== input.exposed.historicalPixels.bytes
  )
    throw new RangeError('QUAL historical exclusion byte count differs from the pinned ref')
  if (
    !offlineRoot &&
    (input.exposed.sourceGroupSplit.path !==
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/execution-v2/source-group-split-v1.json' ||
      input.exposed.sourceGroupSplit.sha256 !==
        '385c33347610d1ceb0aeb3c49190acfebbeeabe100a9b3c50701422477cd0846' ||
      input.exposed.sourceGroupSplit.bytes !== 22_152 ||
      input.exposed.historicalPixels.path !==
        '/root/.codex/artifacts/zorya-classifier-mcp-20261101/original-h8a-independent-dev40-v2/main/historical-pixels.json' ||
      input.exposed.historicalPixels.sha256 !==
        '510cb48fa740721123ce0ae4cc61c607675503f3ae0399bc9d0afb2487f6bb9d' ||
      input.exposed.historicalPixels.bytes !== 84_843)
  )
    throw new RangeError(
      'Corrected QUAL historical exclusion pins differ from the frozen source set',
    )
  const groups = historicalGroupSplitSchema.parse(JSON.parse(groupBytes.toString('utf8')))
  const pixels = historicalPixelsSchema.parse(JSON.parse(pixelsBytes.toString('utf8')))
  const normalizedDev = groups.devSourceGroupIds.map(normalizeSourceGroup).sort()
  const normalizedExcluded = groups.exclusionSourceGroupIds.map(normalizeSourceGroup).sort()
  const normalizedQualification = groups.qualificationSourceGroupIds.map(normalizeSourceGroup)
  if (
    groups.devSourceGroupIds.length !== 24 ||
    groups.exclusionSourceGroupIds.length !== 440 ||
    groups.qualificationSourceGroupIds.length !== 0 ||
    new Set(normalizedDev).size !== 24 ||
    new Set(normalizedExcluded).size !== 440 ||
    normalizedDev.some((value) => !value) ||
    normalizedExcluded.some((value) => !value) ||
    normalizedDev.some((value) => normalizedExcluded.includes(value)) ||
    normalizedQualification.length !== 0 ||
    groups.devCommitmentSha256 !== hashIdentity(normalizedDev) ||
    groups.qualificationCommitmentSha256 !== hashIdentity(normalizedQualification) ||
    groups.exclusionCommitmentSha256 !== hashIdentity(normalizedExcluded)
  )
    throw new RangeError('Parent-linked historical source-group split is invalid')
  if (input.expectedDevSourceGroups) {
    const expectedDev = [...new Set(input.expectedDevSourceGroups.map(normalizeSourceGroup))].sort()
    if (
      expectedDev.length !== 24 ||
      expectedDev.length !== normalizedDev.length ||
      expectedDev.some((group, index) => group !== normalizedDev[index])
    )
      throw new RangeError('Historical source-group split does not match the selected DEV cohort')
  }
  return Object.freeze({
    devSourceGroups: Object.freeze(normalizedDev),
    sourceGroups: Object.freeze(normalizedExcluded),
    encodedHashes: Object.freeze(pixels.rows.map((row) => row.encodedSha256)),
    pillowRgbHashes: Object.freeze(pixels.rows.map((row) => row.decodedRgbSha256)),
    perceptualHashes: Object.freeze(pixels.rows.map((row) => row.perceptualHash64)),
  })
}
