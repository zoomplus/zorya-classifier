import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { freshTextProfiles, runFreshTextProfile } from '../benchmarks/v02/fresh-text-runner.js'
import { parseFreshTextArgs } from '../benchmarks/v02/fresh-text-dev.js'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

await test('fresh text CLI pins a single profile and refuses implicit paid dispatch', () => {
  assert.throws(() => parseFreshTextArgs([]), /explicit --allow-paid/u)
  assert.throws(() => parseFreshTextArgs(['--allow-paid']), /one known --profile/u)
  for (const profile of freshTextProfiles) {
    const parsed = parseFreshTextArgs(['--dry-run', '--profile', profile])
    assert.equal(parsed.profile, profile)
    assert.equal(parsed.manifests.length, 2)
  }
})

await test('all six text encoders and no-image control preserve fresh tasks and strip only image parts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-fresh-text-'))
  try {
    const image = await sharp({
      create: { width: 512, height: 384, channels: 3, background: '#718293' },
    })
      .png()
      .toBuffer()
    const input = [
      {
        caseId: 'private-case-id',
        image: {
          path: 'private-source.png',
          sha256: digest(image),
          width: 512,
          height: 384,
        },
        locate: {
          target: 'the full blue toolbar icon',
          instruction: 'Include its whole visible shape.',
        },
        classify: { question: 'Is the toolbar icon visible?', options: ['present', 'absent'] },
      },
    ]
    await writeFile(join(root, 'private-source.png'), image, { flag: 'wx' })
    const manifestBytes = Buffer.from(JSON.stringify(input))
    const manifestPath = join(root, 'inputs.json')
    await writeFile(manifestPath, manifestBytes, { flag: 'wx' })
    const manifest = { path: manifestPath, sha256: digest(manifestBytes) }
    const requestsByProfile = new Map<string, DecisionRequest[]>()
    const metadata = {
      model: 'fixture',
      provider: 'fixture',
      requestId: null,
      durationMs: 0,
      costUsd: 0,
      attempts: 1,
    }

    for (const profile of freshTextProfiles) {
      const requests: DecisionRequest[] = []
      const decision: DecisionPort = {
        async decide(request) {
          requests.push(request)
          const answers: DecisionResult['answers'] = Object.fromEntries(
            Object.entries(request.questions).map(
              ([id, question]): [string, DecisionResult['answers'][string]] => {
                if (question.type === 'noul')
                  return [id, { type: 'presence' as const, presence: 'present' as const }]
                const ids = Object.keys(question.criteria)
                const values = Object.fromEntries(
                  ids.map((choice, index) => [choice, index === 0 ? 1 : 0]),
                )
                return [id, { type: 'choice', choice: ids[0]!, probabilities: values }]
              },
            ),
          )
          return { answers, metadata }
        },
      }
      const result = await runFreshTextProfile(
        {
          manifests: [manifest],
          imageRoot: root,
          outputRoot: join(root, 'runs'),
          apiKey: 'private-secret-sentinel',
          createDecision: () => decision,
        },
        profile,
      )
      assert.equal(result.status, 'complete')
      assert.deepEqual(result.completedCaseIds, ['private-case-id'])
      assert.equal(result.results[0]?.classify.status, 'ok', JSON.stringify(result.results[0]))
      assert.equal(result.results[0]?.classify.value, 'present')
      assert.ok(
        ['located', 'unknown', 'not-found'].includes(result.results[0]?.locate.status ?? ''),
      )
      requestsByProfile.set(profile, requests)
      const serialized = JSON.stringify(requests)
      for (const forbidden of [
        'private-case-id',
        'private-source.png',
        digest(image),
        root,
        'private-secret-sentinel',
      ])
        assert.equal(serialized.includes(forbidden), false)
    }

    const textRequests = requestsByProfile.get('ascii-luma-v1')!
    const noImageRequests = requestsByProfile.get('no-image-control')!
    assert.equal(Object.values(textRequests[0]!.questions)[0]?.type, 'choice')
    assert.equal(Object.values(noImageRequests[0]!.questions)[0]?.type, 'choice')
    assert.deepEqual(
      textRequests.map((request) => request.questions),
      noImageRequests.map((request) => request.questions),
    )
    for (const request of noImageRequests)
      assert.equal(
        request.state.some((part) => typeof part !== 'string' && part.type === 'image_url'),
        false,
      )
    assert.ok(JSON.stringify(textRequests).includes('toolbar icon'))
    assert.ok(JSON.stringify(noImageRequests).includes('toolbar icon'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
