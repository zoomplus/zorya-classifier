import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import { runPointCandidateChoice } from '../benchmarks/v02/point-candidate-choice.js'

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

await test('native candidate choice sends only target text, closed aliases and presentation images', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-candidate-choice-'))
  try {
    const inputCases = []
    const pins: { path: string; sha256: string }[] = []
    const privateValues: string[] = []
    for (let batch = 1; batch <= 3; batch += 1) {
      const caseAlias = 'case-01'
      const imageDir = join(root, `batch-${batch}`, caseAlias)
      await mkdir(imageDir, { recursive: true })
      const original = await sharp({
        create: {
          width: 320,
          height: 300,
          channels: 3,
          background: { r: 120 + batch, g: 40, b: 20 },
        },
      })
        .png()
        .toBuffer()
      const sheet = await sharp({
        create: {
          width: 320,
          height: 300,
          channels: 3,
          background: { r: 10, g: 30 + batch, b: 90 },
        },
      })
        .png()
        .toBuffer()
      await writeFile(join(imageDir, 'original.png'), original)
      await writeFile(join(imageDir, 'candidates-01.png'), sheet)
      const caseId = `private-case-id-${batch}`
      const imagePath = `private-source-${batch}.png`
      const imageSha = digest(`private-source-sha-${batch}`)
      privateValues.push(caseId, imagePath, imageSha, root)
      inputCases.push({
        caseId,
        image: { path: imagePath, sha256: imageSha, width: 320, height: 300 },
        locate: { target: `the red badge ${batch}` },
        classify: {
          question: `Is the red badge ${batch} present?`,
          options: ['present', 'absent'],
        },
      })
      const contact = {
        schemaVersion: 1,
        cases: [
          {
            caseAlias,
            presentation: {
              choiceIds: ['none', 'C00', 'C01'],
              originalImagePath: join(imageDir, 'original.png'),
              sheets: [{ path: join(imageDir, 'candidates-01.png') }],
            },
            internal: {
              caseId,
              sourceWidth: 320,
              sourceHeight: 300,
              sourceImageSha256: imageSha,
              candidates: [{ internalCandidateId: `secret-mask-${batch}`, choiceId: 'C00' }],
            },
          },
        ],
      }
      const manifestPath = join(root, `batch-${batch}.json`)
      const bytes = Buffer.from(JSON.stringify(contact))
      await writeFile(manifestPath, bytes)
      pins.push({ path: manifestPath, sha256: digest(bytes) })
    }
    const inputBytes = Buffer.from(JSON.stringify(inputCases))
    const inputPath = join(root, 'inputs.json')
    await writeFile(inputPath, inputBytes)
    const bodies: Record<string, unknown>[] = []
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      const questions = body.questions as Record<string, { criteria?: Record<string, string> }>
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, question]) => {
          if (id === 'selection') {
            const criteria = question.criteria ?? {}
            const probabilities = Object.fromEntries(
              Object.keys(criteria).map((key) => [key, key === 'C00' || key === 'C01' ? 0.5 : 0]),
            )
            return [id, { type: 'choice', choice: 'C01', probabilities }]
          }
          return [id, { type: 'noul', noul: 0.9 }]
        }),
      )
      return new Response(
        JSON.stringify({
          id: 'offline-wire-fixture',
          model: 'openai/gpt-6-luna-decisions',
          provider: 'OpenAI',
          answers,
          usage: { cost: 0.001 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const result = await runPointCandidateChoice({
      contactSheetManifests: pins,
      inputManifests: [{ path: inputPath, sha256: digest(inputBytes) }],
      imageRoot: root,
      outputRoot: join(root, 'runs'),
      apiKey: 'private-test-key',
      fetch,
      minimumCases: 3,
      maximumCases: 3,
    })
    assert.equal(result.status, 'complete')
    assert.equal(result.aggregate.admittedPhysicalCalls, 6, JSON.stringify(result.results))
    assert.equal(result.aggregate.knownCostUsd, 0.006)
    assert.equal(result.results.length, 3)
    assert.ok(
      result.results.every(
        (row) =>
          row.choice?.selected === 'C00' &&
          row.choice.nativeChoice === 'C01' &&
          row.wholeTarget?.score === 0.9,
      ),
    )
    assert.equal(bodies.length, 6)
    for (const body of bodies) {
      const state = body.state as Array<string | { type: string; image_url: { url: string } }>
      assert.equal(state.filter((part) => typeof part !== 'string').length, 2)
      const text = state.filter((part): part is string => typeof part === 'string').join('\n')
      for (const privateValue of privateValues) assert.equal(text.includes(privateValue), false)
      assert.equal(text.includes('secret-mask-'), false)
      const questions = body.questions as Record<string, { criteria?: Record<string, string> }>
      if (questions.selection) {
        assert.deepEqual(Object.keys(questions.selection.criteria!), ['none', 'C00', 'C01'])
      } else if (questions.presence) {
        assert.ok(text.includes('C00'))
        assert.ok(!text.includes('C01'))
      } else assert.fail('Expected selection or whole-target question')
      const images = state.filter(
        (part): part is { type: string; image_url: { url: string } } => typeof part !== 'string',
      )
      assert.ok(
        images.every(
          (part) =>
            part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,'),
        ),
      )
    }
    const summaryText = JSON.stringify(result.results)
    for (const privateValue of privateValues)
      assert.equal(summaryText.includes(privateValue), false)
    async function scanJson(directory: string): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true })
      return (
        await Promise.all(
          entries.map(async (entry) => {
            const file = join(directory, entry.name)
            if (entry.isDirectory()) return scanJson(file)
            return entry.name.endsWith('.json') ? [await readFile(file, 'utf8')] : []
          }),
        )
      ).flat()
    }
    const artifacts = (await scanJson(result.outputDirectory)).join('\n')
    for (const privateValue of privateValues) assert.equal(artifacts.includes(privateValue), false)
    assert.equal(artifacts.includes('secret-mask-'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
