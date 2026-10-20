import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  compareFreshPhotoLocalization,
  evaluateFreshRun,
} from '../benchmarks/v02/evaluate-fresh.js'

const signal = new AbortController().signal
async function pinned(directory: string, name: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value))
  const path = join(directory, name)
  await writeFile(path, bytes, { flag: 'wx' })
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') }
}
async function fixture(directory: string) {
  const ids = ['photo-present-a', 'photo-present-b', 'photo-absent-c', 'ui-present-d']
  const producer = ids.map((caseId) => ({
    caseId,
    image: { path: 'unopened-image.png', sha256: '1'.repeat(64), width: 100, height: 100 },
    locate: { target: 'the whole object' },
    classify: { options: ['present', 'absent'] },
  }))
  const truth = ids.map((caseId, index) => ({
    caseId,
    expectedPresence: index === 2 ? 'absent' : 'present',
    targetBoxes: index === 2 ? [] : [{ xyxy: [0.1, 0.1, 0.5, 0.5] }],
    negativeEvidence: index === 2 ? { method: 'independent fixture inventory' } : null,
  }))
  const results = ids.map((caseId, index) => ({
    caseId,
    imageSha256: '1'.repeat(64),
    profileId: 'fixture-vision',
    classify: { status: 'ok', value: 'present', durationMs: 1, calls: 1 },
    locate: {
      status: index === 1 ? 'unknown' : 'located',
      ...(index === 1
        ? { reason: 'extent-uncertain' }
        : { region: { left: 10, top: 10, width: 40, height: 40 } }),
      durationMs: 1,
      calls: 1,
    },
  }))
  const summary = {
    runId: 'fixture-run',
    status: 'complete',
    completedCaseIds: ids,
    missingCaseIds: [] as string[],
    results,
  }
  const options = {
    summary: await pinned(directory, 'summary.json', summary),
    runManifest: await pinned(directory, 'run.json', {
      runId: 'fixture-run',
      profileId: 'fixture-vision',
      plannedCaseIds: ids,
    }),
    corpus: { manifests: [await pinned(directory, 'inputs.json', producer)], imageRoot: directory },
    truths: [await pinned(directory, 'truth.json', truth)],
    output: join(directory, 'evaluation.json'),
  }
  return { summary, truth, options }
}

await test('fresh evaluator counts whole boxes, unknowns and false locations against a separate pinned oracle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-fresh-evaluator-'))
  try {
    const { options } = await fixture(directory)
    const result = await evaluateFreshRun(options, signal)
    assert.equal(result.complete, true)
    assert.deepEqual([result.coverage.planned, result.coverage.reported], [4, 4])
    assert.equal(result.classificationCorrect, 3)
    assert.equal(result.localization.positives, 3)
    assert.equal(result.localization.matched, 2)
    assert.equal(result.localization.unknown, 1)
    assert.equal(result.localization.falseLocations, 1)
    assert.equal(result.photoLocalization.localizationRate, 0.5)
    await assert.rejects(evaluateFreshRun(options, signal), { code: 'EEXIST' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('fresh evaluator keeps unstarted cases visible and rejects a fabricated complete status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-fresh-incomplete-'))
  try {
    const { options, summary } = await fixture(directory)
    summary.results = summary.results.filter((item) => item.caseId !== 'photo-present-b')
    summary.completedCaseIds = summary.completedCaseIds.filter((id) => id !== 'photo-present-b')
    summary.missingCaseIds = ['photo-present-b']
    summary.status = 'incomplete'
    const file = await pinned(directory, 'partial-summary.json', summary)
    const result = await evaluateFreshRun({ ...options, summary: file }, signal)
    assert.equal(result.complete, false)
    assert.equal(result.coverage.planned, 4)
    assert.equal(result.coverage.reported, 3)
    assert.deepEqual(result.coverage.missing, ['photo-present-b'])
    assert.equal(result.localization.positives, 3)
    assert.equal(result.photoLocalization.localizationRate, 0.5)
    assert.equal(
      result.rows.find((item) => item.caseId === 'photo-present-b')?.sourceStatus,
      'not-attempted',
    )
    summary.status = 'complete'
    const dishonest = await pinned(directory, 'dishonest-summary.json', summary)
    await assert.rejects(
      evaluateFreshRun({ ...options, summary: dishonest }, signal),
      /completion status/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('fresh evaluator rejects mismatched source, profile, identity and unsupported negative evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-fresh-joins-'))
  try {
    const { options, summary, truth } = await fixture(directory)
    const alteredSource = structuredClone(summary)
    alteredSource.results[0]!.imageSha256 = '2'.repeat(64)
    await assert.rejects(
      evaluateFreshRun(
        { ...options, summary: await pinned(directory, 'source.json', alteredSource) },
        signal,
      ),
      /source hash/u,
    )
    const alteredProfile = structuredClone(summary)
    alteredProfile.results[0]!.profileId = 'another-profile'
    await assert.rejects(
      evaluateFreshRun(
        { ...options, summary: await pinned(directory, 'profile.json', alteredProfile) },
        signal,
      ),
      /profile/u,
    )
    const duplicate = structuredClone(summary)
    duplicate.results[1]!.caseId = duplicate.results[0]!.caseId
    await assert.rejects(
      evaluateFreshRun(
        { ...options, summary: await pinned(directory, 'duplicate.json', duplicate) },
        signal,
      ),
      /set mismatch/u,
    )
    truth[2]!.negativeEvidence = null
    await assert.rejects(
      evaluateFreshRun(
        { ...options, truths: [await pinned(directory, 'unsupported-truth.json', truth)] },
        signal,
      ),
      /independent positive\/negative evidence/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('paired fresh localization compares positive photos only and refuses incomplete or different snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-fresh-paired-'))
  try {
    const { options } = await fixture(directory)
    const candidate = await evaluateFreshRun(options, signal)
    const control = structuredClone(candidate)
    control.profileId = 'fixture-no-image'
    for (const row of candidate.rows)
      if (row.caseId.startsWith('photo-')) row.localizationCorrect = true
    for (const row of control.rows) row.localizationCorrect = false
    const comparison = compareFreshPhotoLocalization(candidate, control)
    assert.equal(comparison.pairs, 2)
    assert.equal(comparison.difference, 1)
    assert.equal(comparison.lower, 1)
    assert.equal(comparison.passes, true)
    control.complete = false
    assert.throws(() => compareFreshPhotoLocalization(candidate, control), /incomplete/u)
    control.complete = true
    control.truthSha256 = ['0'.repeat(64)]
    assert.throws(
      () => compareFreshPhotoLocalization(candidate, control),
      /different producer or annotation snapshots/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
