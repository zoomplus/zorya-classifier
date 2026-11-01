import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import {
  DEV40_STRATUM_QUOTAS,
  PHASE_DEV40_ID,
  PHASE_FLAT_DEV40_ID,
  PROFILE_CANDIDATE_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
  STRATUMS,
} from './constants.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { hashIdentity } from './hash-identity.js'
import type { H8aFreshStratum } from './constants.js'
import type { EvaluatorPrivateAnnotationBundle, PhaseFreeze } from './schemas.js'
import { evaluatorPrivateAnnotationBundleSchema, phaseFreezeSchema } from './schemas.js'

export const DEV_SCREEN_SEED = 0x7630_3308 as const

const SCREEN_SIZES = {
  dev8: {
    photo: { present: 2, absent: 1 },
    ui: { present: 2, absent: 1 },
    map: { present: 1, absent: 1 },
  },
  dev12: {
    photo: { present: 3, absent: 1 },
    ui: { present: 3, absent: 1 },
    map: { present: 3, absent: 1 },
  },
} as const

const profileBindingSchema = z
  .object({
    profileId: z.enum([PROFILE_CANDIDATE_ID, PROFILE_FLAT_CANDIDATE_ID, PROFILE_CONTROL_ID]),
    recipeIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    requestPolicyIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()

const screenCellSchema = z
  .object({
    stratum: z.enum(STRATUMS),
    expectedPresence: z.enum(['present', 'absent']),
    populationCount: z.number().int().positive(),
    dev8Quota: z.number().int().positive(),
    dev8InclusionProbability: z.number().finite().positive().max(1),
    dev8CaseIds: z.array(z.string().min(1)),
    dev12Quota: z.number().int().positive(),
    dev12InclusionProbability: z.number().finite().positive().max(1),
    dev12CaseIds: z.array(z.string().min(1)),
    seededPermutationCaseIds: z.array(z.string().min(1)),
  })
  .strict()

const screenSelectionBodySchema = z
  .object({
    schema: z.literal('h8a-dev-screen-selection-v1'),
    selectionAlgorithm: z.literal('mulberry32-fisher-yates-nested-v1'),
    seed: z.literal(DEV_SCREEN_SEED),
    devFreezeId: z.string().min(1),
    devFreezeCommitmentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    evaluatorAnnotationsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceBytesManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    pairedScheduleSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    qualitativeReviewProtocol: z.literal('no-apparent-collapse-main-review-v1'),
    qualitativeReviewOwner: z.literal('main-orchestrator'),
    profileBindings: z.tuple([profileBindingSchema, profileBindingSchema]),
    cells: z.tuple([
      screenCellSchema,
      screenCellSchema,
      screenCellSchema,
      screenCellSchema,
      screenCellSchema,
      screenCellSchema,
    ]),
    dev8CaseIds: z.array(z.string().min(1)).length(8),
    dev12CaseIds: z.array(z.string().min(1)).length(12),
  })
  .strict()

const devScreenSelectionSchema = screenSelectionBodySchema.extend({
  selectionCommitmentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
})

export type DevScreenSelection = z.infer<typeof devScreenSelectionSchema>
export type DevScreenId = 'dev8' | 'dev12' | 'dev40'

interface CellKey {
  stratum: H8aFreshStratum
  expectedPresence: 'present' | 'absent'
}

const CELL_KEYS: readonly CellKey[] = [
  { stratum: 'photo', expectedPresence: 'present' },
  { stratum: 'photo', expectedPresence: 'absent' },
  { stratum: 'ui', expectedPresence: 'present' },
  { stratum: 'ui', expectedPresence: 'absent' },
  { stratum: 'map', expectedPresence: 'present' },
  { stratum: 'map', expectedPresence: 'absent' },
]

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    let value = (state += 0x6d2b79f5)
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index--) {
    const selected = Math.floor(random() * (index + 1))
    ;[result[index], result[selected]] = [result[selected]!, result[index]!]
  }
  return result
}

function expectedDevCount(stratum: H8aFreshStratum, presence: 'present' | 'absent'): number {
  return DEV40_STRATUM_QUOTAS[stratum][presence]
}

function selectionBodyHash(body: z.infer<typeof screenSelectionBodySchema>): string {
  return hashIdentity(body)
}

export function buildDevScreenSelection(
  rawFreeze: PhaseFreeze,
  rawAnnotations: EvaluatorPrivateAnnotationBundle,
): DevScreenSelection {
  const freeze = phaseFreezeSchema.parse(rawFreeze)
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(rawAnnotations)
  if (
    (freeze.phaseId !== PHASE_DEV40_ID && freeze.phaseId !== PHASE_FLAT_DEV40_ID) ||
    annotations.phaseId !== freeze.phaseId
  )
    throw new RangeError('DEV screens require the matching frozen DEV40 cohort')
  if (annotations.freezeId !== freeze.freezeId)
    throw new RangeError('DEV screen annotations belong to a different freeze')
  const annotationsSha256 = computeEvaluatorAnnotationsSha256(annotations)
  if (annotationsSha256 !== freeze.evaluatorAnnotationsSha256)
    throw new RangeError('DEV screen annotation commitment mismatch')
  if (annotations.cases.length !== freeze.producerCases.length)
    throw new RangeError('DEV screen truth must cover every frozen producer row')

  const annotationById = new Map(annotations.cases.map((item) => [item.opaqueCaseId, item]))
  if (annotationById.size !== annotations.cases.length)
    throw new RangeError('DEV screen truth contains duplicate opaque case IDs')
  const producerIds = new Set(freeze.producerCases.map((item) => item.opaqueCaseId))
  if (
    annotationById.size !== producerIds.size ||
    [...annotationById.keys()].some((id) => !producerIds.has(id))
  )
    throw new RangeError('DEV screen truth IDs differ from the frozen producer cohort')

  const random = mulberry32(DEV_SCREEN_SEED)
  const cells = CELL_KEYS.map(({ stratum, expectedPresence }) => {
    const population = freeze.producerCases
      .filter((producer) => {
        const annotation = annotationById.get(producer.opaqueCaseId)
        const schedule = freeze.pairedSchedule.find(
          (item) => item.opaqueCaseId === producer.opaqueCaseId,
        )
        return schedule?.stratum === stratum && annotation?.expectedPresence === expectedPresence
      })
      .map((producer) => producer.opaqueCaseId)
    if (population.length !== expectedDevCount(stratum, expectedPresence))
      throw new RangeError(`DEV screen cell size mismatch for ${stratum}/${expectedPresence}`)
    const seededPermutationCaseIds = shuffle(population, random)
    const dev8Quota = SCREEN_SIZES.dev8[stratum][expectedPresence]
    const dev12Quota = SCREEN_SIZES.dev12[stratum][expectedPresence]
    if (dev8Quota > dev12Quota || dev12Quota > population.length)
      throw new RangeError(`Invalid nested screen quota for ${stratum}/${expectedPresence}`)
    return {
      stratum,
      expectedPresence,
      populationCount: population.length,
      dev8Quota,
      dev8InclusionProbability: dev8Quota / population.length,
      dev8CaseIds: seededPermutationCaseIds.slice(0, dev8Quota),
      dev12Quota,
      dev12InclusionProbability: dev12Quota / population.length,
      dev12CaseIds: seededPermutationCaseIds.slice(0, dev12Quota),
      seededPermutationCaseIds,
    }
  })

  const dev8Set = new Set(cells.flatMap((cell) => cell.dev8CaseIds))
  const dev12Set = new Set(cells.flatMap((cell) => cell.dev12CaseIds))
  if (dev8Set.size !== 8 || dev12Set.size !== 12 || [...dev8Set].some((id) => !dev12Set.has(id)))
    throw new RangeError('DEV8/DEV12 nested selection allocation is inconsistent')
  const scheduleOrder = freeze.pairedSchedule.map((row) => row.opaqueCaseId)
  const body = screenSelectionBodySchema.parse({
    schema: 'h8a-dev-screen-selection-v1',
    selectionAlgorithm: 'mulberry32-fisher-yates-nested-v1',
    seed: DEV_SCREEN_SEED,
    devFreezeId: freeze.freezeId,
    devFreezeCommitmentSha256: computePhaseFreezeCommitmentSha256(freeze),
    evaluatorAnnotationsSha256: annotationsSha256,
    sourceBytesManifestSha256: freeze.sourceBytesManifestSha256,
    pairedScheduleSha256: hashIdentity(freeze.pairedSchedule),
    qualitativeReviewProtocol: 'no-apparent-collapse-main-review-v1',
    qualitativeReviewOwner: 'main-orchestrator',
    profileBindings: freeze.profileBindings,
    cells,
    dev8CaseIds: scheduleOrder.filter((id) => dev8Set.has(id)),
    dev12CaseIds: scheduleOrder.filter((id) => dev12Set.has(id)),
  })
  return devScreenSelectionSchema.parse({
    ...body,
    selectionCommitmentSha256: selectionBodyHash(body),
  })
}

export function validateDevScreenSelection(
  rawSelection: DevScreenSelection,
  rawFreeze: PhaseFreeze,
  rawAnnotations: EvaluatorPrivateAnnotationBundle,
): DevScreenSelection {
  const selection = devScreenSelectionSchema.parse(rawSelection)
  const rebuilt = buildDevScreenSelection(rawFreeze, rawAnnotations)
  if (selection.selectionCommitmentSha256 !== rebuilt.selectionCommitmentSha256)
    throw new RangeError('DEV screen selection commitment mismatch')
  if (hashIdentity(selection) !== hashIdentity(rebuilt))
    throw new RangeError('DEV screen selection differs from deterministic frozen draw')
  return selection
}

export async function persistDevScreenSelection(
  path: string,
  rawSelection: DevScreenSelection,
): Promise<void> {
  const selection = devScreenSelectionSchema.parse(rawSelection)
  const { selectionCommitmentSha256, ...body } = selection
  if (selectionBodyHash(body) !== selectionCommitmentSha256)
    throw new RangeError('DEV screen selection commitment mismatch before persistence')
  const bytes = `${JSON.stringify(selection)}\n`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await writeFile(path, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
    const existing = await readFile(path, 'utf8')
    if (existing !== bytes) throw new RangeError('Existing DEV screen selection is immutable')
  }
}
