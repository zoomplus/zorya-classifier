import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { runFreshCorpusProfile } from '../benchmarks/v02/fresh-runner.js'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

await test('fresh producer records both stages without sending controller IDs, paths, hashes or keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-fresh-runner-'))
  try {
    const image = await sharp({
      create: { width: 512, height: 384, channels: 3, background: '#dddddd' },
    })
      .png()
      .toBuffer()
    const sourceName = 'secret-source-file.png'
    const privateId = 'private-case-present-id'
    const imageSha = digest(image)
    const input = [
      {
        caseId: privateId,
        image: { path: sourceName, sha256: imageSha, width: 512, height: 384 },
        locate: { target: 'the complete toolbar button', instruction: 'Include its border.' },
        classify: { question: 'Is the toolbar button visible?', options: ['present', 'absent'] },
      },
    ]
    await writeFile(join(root, sourceName), image, { flag: 'wx' })
    const manifestBytes = Buffer.from(JSON.stringify(input))
    const manifestPath = join(root, 'pinned-inputs.json')
    await writeFile(manifestPath, manifestBytes, { flag: 'wx' })
    const requests: DecisionRequest[] = []
    const metadata = {
      model: 'fixture',
      provider: 'fixture',
      requestId: null,
      durationMs: 0,
      costUsd: 0,
      attempts: 1,
    }
    const decision: DecisionPort = {
      async decide(request) {
        requests.push(request)
        const extent = ['left', 'right', 'top', 'bottom'].every((id) => id in request.questions)
        const answers: DecisionResult['answers'] = Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => {
            if (question.type === 'noul')
              return [id, { type: 'presence' as const, presence: 'present' as const }]
            const choice = id === 'instance' ? 'same' : extent ? 'unknown' : undefined
            return [
              id,
              {
                type: 'ranked-choice' as const,
                ranking: choice
                  ? [choice]
                  : Object.keys(question.criteria).slice(0, question.rankingSize ?? 4),
              },
            ]
          }),
        )
        return { answers, metadata }
      },
    }
    const result = await runFreshCorpusProfile(
      {
        manifests: [{ path: manifestPath, sha256: digest(manifestBytes) }],
        imageRoot: root,
        outputRoot: join(root, 'runs'),
        apiKey: 'private-secret-sentinel',
        createDecision: () => decision,
      },
      'native-seed-outline-axis-fixed16-v1',
    )
    assert.equal(result.status, 'complete')
    assert.deepEqual(result.plannedCaseIds, [privateId])
    assert.deepEqual(result.missingCaseIds, [])
    assert.equal(result.results[0]?.classify.status, 'ok')
    assert.equal(result.results[0]?.classify.value, 'present')
    assert.equal(result.results[0]?.locate.status, 'unknown')
    const requestText = requests.map((request) => JSON.stringify(request.state)).join('\n')
    for (const forbidden of [privateId, sourceName, imageSha, 'private-secret-sentinel', root])
      assert.equal(requestText.includes(forbidden), false)

    const runManifest = JSON.parse(
      await readFile(join(result.outputDirectory, 'run-manifest.json'), 'utf8'),
    ) as Record<string, unknown>
    assert.equal(JSON.stringify(runManifest).includes(root), false)
    assert.equal(JSON.stringify(runManifest).includes(sourceName), false)
    const sourceHashes = runManifest.sourceHashes as Record<string, string>
    for (const path of [
      '../experiments/boundary-view.ts',
      'src/processes/boundary-state.ts',
      'src/entities/boundary-view.ts',
    ])
      assert.match(sourceHashes[path] ?? '', /^[a-f0-9]{64}$/u)
    const caseFiles = await readdir(join(result.outputDirectory, privateId, 'calls'))
    assert.ok(caseFiles.some((name) => name.startsWith('decision-trace-')))

    const extentRequests = requests.filter((request) =>
      ['left', 'right', 'top', 'bottom'].every((id) => id in request.questions),
    )
    assert.ok(extentRequests.length > 0)
    const firstExtent = extentRequests[0]!
    assert.equal(
      firstExtent.state.filter((part) => typeof part !== 'string' && part.type === 'image_url')
        .length,
      3,
      'outline original plus two first-pass axis views; the SEED crop is removed',
    )
    assert.equal(firstExtent.state.includes('SEED'), false)
    assert.ok(
      firstExtent.state.some(
        (part) => typeof part === 'string' && part.includes('seedOutlineView'),
      ),
    )
    assert.equal(
      firstExtent.state.filter((part) => typeof part === 'string' && part.includes('boundaryView'))
        .length,
      2,
    )
    const traces = await Promise.all(
      caseFiles
        .filter((name) => name.startsWith('decision-trace-') && name.endsWith('.json'))
        .map(
          async (name) =>
            JSON.parse(
              await readFile(join(result.outputDirectory, privateId, 'calls', name), 'utf8'),
            ) as {
              status?: string
              questions?: Array<{ questionId: string }>
              geometry?: {
                boundaryViews?: unknown[]
                imageTransforms?: Array<{ role?: string }>
              }
            },
        ),
    )
    const boundaryTrace = traces.find((trace) => (trace.geometry?.boundaryViews?.length ?? 0) === 2)
    assert.ok(boundaryTrace)
    assert.deepEqual(
      boundaryTrace.questions?.map((question) => question.questionId),
      ['left', 'right', 'top', 'bottom', 'instance'],
    )
    assert.ok(
      boundaryTrace.geometry?.imageTransforms?.some(
        (transform) => transform.role === 'seed-outline',
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
