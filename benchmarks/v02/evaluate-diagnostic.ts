import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { wholeObjectMetrics } from './metrics.js'
import type { LocalizationCase } from './metrics.js'

interface DiagnosticCase {
  caseId: string
  imageSha256: string
  encoder: string
  route: string
  classify: { status: string; value?: string }
  locate: {
    status: string
    value?:
      | string
      | { status: string; region?: { left: number; top: number; width: number; height: number } }
  }
}

/** Evaluator-only join. This module is not imported by the paid producer. */
export async function evaluateDiagnostic(runDirectory: string) {
  const root = resolve(runDirectory)
  const summary = JSON.parse(await readFile(join(root, 'summary.json'), 'utf8')) as {
    runId: string
    results: DiagnosticCase[]
  }
  const producer = JSON.parse(
    await readFile(new URL('./input-manifest.json', import.meta.url), 'utf8'),
  ) as {
    cases: { caseId: string; image: { width: number; height: number } }[]
  }
  const truth = JSON.parse(
    await readFile(new URL('./diagnostic-evaluator-dev4.json', import.meta.url), 'utf8'),
  ) as {
    cases: {
      caseId: string
      presence: 'present' | 'absent'
      boxesNormalized?: { left: number; top: number; right: number; bottom: number }[]
    }[]
  }
  const byId = new Map(producer.cases.map((item) => [item.caseId, item]))
  const truthById = new Map(truth.cases.map((item) => [item.caseId, item]))
  const groups = new Map<string, DiagnosticCase[]>()
  for (const result of summary.results) {
    const key = `${result.route}/${result.encoder}`
    const group = groups.get(key) ?? []
    group.push(result)
    groups.set(key, group)
  }
  const candidates = [...groups].map(([candidate, rows]) => {
    let classificationCorrect = 0
    const localizationCases: LocalizationCase[] = rows.map((row) => {
      const input = byId.get(row.caseId)
      const expected = truthById.get(row.caseId)
      if (!input || !expected) throw new Error('Evaluator join failed for a producer case')
      if (row.classify.status === 'ok' && row.classify.value === expected.presence)
        classificationCorrect++
      const boxes = (expected.boxesNormalized ?? []).map((box) => ({
        left: box.left * input.image.width,
        top: box.top * input.image.height,
        width: (box.right - box.left) * input.image.width,
        height: (box.bottom - box.top) * input.image.height,
      }))
      const expectedValue: LocalizationCase['expected'] =
        expected.presence === 'present'
          ? { presence: 'present', boxes }
          : { presence: 'absent', verified: true }
      const location = typeof row.locate.value === 'object' ? row.locate.value : undefined
      const outcome: LocalizationCase['outcome'] =
        location?.status === 'located' && location.region
          ? { status: 'located', region: location.region }
          : row.locate.status === 'unknown'
            ? { status: 'unknown' }
            : row.locate.status === 'not-found'
              ? { status: 'not-found' }
              : { status: 'failed' }
      return { caseId: row.caseId, expected: expectedValue, outcome }
    })
    return {
      candidate,
      attempted: rows.length,
      classificationCorrect,
      classificationAccuracy: rows.length === 0 ? null : classificationCorrect / rows.length,
      localization: wholeObjectMetrics(localizationCases),
    }
  })
  const output = {
    runId: summary.runId,
    evaluator: 'diagnostic-evaluator-dev4.json',
    warning: 'Old exposed development cases only; diagnostic evidence, not fresh qualification.',
    candidates,
  }
  await writeFile(join(root, 'evaluation.json'), JSON.stringify(output, null, 2) + '\n', {
    flag: 'wx',
  })
  return output
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const runDirectory = process.argv[2]
    if (!runDirectory) throw new Error('Expected a run directory')
    const result = await evaluateDiagnostic(runDirectory)
    process.stdout.write(
      JSON.stringify({ runId: result.runId, candidates: result.candidates }) + '\n',
    )
  } catch {
    process.stderr.write('Diagnostic evaluation failed; producer evidence was not changed.\n')
    process.exitCode = 1
  }
}
