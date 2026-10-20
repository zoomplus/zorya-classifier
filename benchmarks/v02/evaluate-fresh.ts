import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { assertActive } from '../../src/entities/errors.js'
import { loadFreshCorpus, readBoundedCorpusFile } from './fresh-corpus.js'
import { wholeObjectMetrics, pairedBootstrap } from './metrics.js'
import type { Box, LocalizationCase } from './metrics.js'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const pinnedFileSchema = z.object({ path: z.string().min(1), sha256: sha256Schema }).strict()
const boxSchema = z
  .object({
    left: z.number().finite().nonnegative(),
    top: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict()
const classificationSchema = z
  .object({
    status: z.enum(['ok', 'failed']),
    value: z.enum(['present', 'absent']).optional(),
    durationMs: z.number().finite().nonnegative(),
    calls: z.number().int().nonnegative(),
    requestHashes: z.array(sha256Schema).max(12).optional(),
    errorCode: z.string().max(100).optional(),
  })
  .strict()
  .refine((value) => value.status !== 'ok' || value.value !== undefined)
const localizationSchema = z
  .object({
    status: z.enum(['located', 'unknown', 'not-found', 'failed']),
    region: boxSchema.optional(),
    reason: z.string().max(512).optional(),
    durationMs: z.number().finite().nonnegative(),
    calls: z.number().int().nonnegative(),
    requestHashes: z.array(sha256Schema).max(12).optional(),
    errorCode: z.string().max(100).optional(),
  })
  .strict()
  .refine((value) => (value.status === 'located') === (value.region !== undefined))
const rowSchema = z
  .object({
    caseId: z.string().min(1),
    imageSha256: sha256Schema,
    profileId: z.string().min(1),
    classify: classificationSchema,
    locate: localizationSchema,
  })
  .strict()
const summarySchema = z
  .object({
    runId: z.string().min(1),
    status: z.enum(['complete', 'incomplete']),
    completedCaseIds: z.array(z.string().min(1)).max(120),
    missingCaseIds: z.array(z.string().min(1)).max(120),
    results: z.array(rowSchema).max(120),
  })
  .passthrough()
const runSchema = z
  .object({
    runId: z.string().min(1),
    profileId: z.string().min(1),
    plannedCaseIds: z.array(z.string().min(1)).min(1).max(120),
  })
  .passthrough()
const xyxySchema = z
  .tuple([
    z.number().finite().min(0).max(1),
    z.number().finite().min(0).max(1),
    z.number().finite().min(0).max(1),
    z.number().finite().min(0).max(1),
  ])
  .refine(([left, top, right, bottom]) => left < right && top < bottom)
const truthSchema = z
  .array(
    z
      .object({
        caseId: z.string().min(1),
        expectedPresence: z.enum(['present', 'absent']),
        targetBoxes: z.array(z.object({ xyxy: xyxySchema }).passthrough()).max(10000),
        negativeEvidence: z
          .union([
            z.record(z.unknown()),
            z
              .string()
              .min(1)
              .max(4000)
              .refine((value) => value.trim().length > 0),
          ])
          .nullable(),
      })
      .passthrough()
      .superRefine((value, context) => {
        if (
          value.expectedPresence === 'present'
            ? value.targetBoxes.length === 0
            : value.targetBoxes.length !== 0 ||
              value.negativeEvidence === null ||
              (typeof value.negativeEvidence === 'string'
                ? value.negativeEvidence.trim().length === 0
                : Object.keys(value.negativeEvidence).length === 0)
        )
          context.addIssue({
            code: 'custom',
            message: 'Missing independent positive/negative evidence',
          })
      }),
  )
  .min(1)
  .max(120)
const optionsSchema = z
  .object({
    summary: pinnedFileSchema,
    runManifest: pinnedFileSchema,
    corpus: z
      .object({ manifests: z.array(pinnedFileSchema).min(1).max(6), imageRoot: z.string().min(1) })
      .strict(),
    truths: z.array(pinnedFileSchema).min(1).max(6),
    output: z.string().min(1),
  })
  .strict()

async function readPinnedJson(
  file: z.infer<typeof pinnedFileSchema>,
  signal: AbortSignal,
): Promise<unknown> {
  const bytes = await readBoundedCorpusFile(file.path, 16 * 1024 * 1024, signal)
  try {
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw new Error('Evaluator artifact hash mismatch')
    return JSON.parse(bytes.toString('utf8')) as unknown
  } finally {
    bytes.fill(0)
  }
}

function sameIds(expected: readonly string[], actual: readonly string[], label: string): void {
  const sortedExpected = [...expected].sort()
  const sortedActual = [...actual].sort()
  if (
    new Set(expected).size !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.length !== actual.length ||
    sortedExpected.some((value, index) => value !== sortedActual[index])
  )
    throw new Error(`Evaluator ${label} set mismatch`)
}

/** Evaluator-only: invoke after immutable producer outputs exist. Never import into a producer. */
export async function evaluateFreshRun(input: z.input<typeof optionsSchema>, signal: AbortSignal) {
  assertActive(signal)
  const options = optionsSchema.parse(input)
  const run = runSchema.parse(await readPinnedJson(options.runManifest, signal))
  const summary = summarySchema.parse(await readPinnedJson(options.summary, signal))
  const corpus = await loadFreshCorpus(options.corpus, signal)
  const expectedIds = corpus.cases.map((item) => item.caseId)
  sameIds(expectedIds, run.plannedCaseIds, 'planned case')
  if (summary.runId !== run.runId) throw new Error('Evaluator run identity mismatch')
  sameIds(
    summary.results.map((item) => item.caseId),
    summary.completedCaseIds,
    'completed case',
  )
  sameIds(expectedIds, [...summary.completedCaseIds, ...summary.missingCaseIds], 'coverage')
  if ((summary.status === 'complete') !== (summary.missingCaseIds.length === 0))
    throw new Error('Evaluator completion status contradicts missing cases')
  const truth = []
  for (const file of options.truths)
    truth.push(...truthSchema.parse(await readPinnedJson(file, signal)))
  sameIds(
    expectedIds,
    truth.map((item) => item.caseId),
    'ground truth',
  )
  const truthById = new Map(truth.map((item) => [item.caseId, item]))
  const resultById = new Map(summary.results.map((item) => [item.caseId, item]))
  const profiles = new Set(summary.results.map((item) => item.profileId))
  if (profiles.size > 1 || [...profiles].some((profile) => profile !== run.profileId))
    throw new Error('Fresh summary profile contradicts its frozen manifest')
  const profileId = run.profileId
  const cases: LocalizationCase[] = []
  const rows = corpus.cases.map((source) => {
    const expected = truthById.get(source.caseId)!
    const result = resultById.get(source.caseId)
    if (result && result.imageSha256 !== source.image.sha256)
      throw new Error('Evaluator prediction/source hash mismatch')
    const boxes: Box[] = expected.targetBoxes.map(({ xyxy: [left, top, right, bottom] }) => ({
      left: left * source.image.width,
      top: top * source.image.height,
      width: (right - left) * source.image.width,
      height: (bottom - top) * source.image.height,
    }))
    if (
      result?.locate.region &&
      (result.locate.region.left + result.locate.region.width > source.image.width ||
        result.locate.region.top + result.locate.region.height > source.image.height)
    )
      throw new Error('Evaluator predicted box escaped the source raster')
    const outcome: LocalizationCase['outcome'] =
      result?.locate.status === 'located'
        ? { status: 'located', region: result.locate.region! }
        : { status: result?.locate.status ?? 'failed' }
    const item: LocalizationCase = {
      caseId: source.caseId,
      expected:
        expected.expectedPresence === 'present'
          ? { presence: 'present', boxes }
          : { presence: 'absent', verified: true },
      outcome,
    }
    cases.push(item)
    const [location] = wholeObjectMetrics([item]).rows
    return {
      caseId: source.caseId,
      expectedPresence: expected.expectedPresence,
      sourceStatus: result?.locate.status ?? 'not-attempted',
      classificationCorrect:
        result?.classify.status === 'ok' && result.classify.value === expected.expectedPresence,
      localizationCorrect: location!.correct,
    }
  })
  const output = {
    runId: run.runId,
    profileId,
    complete: summary.status === 'complete',
    coverage: {
      planned: expectedIds.length,
      reported: summary.results.length,
      missing: summary.missingCaseIds,
      denominatorPolicy:
        'all planned cases; missing results fail qualification, not invented API calls',
    },
    inputs: corpus.manifests,
    summarySha256: options.summary.sha256,
    runManifestSha256: options.runManifest.sha256,
    truthSha256: options.truths.map((item) => item.sha256),
    classificationCorrect: rows.filter((item) => item.classificationCorrect).length,
    localization: wholeObjectMetrics(cases),
    photoLocalization: wholeObjectMetrics(cases.filter((item) => item.caseId.startsWith('photo-'))),
    rows,
  }
  assertActive(signal)
  await writeFile(options.output, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
  return output
}

/** Compare frozen photo predictions only; no selection or promotion is performed here. */
export function compareFreshPhotoLocalization(
  candidate: Awaited<ReturnType<typeof evaluateFreshRun>>,
  control: Awaited<ReturnType<typeof evaluateFreshRun>>,
) {
  if (
    JSON.stringify(candidate.inputs) !== JSON.stringify(control.inputs) ||
    JSON.stringify(candidate.truthSha256) !== JSON.stringify(control.truthSha256)
  )
    throw new Error('Cannot compare different producer or annotation snapshots')
  const positivePhoto = (item: (typeof candidate.rows)[number]) =>
    item.caseId.startsWith('photo-') && item.expectedPresence === 'present'
  const candidateRows = candidate.rows.filter(positivePhoto)
  const controls = control.rows.filter(positivePhoto)
  sameIds(
    candidateRows.map((item) => item.caseId),
    controls.map((item) => item.caseId),
    'paired photo',
  )
  if (!candidate.complete || !control.complete) throw new Error('Cannot qualify an incomplete pair')
  const byId = new Map(controls.map((item) => [item.caseId, item]))
  return pairedBootstrap(
    candidateRows.map((item) => ({
      caseId: item.caseId,
      candidate: item.localizationCorrect,
      control: byId.get(item.caseId)!.localizationCorrect,
    })),
  )
}
