import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import { freshProposalRoute, runFreshProposalDev } from '../benchmarks/v02/fresh-proposal-runner.js'
import type { ObjectProposalBatch, ObjectProposalPort } from '../src/entities/object-proposals.js'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function proposalPort(): ObjectProposalPort {
  return {
    async propose(input) {
      const pixels = input.image.width * input.image.height
      const data = new Uint8Array(Math.ceil(pixels / 8))
      data.fill(255)
      const remainder = pixels % 8
      if (remainder > 0) data[data.length - 1] = (1 << remainder) - 1
      const batch: ObjectProposalBatch = {
        proposals: [
          {
            id: 'C00',
            mask: {
              data,
              width: input.image.width,
              height: input.image.height,
              format: 'binary-lsb0',
            },
          },
        ],
        metadata: {
          method: 'mobile-sam-nine-point-proposals-v1',
          backend: 'mobile-sam',
          durationMs: 7,
          input: { width: input.image.width, height: input.image.height },
        },
      }
      return batch
    },
    async settle() {},
    async dispose() {},
  }
}

await test('fresh proposal workflow uses the public classifier, fixed route and immutable truth-free artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-fresh-proposal-'))
  try {
    const image = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#dddddd' },
    })
      .png()
      .toBuffer()
    const imagePath = 'fixture.png'
    const caseId = 'private-present-fixture'
    const imageSha = digest(image)
    const input = [
      {
        caseId,
        image: { path: imagePath, sha256: imageSha, width: 64, height: 64 },
        locate: { target: 'the entire toolbar icon', instruction: 'Include its visible border.' },
        classify: { question: 'Is the toolbar icon visible?', options: ['present', 'absent'] },
      },
    ]
    await writeFile(join(root, imagePath), image, { flag: 'wx' })
    const manifestBytes = Buffer.from(JSON.stringify(input))
    const manifestPath = join(root, 'inputs.json')
    await writeFile(manifestPath, manifestBytes, { flag: 'wx' })

    const fetchRequests: { url: string; body: string; authorization: string | null }[] = []
    const fetch: typeof globalThis.fetch = async (inputUrl, init) => {
      const body = typeof init?.body === 'string' ? init.body : ''
      fetchRequests.push({
        url: String(inputUrl),
        body,
        authorization: new Headers(init?.headers).get('authorization'),
      })
      const request = JSON.parse(body) as {
        questions: Record<
          string,
          { type: 'choice'; criteria: Record<string, string> } | { type: 'noul' }
        >
      }
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => {
          if (question.type === 'noul') return [id, { type: 'noul', noul: 0.99 }]
          const ids = Object.keys(question.criteria)
          const first = ids[0]
          assert.ok(first)
          return [
            id,
            {
              type: 'choice',
              choice: first,
              probabilities: Object.fromEntries(
                ids.map((option, index) => [option, index ? 0 : 1]),
              ),
            },
          ]
        }),
      )
      return new Response(
        JSON.stringify({
          id: `receipt-${fetchRequests.length}`,
          model: freshProposalRoute.model,
          provider: freshProposalRoute.providerName,
          usage: { cost: 0.001 },
          answers,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const result = await runFreshProposalDev({
      manifests: [{ path: manifestPath, sha256: digest(manifestBytes) }],
      imageRoot: root,
      outputRoot: join(root, 'runs'),
      apiKey: 'offlinekey',
      encoderPath: '/private/model/encoder.onnx',
      decoderPath: '/private/model/decoder.onnx',
      expectedCaseCount: 1,
      fetch,
      createObjectProposals: async () => proposalPort(),
    })

    assert.equal(result.status, 'complete')
    assert.deepEqual(result.plannedCaseIds, [caseId])
    assert.deepEqual(result.missingCaseIds, [])
    assert.equal(result.results[0]?.classify.status, 'ok')
    assert.equal(result.results[0]?.classify.value, 'present')
    assert.ok(['located', 'unknown'].includes(result.results[0]?.locate.status ?? ''))
    assert.equal(result.results[0]?.locate.nativeProposal?.backend, 'mobile-sam')
    assert.equal(result.results[0]?.locate.nativeProposal?.candidateCount, 1)
    assert.equal(result.aggregate.knownCostUsd, fetchRequests.length * 0.001)
    assert.equal(result.aggregate.admittedPhysicalCalls, fetchRequests.length)
    assert.ok(fetchRequests.length > 0)
    assert.ok(
      fetchRequests.every((request) => request.url === 'https://openrouter.ai/api/alpha/decisions'),
    )
    assert.ok(
      fetchRequests.every(
        (request) => request.authorization === 'Bearer offlinekey',
      ),
    )
    for (const request of fetchRequests) {
      assert.equal(request.body.includes(caseId), false)
      assert.equal(request.body.includes(imagePath), false)
      assert.equal(request.body.includes(imageSha), false)
      assert.equal(request.body.includes(root), false)
    }

    const directory = result.outputDirectory
    const manifest = await readFile(join(directory, 'run-manifest.json'), 'utf8')
    assert.equal(manifest.includes(root), false)
    assert.equal(manifest.includes('/private/model/'), false)
    assert.equal(manifest.includes('offlinekey'), false)
    assert.equal(manifest.includes(caseId), true)
    const callsDirectory = join(directory, 'calls')
    const callFiles = await readdir(callsDirectory)
    assert.ok(callFiles.some((name) => name.startsWith('physical-receipt-')))
    for (const name of callFiles) {
      const contents = await readFile(join(callsDirectory, name), 'utf8')
      assert.equal(contents.includes('offlinekey'), false)
      assert.equal(contents.includes('/private/model/'), false)
    }
    assert.equal(result.latencyRankingEligible, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('fresh proposal runner rejects a denominator mismatch before initializing paid adapters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-fresh-proposal-count-'))
  let proposalInitializations = 0
  try {
    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#dddddd' },
    })
      .png()
      .toBuffer()
    const input = [
      {
        caseId: 'private-single-case',
        image: { path: 'x.png', sha256: digest(image), width: 8, height: 8 },
        locate: { target: 'object' },
        classify: { options: ['present', 'absent'] },
      },
    ]
    await writeFile(join(root, 'x.png'), image, { flag: 'wx' })
    const manifest = Buffer.from(JSON.stringify(input))
    await writeFile(join(root, 'inputs.json'), manifest, { flag: 'wx' })
    await assert.rejects(
      runFreshProposalDev({
        manifests: [{ path: join(root, 'inputs.json'), sha256: digest(manifest) }],
        imageRoot: root,
        outputRoot: join(root, 'runs'),
        apiKey: 'offlinekey',
        encoderPath: 'unused',
        decoderPath: 'unused',
        createObjectProposals: async () => {
          proposalInitializations += 1
          return proposalPort()
        },
      }),
      /exactly 40 cases/u,
    )
    assert.equal(proposalInitializations, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
