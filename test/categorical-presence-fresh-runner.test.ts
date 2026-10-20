import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import { currentRuntimeSourcePaths } from './fixtures/current-runtime-sources.js'
import {
  CATEGORICAL_FRESH_MAX_PHYSICAL_PER_CASE,
  CATEGORICAL_FRESH_MAX_PHYSICAL_PER_PROFILE,
  CategoricalFreshCaseBudget,
  assertCategoricalFreshCallBound,
  categoricalFreshProfiles,
  categoricalFreshProducerSourceFiles,
  categoricalFreshProducerSourceManifest,
  categoricalTargetInstruction,
  freshProposalRoute,
  runCategoricalPresenceFreshDev,
  runCategoricalPresenceFreshPair,
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

function proposalForInput(
  input: Parameters<ObjectProposalPort['propose']>[0],
): ObjectProposalBatch {
  const pixels = input.image.width * input.image.height
  const data = new Uint8Array(Math.ceil(pixels / 8))
  data.fill(255)
  if (pixels % 8) data[data.length - 1] = (1 << pixels % 8) - 1
  return {
    proposals: [
      {
        id: 'C00',
        mask: { data, width: input.image.width, height: input.image.height, format: 'binary-lsb0' },
      },
    ],
    metadata: {
      method: 'mobile-sam-nine-point-proposals-v1',
      backend: 'mobile-sam',
      durationMs: 1,
      input: { width: input.image.width, height: input.image.height },
    },
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
  assert.equal(
    categoricalFreshProfiles.boxConfirmation.id,
    'native-luna-box-confirmation-sam-target-plus-neutral-v1',
  )
  assert.equal(
    categoricalFreshProfiles.boxConfirmation.targetPolicy,
    categoricalFreshProfiles.preserveInstruction.targetPolicy,
  )
  assert.equal(
    targetForProfile(instructed, categoricalFreshProfiles.boxConfirmation),
    targetForProfile(instructed, categoricalFreshProfiles.preserveInstruction),
  )
  assert.notEqual(
    categoricalFreshProfiles.boxConfirmation.id,
    categoricalFreshProfiles.preserveInstruction.id,
  )
  assert.throws(() => {
    validateTargetPolicyTasks([
      { ...instructed, locate: { ...instructed.locate, instruction: 'Keep the red object.' } },
    ])
  }, /unapproved locate instruction/u)
})

await test('producer closure pins the dedicated box-confirmation CLI directly', async () => {
  const relativePath = './run-categorical-box-confirmation-dev.ts'
  assert.ok(categoricalFreshProducerSourceFiles.includes(relativePath))
  const source = await categoricalFreshProducerSourceManifest()
  assert.equal(source[relativePath]?.length, 64)
  assert.deepEqual(
    Object.keys(source)
      .filter((path) => path.startsWith('src/'))
      .sort(),
    await currentRuntimeSourcePaths(),
  )
  assert.ok(Object.hasOwn(source, 'src/processes/extract-from-region.ts'))
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
      categoricalFreshProfiles.boxConfirmation,
    )
    assert.equal(result.status, 'complete')
    assert.equal(result.profileId, categoricalFreshProfiles.boxConfirmation.id)
    assert.equal(result.targetPolicy, 'target-plus-neutral-instruction-v1')
    const manifest = JSON.parse(
      await readFile(join(result.outputDirectory, 'run-manifest.json'), 'utf8'),
    ) as { profileId: string; targetPolicy: string }
    assert.equal(manifest.profileId, categoricalFreshProfiles.boxConfirmation.id)
    assert.equal(manifest.targetPolicy, 'target-plus-neutral-instruction-v1')
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

await test('persistence failure aborts and joins peers, attempts both cleanups, and stops profile B', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-categorical-cleanup-'))
  try {
    const image = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#dddddd' },
    })
      .png()
      .toBuffer()
    const cases = ['fixture-a', 'fixture-b'].map((caseId) => ({
      ...fixtureCase,
      caseId,
      image: { ...fixtureCase.image, sha256: digest(image) },
    }))
    await writeFile(join(root, 'fixture.png'), image, { flag: 'wx' })
    const manifestBytes = Buffer.from(JSON.stringify(cases))
    const manifestPath = join(root, 'inputs.json')
    await writeFile(manifestPath, manifestBytes, { flag: 'wx' })

    let fetchCount = 0
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      fetchCount++
      if (proposalCalls >= 2) throw new Error('offline transport failure')
      const body = JSON.parse(String(init?.body)) as {
        questions: Record<string, { criteria?: Record<string, string> }>
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
          id: `offline-${fetchCount}`,
          model: freshProposalRoute.model,
          provider: freshProposalRoute.providerName,
          usage: { cost: 0.001 },
          answers,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    let proposalCalls = 0
    let pendingNative = 0
    let settleCalls = 0
    let disposeCalls = 0
    const proposals: ObjectProposalPort = {
      async propose(input) {
        proposalCalls++
        if (proposalCalls !== 1) return proposalForInput(input)
        pendingNative++
        return new Promise<ObjectProposalBatch>((_resolve, reject) => {
          const aborted = () => {
            pendingNative--
            reject(Object.assign(new Error('aborted native fixture'), { code: 'ABORTED' }))
          }
          input.signal.addEventListener('abort', aborted, { once: true })
          if (input.signal.aborted) aborted()
        })
      },
      async settle() {
        settleCalls++
        assert.equal(pendingNative, 0, 'native promise must be joined before settle')
        throw new Error('settle cleanup failure')
      },
      async dispose() {
        disposeCalls++
      },
    }
    const options = {
      manifests: [{ path: manifestPath, sha256: digest(manifestBytes) }],
      imageRoot: root,
      outputRoot: join(root, 'runs'),
      apiKey: 'offlinekey',
      encoderPath: '/unused/encoder.onnx',
      decoderPath: '/unused/decoder.onnx',
      expectedCaseCount: 2,
      fetch,
      createObjectProposals: async () => proposals,
      testHooks: {
        async writeCaseResult(path: string, value: unknown) {
          if (proposalCalls >= 2) throw new Error('immutable result write failure')
          await writeFile(path, `${JSON.stringify(value)}\n`, { flag: 'wx' })
        },
      },
    }
    const result = await runCategoricalPresenceFreshPair(options)
    assert.equal(result.preserve.status, 'incomplete')
    assert.equal(result.targetOnly, null)
    assert.equal(proposalCalls, 2, JSON.stringify(result.preserve))
    assert.equal(pendingNative, 0)
    assert.equal(settleCalls, 1)
    assert.equal(disposeCalls, 1)
    assert.equal(result.preserve.settleError, 'RUNNER_FAILURE')
    assert.ok('workerFailureCodes' in result.preserve)
    assert.ok(result.preserve.workerFailureCodes.length > 0)
    assert.ok(result.preserve.aggregate.unknownCostCalls > 0)
    assert.equal(result.preserve.aggregate.inFlightCalls, 0)

    const files = await readdir(result.preserve.outputDirectory)
    assert.ok(files.includes('incomplete-evidence.json'))
    assert.equal(files.includes('summary.json'), false)
    assert.equal(files.includes('run-complete.json'), false)
    assert.equal(files.filter((name) => name.startsWith('v02-fresh-')).length, 0)
    const evidence = JSON.parse(
      await readFile(join(result.preserve.outputDirectory, 'incomplete-evidence.json'), 'utf8'),
    ) as { aggregate: { unknownCostCalls: number }; status: string }
    assert.equal(evidence.status, 'incomplete')
    assert.ok(evidence.aggregate.unknownCostCalls > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
