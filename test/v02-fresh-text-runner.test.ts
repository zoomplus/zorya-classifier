import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import {
  assertFreshTextPhaseCaseCount,
  freshTextPolicy,
  freshTextPolicyForPhase,
  freshTextProfiles,
  heldoutPhotoInputSha256,
  runFreshTextProfile,
  validateFreshTextPhaseRequest,
} from '../benchmarks/v02/fresh-text-runner.js'
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
  assert.equal(
    parseFreshTextArgs(['--allow-paid', '--profile', 'ascii-luma-v1', '--classify-only']).stages,
    'classify-only',
  )
})

await test('heldout no-image policy is exact and cannot read an unpinned corpus', async () => {
  assert.deepEqual(freshTextPolicyForPhase('dev'), freshTextPolicy)
  const held = freshTextPolicyForPhase('heldout')
  assert.equal(held.timeoutMs, 120000)
  assert.equal(held.maxPhysicalCalls, 300)
  assert.equal(held.maxCostUsd, 5)
  assert.equal(held.retries, 0)
  assert.equal(held.fallback, false)
  assert.equal(held.latencyRankingEligible, false)

  const manifest = [{ path: '/frozen/photo/inputs.json', sha256: heldoutPhotoInputSha256 }]
  assert.equal(
    validateFreshTextPhaseRequest('heldout', 'no-image-control', manifest),
    'full frozen HELDOUT photo-only no-image text control run',
  )
  assert.throws(
    () => validateFreshTextPhaseRequest('heldout', 'ascii-luma-v1', manifest),
    /no-image-control/u,
  )
  assert.throws(
    () =>
      validateFreshTextPhaseRequest('heldout', 'no-image-control', [
        { ...manifest[0]!, sha256: '0'.repeat(64) },
      ]),
    /frozen 40-photo/u,
  )
  assert.throws(
    () => validateFreshTextPhaseRequest('heldout', 'no-image-control', manifest, 'classify-only'),
    /classify-and-locate/u,
  )
  const ids = Array.from({ length: 40 }, (_, index) => `frozen-photo-${index + 1}`)
  assert.doesNotThrow(() => assertFreshTextPhaseCaseCount('heldout', ids))
  assert.throws(() => assertFreshTextPhaseCaseCount('heldout', ids.slice(1)), /40 unique/u)
  assert.throws(
    () => assertFreshTextPhaseCaseCount('heldout', [...ids.slice(0, 39), ids[0]!]),
    /40 unique/u,
  )
  assert.doesNotThrow(() => assertFreshTextPhaseCaseCount('dev', ['one']))

  const outputRoot = join(tmpdir(), `zorya-guard-${Date.now()}`)
  await assert.rejects(
    runFreshTextProfile(
      {
        manifests: manifest,
        imageRoot: '/this-must-not-be-read',
        outputRoot,
        apiKey: 'must-not-be-used',
        phase: 'heldout',
        createDecision: () => {
          throw new Error('provider must not be constructed')
        },
      },
      'ascii-luma-v1',
    ),
    /no-image-control/u,
  )
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
      const runManifest = JSON.parse(
        await readFile(join(result.outputDirectory, 'run-manifest.json'), 'utf8'),
      ) as {
        phase: string
        policy: { timeoutMs: number; maxPhysicalCalls: number }
        modelBoundary: {
          imagePartsRemoved: boolean
          textEncoder: string | null
          segmentation: boolean
          ocr: boolean
        }
      }
      assert.equal(runManifest.phase, 'dev')
      assert.equal(runManifest.policy.timeoutMs, 45000)
      assert.equal(runManifest.policy.maxPhysicalCalls, 250)
      assert.equal(runManifest.modelBoundary.imagePartsRemoved, profile === 'no-image-control')
      assert.equal(
        runManifest.modelBoundary.textEncoder,
        profile === 'no-image-control' ? null : profile,
      )
      assert.equal(runManifest.modelBoundary.segmentation, false)
      assert.equal(runManifest.modelBoundary.ocr, false)
      assert.deepEqual(result.completedCaseIds, ['private-case-id'])
      assert.equal(result.results[0]?.classify.status, 'ok', JSON.stringify(result.results[0]))
      assert.equal(result.results[0]?.classify.value, 'present')
      assert.ok(
        ['located', 'unknown', 'not-found'].includes(result.results[0]?.locate?.status ?? ''),
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

await test('real text adapter sends the selected encoding over wire with no image parts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-fresh-text-wire-'))
  try {
    const image = await sharp({
      create: { width: 512, height: 384, channels: 3, background: '#b42631' },
    })
      .png()
      .toBuffer()
    const input = [
      {
        caseId: 'wire-fixture',
        image: { path: 'image.png', sha256: digest(image), width: 512, height: 384 },
        locate: { target: 'the complete red badge' },
        classify: { question: 'Is the red badge present?', options: ['present', 'absent'] },
      },
    ]
    await writeFile(join(root, 'image.png'), image, { flag: 'wx' })
    const manifestBytes = Buffer.from(JSON.stringify(input))
    const manifestPath = join(root, 'inputs.json')
    await writeFile(manifestPath, manifestBytes, { flag: 'wx' })
    let wireBody: Record<string, unknown> | undefined
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      wireBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      const messages = wireBody.messages as Array<{
        content: Array<{ type: string; text?: string }>
      }>
      const user = messages[1]!
      const task = user.content.find((part) => part.text?.startsWith('CLASSIFICATION_TASK\n'))!
      const document = JSON.parse(task.text!.slice('CLASSIFICATION_TASK\n'.length)) as {
        questions: Record<
          string,
          { kind: string; options?: Record<string, string>; rankingSize?: number }
        >
      }
      const answers = Object.fromEntries(
        Object.entries(document.questions).map(([id, question]) => [
          id,
          question.kind === 'categorical'
            ? { ranking: Object.keys(question.options ?? {}).slice(0, question.rankingSize ?? 1) }
            : { presence: 'present' },
        ]),
      )
      return new Response(
        JSON.stringify({
          id: 'wire-fixture-response',
          model: 'deepseek/deepseek-v4.1-flash',
          provider: 'Together',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { content: JSON.stringify({ answers }) },
            },
          ],
          usage: { cost: 0.001 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const result = await runFreshTextProfile(
      {
        manifests: [{ path: manifestPath, sha256: digest(manifestBytes) }],
        imageRoot: root,
        outputRoot: join(root, 'runs'),
        apiKey: 'fixture-key',
        fetch,
        stages: 'classify-only',
      },
      'ascii-luma-v1',
    )
    assert.equal(result.status, 'complete')
    assert.equal(result.results[0]?.classify.status, 'ok')
    assert.equal(result.results[0]?.locate, undefined)
    assert.ok(wireBody)
    const messages = wireBody!.messages as Array<{
      content: Array<{ type: string; text?: string }>
    }>
    const content = messages[1]!.content
    assert.equal(
      content.some((part) => part.type === 'image_url'),
      false,
    )
    assert.ok(content.some((part) => part.text?.includes('ASCII_LUMA_V1')))
    assert.ok(content.some((part) => part.text?.includes('CLASSIFICATION_TASK')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
