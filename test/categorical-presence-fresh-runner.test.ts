import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import {
  CATEGORICAL_FRESH_MAX_PHYSICAL_PER_CASE,
  CATEGORICAL_FRESH_MAX_PHYSICAL_PER_PROFILE,
  CategoricalFreshCaseBudget,
  assertCategoricalFreshCallBound,
  categoricalFreshProfiles,
  categoricalTargetInstruction,
  freshProposalRoute,
  runCategoricalPresenceFreshDev,
  targetForProfile,
  validateTargetPolicyTasks,
} from '../benchmarks/v02/categorical-presence-fresh-runner.js'
import { RunBudget } from '../benchmarks/v02/budget.js'
import type { FreshCase } from '../benchmarks/v02/fresh-corpus.js'
import type { ObjectProposalBatch, ObjectProposalPort } from '../src/entities/object-proposals.js'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const fixtureCase: FreshCase = {
  caseId: 'fixture-case',
  image: { path: 'fixture.png', sha256: '0'.repeat(64), width: 64, height: 64 },
  locate: { target: 'the whole signal icon', instruction: categoricalTargetInstruction },
  classify: { question: 'Is the signal icon visible?', options: ['present', 'absent'] },
}

function proposalPort(): ObjectProposalPort {
  return {
    async propose(input) {
      const pixels = input.image.width * input.image.height
      const data = new Uint8Array(Math.ceil(pixels / 8))
      data.fill(255)
      if (pixels % 8) data[data.length - 1] = (1 << pixels % 8) - 1
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
          durationMs: 1,
          input: { width: input.image.width, height: input.image.height },
        },
      }
      return batch
    },
    async settle() {},
    async dispose() {},
  }
}

await test('the paired target profiles differ only by omitting the approved neutral instruction', () => {
  const instructed = structuredClone(fixtureCase)
  assert.equal(
    targetForProfile(instructed, categoricalFreshProfiles.preserveInstruction),
    `${instructed.locate.target}\n${categoricalTargetInstruction}`,
  )
  assert.equal(
    targetForProfile(instructed, categoricalFreshProfiles.targetOnly),
    instructed.locate.target,
  )
  const emptyInstruction = structuredClone(instructed)
  emptyInstruction.locate.instruction = undefined
  assert.equal(
    targetForProfile(emptyInstruction, categoricalFreshProfiles.preserveInstruction),
    emptyInstruction.locate.target,
  )
  assert.throws(() => {
    validateTargetPolicyTasks([
      { ...instructed, locate: { ...instructed.locate, instruction: 'Keep the red object.' } },
    ])
  }, /unapproved locate instruction/u)
})

await test('six-call per-case ceiling composes with the 300-call DEV ledger without ID collisions', () => {
  assert.equal(CATEGORICAL_FRESH_MAX_PHYSICAL_PER_CASE, 6)
  assert.equal(CATEGORICAL_FRESH_MAX_PHYSICAL_PER_PROFILE, 240)
  assertCategoricalFreshCallBound(300)
  assert.throws(() => assertCategoricalFreshCallBound(239), RangeError)
  assert.throws(() => assertCategoricalFreshCallBound(301), RangeError)
  const shared = new RunBudget(300, 5, 0.05, 'dev')
  const first = new CategoricalFreshCaseBudget(shared)
  const second = new CategoricalFreshCaseBudget(shared)
  const ids = [first.admit(), second.admit()]
  for (let index = 0; index < 5; index++) ids.push(first.admit())
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7])
  assert.throws(() => first.admit(), /budget/u)
  first.settle(1, 0.001)
  second.settle(2, 0.001)
  for (const id of ids.slice(2)) first.settle(id, 0.001)
  assert.equal(shared.snapshot().admittedPhysicalCalls, 7)
  assert.equal(shared.snapshot().knownCostUsd, 0.007)
  assert.equal(shared.snapshot().inFlightCalls, 0)
})

await test('public classifier fixture records converted categorical Choices as the actual request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-categorical-fresh-'))
  try {
    const image = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#dddddd' },
    })
      .png()
      .toBuffer()
    const input = [
      {
        ...fixtureCase,
        image: { ...fixtureCase.image, sha256: digest(image) },
      },
    ]
    await writeFile(join(root, 'fixture.png'), image, { flag: 'wx' })
    const manifestBytes = Buffer.from(JSON.stringify(input))
    const manifestPath = join(root, 'inputs.json')
    await writeFile(manifestPath, manifestBytes, { flag: 'wx' })
    const observed: string[] = []
    let binaryConversionObserved = false
    let fetchCount = 0
    const fetch: typeof globalThis.fetch = async (url, init) => {
      fetchCount++
      assert.equal(String(url), 'https://openrouter.ai/api/alpha/decisions')
      const body = JSON.parse(String(init?.body)) as {
        questions: Record<
          string,
          { type: string; criteria?: Record<string, string>; instructions?: string }
        >
      }
      for (const [id, question] of Object.entries(body.questions)) {
        assert.equal(question.type, 'choice', `request ${id} must be a real Choice`)
        if (
          Object.keys(question.criteria ?? {})
            .sort()
            .join(',') === 'absent,present,unknown'
        ) {
          binaryConversionObserved = true
          assert.ok(
            question.instructions?.includes(
              'Does this interval contain the same complete physical instance?',
            ),
          )
        }
        observed.push(`${id}:${question.type}`)
      }
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => {
          const ids = Object.keys(question.criteria ?? {})
          const selected = ids[0]
          assert.ok(selected)
          return [
            id,
            {
              type: 'choice',
              choice: selected,
              probabilities: Object.fromEntries(
                ids.map((choice, index) => [choice, index ? 0 : 1]),
              ),
            },
          ]
        }),
      )
      return new Response(
        JSON.stringify({
          id: `offline-${observed.length}`,
          model: freshProposalRoute.model,
          provider: freshProposalRoute.providerName,
          usage: { cost: 0.001 },
          answers,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const result = await runCategoricalPresenceFreshDev(
      {
        manifests: [{ path: manifestPath, sha256: digest(manifestBytes) }],
        imageRoot: root,
        outputRoot: join(root, 'runs'),
        apiKey: 'offlinekey',
        encoderPath: '/unused/encoder.onnx',
        decoderPath: '/unused/decoder.onnx',
        expectedCaseCount: 1,
        fetch,
        createObjectProposals: async () => proposalPort(),
      },
      categoricalFreshProfiles.preserveInstruction,
    )
    assert.equal(result.status, 'complete')
    assert.equal(result.results.length, 1)
    assert.ok(observed.length > 0)
    assert.ok(observed.every((item) => item.endsWith(':choice')))
    assert.equal(binaryConversionObserved, true)
    const callDirectory = join(result.outputDirectory, 'fixture-case', 'calls')
    const logicalFiles = (await readdir(callDirectory)).filter((name) =>
      /^logical-\d+\.json$/u.test(name),
    )
    const logicalRecords = await Promise.all(
      logicalFiles.map(
        async (name) =>
          JSON.parse(await readFile(join(callDirectory, name), 'utf8')) as {
            request: {
              questions: Array<{ id: string; type: string; optionIds?: string[] }>
            }
          },
      ),
    )
    const convertedPresence = logicalRecords
      .flatMap((record) => record.request.questions)
      .find((question) => {
        return question.optionIds?.slice().sort().join(',') === 'absent,present,unknown'
      })
    assert.ok(convertedPresence)
    assert.equal(convertedPresence.type, 'choice')
    assert.equal(
      logicalRecords.some((record) =>
        record.request.questions.some((question) => question.type === 'noul'),
      ),
      false,
    )
    const summary = JSON.parse(
      await readFile(join(result.outputDirectory, 'summary.json'), 'utf8'),
    ) as {
      aggregate: {
        admittedPhysicalCalls: number
        knownCostUsd: number
        unknownCostCalls: number
        inFlightCalls: number
        accountedExposureUsd: number
      }
    }
    assert.equal(summary.aggregate.admittedPhysicalCalls, fetchCount)
    assert.equal(
      summary.aggregate.accountedExposureUsd,
      summary.aggregate.knownCostUsd + summary.aggregate.unknownCostCalls * 0.05,
    )
    assert.equal(summary.aggregate.inFlightCalls, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
