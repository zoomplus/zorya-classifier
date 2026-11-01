import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync } from 'node:fs'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { test } from 'node:test'
import { z } from 'zod'
import type {
  DecisionRequest,
  DecisionResult,
  RasterImage,
} from '../../../src/entities/contracts.js'
import { ClassifierError } from '../../../src/entities/errors.js'
import {
  fakeWorkerScriptPath,
  H8aFullNativePort,
  type H8aNativeGenerationInput,
  type H8aNativeGenerationOutput,
} from './native-port.js'
import { runBoundedNativeChild, buildNativeChildEnv } from './native-bounded-child.js'
import { H8A_FULL_NATIVE_REQUEST_SCHEMA, H8A_FULL_RECIPE_ID } from './constants.js'
import { H6_QUERY_POLICY_INSTRUCTIONS } from '../h6-query-policy.js'
import type { H6QueryPolicyId } from '../h6-query-policy.js'
import type { H6PresencePolicyId } from '../h6-presence-policy.js'
import type { SegmentationPort } from '../../../src/entities/segmentation.js'
import { createClassifier } from '../../../src/app/create-classifier.js'
import { createOpenRouterDecisions } from '../../../src/openrouter.js'
import { createNativeCategoricalPresencePort } from '../../v02/native-categorical-presence-port.js'
import { assertRecorderHealthy, processRegionSeededCase } from '../../v02/region-seeded-runner.js'
import { CampaignLedger } from '../h8a-fresh-comparison/campaign-ledger.js'
import { createH8FreshRuntimePortsForOfflineFixture } from '../h8a-fresh-comparison/runtime-ports.js'
import {
  PROFILE_FLAT_CANDIDATE_ID,
  PROFILE_SCOPE_CANDIDATE_ID,
} from '../h8a-fresh-comparison/constants.js'

function missingPythonExecutable(): never {
  throw new Error('H8A_PYTHON_EXECUTABLE is required for the native test group')
}

const pythonExecutable = process.env.H8A_PYTHON_EXECUTABLE ?? missingPythonExecutable()

async function writeFixtureSource(): Promise<{
  sourcePath: string
  sourceSha256: string
  png: Buffer
}> {
  const sourcePath = join(tmpdir(), `h8af-source-${Date.now()}-${Math.random()}.png`)
  const png = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 40, g: 50, b: 60 } },
  })
    .png()
    .toBuffer()
  await writeFile(sourcePath, png)
  return { sourcePath, sourceSha256: createHash('sha256').update(png).digest('hex'), png }
}

function nativeInput(
  source: { sourcePath: string; sourceSha256: string },
  signal: AbortSignal,
  overrides?: Partial<H8aNativeGenerationInput>,
): H8aNativeGenerationInput {
  return {
    authoredTarget: 'small amber marker beside the road',
    sourcePath: source.sourcePath,
    sourceSha256: source.sourceSha256,
    width: 64,
    height: 48,
    deadlineAt: performance.now() + 10_000,
    signal,
    ...overrides,
  }
}

async function withFakePort(
  run: (
    port: H8aFullNativePort,
    artifactRoot: string,
    source: { sourcePath: string; sourceSha256: string },
  ) => Promise<void>,
  options?: {
    env?: Record<string, string | undefined>
    cleanupTaskDirectory?: (taskDir: string) => Promise<void>
  },
): Promise<void> {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'h8af-artifacts-'))
  const source = await writeFixtureSource()
  const envKeys = options?.env ? Object.keys(options.env) : []
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  if (options?.env) Object.assign(process.env, options.env)
  const port = new H8aFullNativePort({
    pythonExecutable,
    assetRoot: join(tmpdir(), 'h8af-assets-unused'),
    artifactRoot,
    workerScriptPath: fakeWorkerScriptPath(),
    ...(options?.cleanupTaskDirectory
      ? { cleanupTaskDirectory: options.cleanupTaskDirectory }
      : {}),
  })
  try {
    await run(port, artifactRoot, source)
  } finally {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    await port.dispose()
    await rm(artifactRoot, { recursive: true, force: true })
    await rm(source.sourcePath, { force: true })
  }
}

function parseProcStatPgrp(stat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const fields = stat.slice(close + 2).split(/\s+/u)
  if (fields.length < 3) return null
  const pgrp = Number(fields[2])
  return Number.isFinite(pgrp) ? pgrp : null
}

function parseProcStatState(stat: string): string | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const fields = stat.slice(close + 2).split(/\s+/u)
  return fields[0] ?? null
}

async function listProcessGroupPids(pgid: number): Promise<number[]> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir('/proc', { withFileTypes: true })
  const pids: number[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue
    const pid = Number(entry.name)
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      if (parseProcStatPgrp(stat) === pgid) pids.push(pid)
    } catch {
      continue
    }
  }
  return pids
}

async function processGroupAlive(pgid: number): Promise<boolean> {
  for (const pid of await listProcessGroupPids(pgid)) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      if (parseProcStatState(stat) !== 'Z') return true
    } catch {
      continue
    }
  }
  return false
}

async function assertProcessGroupClosed(pgid: number): Promise<void> {
  assert.equal(await processGroupAlive(pgid), false)
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if (!('code' in error)) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

async function killOwnedProcessGroup(pgid: number, signal: NodeJS.Signals): Promise<void> {
  if (!Number.isInteger(pgid) || pgid <= 0) return
  try {
    process.kill(-pgid, signal)
  } catch (error) {
    if (errnoCode(error) === 'ESRCH') return
    throw error
  }
  await assertProcessGroupClosed(pgid)
}

await test('fake native worker completes and filters empty masks without renumbering', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'h8af-artifacts-'))
  const taskDir = join(artifactRoot, 'h8af-full-tasks', 'fixture-job')
  const sourcePath = join(tmpdir(), `h8af-source-${Date.now()}.png`)
  const png = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 40, g: 50, b: 60 } },
  })
    .png()
    .toBuffer()
  await writeFile(sourcePath, png)
  const sourceSha256 = createHash('sha256').update(png).digest('hex')
  const requestPath = join(taskDir, 'request.json')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(taskDir, { recursive: true })
  await writeFile(
    requestPath,
    JSON.stringify({
      schema: H8A_FULL_NATIVE_REQUEST_SCHEMA,
      request_id: randomUUID(),
      recipe_id: H8A_FULL_RECIPE_ID,
      authored_target: 'small amber marker beside the road',
      task_dir: taskDir,
      assets_dir: join(tmpdir(), 'missing-assets'),
      source_path: sourcePath,
      source_sha256: sourceSha256,
      width: 64,
      height: 48,
    }),
    'utf8',
  )
  const child = await runBoundedNativeChild({
    command: process.execPath,
    args: [fakeWorkerScriptPath(), '--generate', requestPath],
    env: buildNativeChildEnv(taskDir),
    deadlineAt: performance.now() + 10_000,
    signal: new AbortController().signal,
    taskTempDir: taskDir,
  })
  assert.equal(child.status, 'complete')
  const response = JSON.parse(await readFile(join(taskDir, 'native-response.json'), 'utf8')) as {
    families: { D: Array<{ id: string; empty: boolean }> }
  }
  const ids = response.families.D.map((item) => item.id)
  assert.deepEqual(
    ids.filter((id) => id !== 'D02'),
    ['D00', 'D01'],
  )
  await rm(artifactRoot, { recursive: true, force: true })
  await rm(sourcePath, { force: true })
})

await test('native port carries an explicit v2 recipe identity through the worker reply', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'h8af-artifacts-v2-'))
  const sourcePath = join(tmpdir(), 'h8af-v2-source.png')
  const port = new H8aFullNativePort({
    pythonExecutable,
    assetRoot: join(tmpdir(), 'h8af-assets-unused'),
    artifactRoot,
    workerScriptPath: fakeWorkerScriptPath(),
    recipeId: 'h8a-cpu-flat-target-v2',
  })
  try {
    const result = await port.generate({
      authoredTarget: 'toolbar button for Search for Files...',
      sourcePath,
      sourceSha256: 'a'.repeat(64),
      width: 64,
      height: 48,
      deadlineAt: performance.now() + 20_000,
      signal: new AbortController().signal,
    })
    assert.equal(result.recipeId, 'h8a-cpu-flat-target-v2')
    assert.equal(result.detectorPrompt, 'a toolbar button for Search for Files...')
  } finally {
    await port.dispose()
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

await test('native port rejects a worker reply carrying the other recipe identity', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'h8af-artifacts-v2-mismatch-'))
  const priorMode = process.env.H8A_FAKE_WORKER_MODE
  process.env.H8A_FAKE_WORKER_MODE = 'wrong_recipe_identity'
  const port = new H8aFullNativePort({
    pythonExecutable,
    assetRoot: join(tmpdir(), 'h8af-assets-unused'),
    artifactRoot,
    workerScriptPath: fakeWorkerScriptPath(),
    recipeId: 'h8a-cpu-flat-target-v2',
  })
  try {
    await assert.rejects(
      port.generate({
        authoredTarget: 'toolbar button for Search for Files...',
        sourcePath: join(tmpdir(), 'h8af-v2-source.png'),
        sourceSha256: 'b'.repeat(64),
        width: 64,
        height: 48,
        deadlineAt: performance.now() + 20_000,
        signal: new AbortController().signal,
      }),
      /native response recipe_id mismatch/u,
    )
  } finally {
    await port.dispose()
    await rm(artifactRoot, { recursive: true, force: true })
    if (priorMode === undefined) delete process.env.H8A_FAKE_WORKER_MODE
    else process.env.H8A_FAKE_WORKER_MODE = priorMode
  }
})

await test('fresh authored-scope binding reaches the real factory and four offline provider stages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8af-fresh-scope-'))
  const source = await writeFixtureSource()
  const requests: Array<{ body: unknown; task: unknown }> = []
  const requestBodySchema = z
    .object({
      model: z.string(),
      provider: z
        .object({
          only: z.array(z.string()),
          allow_fallbacks: z.boolean(),
          sort: z.string().optional(),
        })
        .passthrough(),
      max_tokens: z.number(),
      reasoning: z.object({ effort: z.string() }).passthrough(),
      messages: z
        .array(
          z
            .object({
              role: z.string(),
              content: z.union([
                z.string(),
                z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
              ]),
            })
            .passthrough(),
        )
        .length(2),
    })
    .passthrough()
  const taskSchema = z
    .object({
      questions: z.record(
        z
          .object({
            kind: z.enum(['presence', 'categorical']),
            rankingSize: z.number().int().positive().optional(),
            instructions: z.string(),
            options: z.record(z.string()).optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough()
  const controlledFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    const nativeTaskEntries = await readdir(join(root, 'artifacts', 'h8a-full-tasks'), {
      withFileTypes: true,
    })
    assert.deepEqual(
      nativeTaskEntries.filter((entry) => entry.isDirectory()),
      [],
    )
    const body = requestBodySchema.parse(JSON.parse(String(init?.body)))
    const user = body.messages[1]
    assert.ok(user && Array.isArray(user.content))
    const taskPart = user.content.find(
      (part) => typeof part.text === 'string' && part.text.startsWith('CLASSIFICATION_TASK\n'),
    )
    assert.ok(taskPart?.text)
    const task = taskSchema.parse(JSON.parse(taskPart.text.slice('CLASSIFICATION_TASK\n'.length)))
    requests.push({ body, task })
    const answers = Object.fromEntries(
      Object.entries(task.questions).map(([id, question]) => {
        if (question.kind === 'presence') return [id, { presence: 'present' }]
        const keys = Object.keys(question.options ?? {})
        return [id, { ranking: keys.slice(0, Math.min(question.rankingSize ?? 4, keys.length)) }]
      }),
    )
    return new Response(
      JSON.stringify({
        id: `scope-offline-${requests.length}`,
        model: 'openai/gpt-6-luna',
        provider: 'OpenAI',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { content: JSON.stringify({ answers }) },
          },
        ],
        usage: { cost: 0.002 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }
  const unusedSegmenter: SegmentationPort = {
    async segment() {
      return {
        status: 'unknown',
        reason: 'unused',
        metadata: {
          method: 'fixture',
          backend: 'fixture',
          durationMs: 0,
          input: { width: 1, height: 1 },
        },
      }
    },
    async settle() {},
    async dispose() {},
  }
  const options = {
    apiKey: 'offline',
    artifactRoot: join(root, 'artifacts'),
    temporaryRoot: join(root, 'temporary'),
    maskArtifactDirectory: join(root, 'masks'),
    cutoutArtifactDirectory: join(root, 'cutouts'),
    nativeRuntime: {
      pythonExecutable,
      assetRoot: join(root, 'assets-unused'),
      workerScriptPath: fakeWorkerScriptPath(),
      recipeId: PROFILE_FLAT_CANDIDATE_ID,
      queryPolicyId: 'strict-authored-scope-v1' as const,
    },
    candidateProfileId: PROFILE_SCOPE_CANDIDATE_ID,
    mobileSam: {
      encoderPath: join(root, 'unused-encoder.onnx'),
      decoderPath: join(root, 'unused-decoder.onnx'),
    },
    sourceCanvasByOpaqueCaseId: new Map([['scope-native-suite-case', { width: 64, height: 48 }]]),
    fetch: controlledFetch,
    controlEngine: {
      kind: 'offline-fixture-only' as const,
      processRegionSeededCase,
      assertRecorderHealthy,
      createClassifier,
      createOpenRouterDecisions,
      createNativeCategoricalPresencePort,
      createControlSegmenter: () => unusedSegmenter,
    },
  }
  const originalFetch = globalThis.fetch
  Reflect.set(globalThis, 'fetch', async () => {
    throw new Error('unexpected non-injected network request')
  })
  let runtimePorts:
    | Awaited<ReturnType<typeof createH8FreshRuntimePortsForOfflineFixture>>
    | undefined
  try {
    runtimePorts = await createH8FreshRuntimePortsForOfflineFixture(options)
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const result = await runtimePorts.candidatePort.execute(
      {
        opaqueCaseId: 'scope-native-suite-case',
        sourceBytes: new Uint8Array(source.png),
        targetTaskText: 'the visible amber marker',
      },
      { profileId: PROFILE_SCOPE_CANDIDATE_ID, reservedUsdPerFetch: 0.55, ledger },
    )
    assert.equal(requests.length, 4)
    assert.equal(ledger.snapshot().physicalDispatchCount, 4)
    assert.equal(ledger.snapshot().knownCostUsd, 0.008)
    assert.equal(ledger.snapshot().unknownReserveUsd, 0)
    assert.equal(ledger.snapshot().inFlightReservations.length, 0)
    assert.equal(result.outputRow.profileId, PROFILE_SCOPE_CANDIDATE_ID)
    assert.equal(result.outputRow.caseState, 'success')
    assert.deepEqual(result.outputRow.box, { left: 2, top: 2, width: 6, height: 6 })
    assert.equal(result.caseArtifactSidecars?.[0]?.profileId, PROFILE_SCOPE_CANDIDATE_ID)
    assert.equal(
      runtimePorts.artifacts.cutoutsByProfileAndCase.has(
        `${PROFILE_SCOPE_CANDIDATE_ID}:scope-native-suite-case`,
      ),
      true,
    )
    assert.ok(
      [...runtimePorts.artifacts.masksBySha256.values()].some(
        (mask) =>
          mask.width === 64 &&
          mask.height === 48 &&
          mask.sha256 === result.outputRow.maskPackedSha256,
      ),
    )
    const expectedInstructionPairs = [
      [H6_QUERY_POLICY_INSTRUCTIONS.presenceState, H6_QUERY_POLICY_INSTRUCTIONS.presenceQuestion],
      [
        H6_QUERY_POLICY_INSTRUCTIONS.nominationState,
        H6_QUERY_POLICY_INSTRUCTIONS.nominationQuestion,
      ],
      [
        H6_QUERY_POLICY_INSTRUCTIONS.nominationState,
        H6_QUERY_POLICY_INSTRUCTIONS.nominationQuestion,
      ],
      [H6_QUERY_POLICY_INSTRUCTIONS.finalState, H6_QUERY_POLICY_INSTRUCTIONS.finalQuestion],
    ] as const
    for (const [index, request] of requests.entries()) {
      const task = taskSchema.parse(request.task)
      const question = Object.values(task.questions)[0]
      assert.ok(question)
      assert.ok(question.instructions.endsWith(expectedInstructionPairs[index]![1]))
      const body = requestBodySchema.parse(request.body)
      const user = body.messages[1]
      assert.ok(user && Array.isArray(user.content))
      const stateTexts = user.content.flatMap((part) => (part.text ? [part.text] : []))
      assert.ok(stateTexts.some((text) => text.endsWith(expectedInstructionPairs[index]![0])))
      assert.equal(body.model, 'openai/gpt-6-luna')
      assert.deepEqual(body.provider.only, ['openai'])
      assert.equal(body.provider.allow_fallbacks, false)
      assert.equal(body.provider.sort, undefined)
      assert.equal(body.max_tokens, 4096)
      assert.equal(body.reasoning.effort, 'medium')
    }
  } finally {
    try {
      await runtimePorts?.dispose()
    } finally {
      Reflect.set(globalThis, 'fetch', originalFetch)
      await rm(root, { recursive: true, force: true })
      await rm(source.sourcePath, { force: true })
    }
  }
})

for (const { queryPolicyId, presencePolicyId, label } of [
  { queryPolicyId: undefined, presencePolicyId: undefined, label: 'default legacy' },
  {
    queryPolicyId: 'strict-authored-scope-v1',
    presencePolicyId: undefined,
    label: 'strict query',
  },
  { queryPolicyId: undefined, presencePolicyId: 'control-binary-v1', label: 'binary presence' },
] as const) {
  await test(`full runtime locates with fake native worker and respects four decision calls (${label})`, async () => {
    const { createH8aFullRuntime } = await import('./factory.js')
    const artifactRoot = await mkdtemp(join(tmpdir(), 'h8af-artifacts-'))
    const runtimeConfig: {
      pythonExecutable: string
      assetRoot: string
      artifactRoot: string
      workerScriptPath: string
      recipeId: 'h8a-cpu-flat-target-v2'
      queryPolicyId?: H6QueryPolicyId
      presencePolicyId?: H6PresencePolicyId
    } = {
      pythonExecutable,
      assetRoot: join(tmpdir(), 'h8af-assets-unused'),
      artifactRoot,
      workerScriptPath: fakeWorkerScriptPath(),
      recipeId: 'h8a-cpu-flat-target-v2' as const,
      ...(queryPolicyId === undefined ? {} : { queryPolicyId }),
      ...(presencePolicyId === undefined ? {} : { presencePolicyId }),
    }
    const runtime = createH8aFullRuntime(runtimeConfig)
    runtimeConfig.queryPolicyId =
      queryPolicyId === undefined ? 'strict-authored-scope-v1' : 'legacy-v1'
    if (presencePolicyId === undefined) runtimeConfig.presencePolicyId = 'control-binary-v1'
    else delete runtimeConfig.presencePolicyId
    const stages: string[] = []
    const capturedRequests: DecisionRequest[] = []
    const rawWidth = 96
    const rawHeight = 64
    const rawInput = Buffer.alloc(rawWidth * rawHeight * 3)
    for (let y = 0; y < rawHeight; y++) {
      for (let x = 0; x < rawWidth; x++) {
        const offset = (y * rawWidth + x) * 3
        rawInput[offset] = (x * 7 + y * 3) % 256
        rawInput[offset + 1] = (x * 2 + y * 11) % 256
        rawInput[offset + 2] = (x * 5 + y * 13) % 256
      }
    }
    const jpeg = await sharp(rawInput, { raw: { width: rawWidth, height: rawHeight, channels: 3 } })
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const rawDecoded = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    assert.equal(rawDecoded.info.width, rawWidth)
    assert.equal(rawDecoded.info.height, rawHeight)
    const expectedWidth = rawHeight
    const expectedHeight = rawWidth
    const expectedRgba = Buffer.alloc(expectedWidth * expectedHeight * 4)
    for (let y = 0; y < rawHeight; y++) {
      for (let x = 0; x < rawWidth; x++) {
        const source = (y * rawWidth + x) * 3
        const rotatedX = rawHeight - 1 - y
        const rotatedY = x
        const target = (rotatedY * expectedWidth + rotatedX) * 4
        expectedRgba[target] = rawDecoded.data[source] ?? 0
        expectedRgba[target + 1] = rawDecoded.data[source + 1] ?? 0
        expectedRgba[target + 2] = rawDecoded.data[source + 2] ?? 0
        expectedRgba[target + 3] = 255
      }
    }
    const metadata = {
      model: 'mock-model',
      provider: 'mock-provider',
      requestId: 'mock-request',
      durationMs: 1,
      costUsd: 0,
      attempts: 1,
    }
    const recordRequest = async (request: DecisionRequest) => {
      capturedRequests.push(structuredClone(request))
      const { readdir } = await import('node:fs/promises')
      const nativeTaskEntries = await readdir(join(artifactRoot, 'h8a-full-tasks'), {
        withFileTypes: true,
      })
      assert.deepEqual(
        nativeTaskEntries.filter((entry) => entry.isDirectory()),
        [],
      )
      const stateText = request.state.filter((part): part is string => typeof part === 'string')
      const question = request.questions.presence ?? request.questions.selection
      const binaryPresence =
        !request.questions.presence &&
        question?.type === 'choice' &&
        Object.keys(question.criteria).join(',') === 'present,absent'
      stages.push(
        request.questions.presence || binaryPresence
          ? 'presence'
          : stateText.some((part) => part.includes('from family D'))
            ? 'nominate-D'
            : stateText.some((part) => part.includes('from family U'))
              ? 'nominate-U'
              : 'final-select',
      )
    }
    const decision = {
      async decide(request: DecisionRequest): Promise<DecisionResult> {
        await recordRequest(request)
        const question = request.questions.presence ?? request.questions.selection
        assert.ok(question?.type === 'choice')
        const keys = Object.keys(question.criteria)
        const rankingSize = question.rankingSize ?? 4
        if (request.questions.presence) {
          return {
            answers: {
              presence: {
                type: 'ranked-choice',
                ranking: ['present'],
              },
            },
            metadata,
          }
        }
        const first = keys.includes('D00') ? 'D00' : (keys[0] ?? 'none')
        const ranking = [first, ...keys.filter((key) => key !== first)].slice(
          0,
          Math.min(rankingSize, keys.length),
        )
        return {
          answers: { selection: { type: 'ranked-choice', ranking } },
          metadata,
        }
      },
    }
    const presencePort = {
      async decide(request: DecisionRequest): Promise<DecisionResult> {
        await recordRequest(request)
        const question = request.questions.selection
        assert.ok(question?.type === 'choice')
        assert.deepEqual(Object.keys(question.criteria), ['present', 'absent'])
        return {
          answers: {
            selection: { type: 'ranked-choice', ranking: ['present'] },
          },
          metadata,
        }
      },
    }
    let imageStateCalls = 0
    const presentationCounts: string[] = []
    const presentation = {
      async renderPresence({
        image,
      }: {
        image: { data: Uint8Array; width: number; height: number }
      }) {
        presentationCounts.push('presence:1')
        return [await pngRaster(image)]
      },
      async renderNomination({
        image,
        candidates,
      }: {
        image: { data: Uint8Array; width: number; height: number }
        candidates: readonly unknown[]
      }) {
        const pageCount = Math.ceil(candidates.length / 9)
        presentationCounts.push(`nomination:${candidates.length}:${1 + pageCount}`)
        return [
          await pngRaster(image),
          ...(await Promise.all(Array.from({ length: pageCount }, () => pngRaster(image)))),
        ]
      },
      async renderFinal({
        image,
        candidates,
      }: {
        image: { data: Uint8Array; width: number; height: number }
        candidates: readonly unknown[]
      }) {
        presentationCounts.push(`final:${candidates.length}:${1 + candidates.length}`)
        return [
          await pngRaster(image),
          ...(await Promise.all(candidates.map(() => pngRaster(image)))),
        ]
      },
    }
    let preparedPresenceTransform: string | undefined
    const imageState = async (image: RasterImage) => {
      imageStateCalls++
      const decoded = await sharp(image.bytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      assert.equal(decoded.info.width, expectedWidth)
      assert.equal(decoded.info.height, expectedHeight)
      assert.deepEqual(decoded.data, expectedRgba)
      const state = [
        {
          type: 'image_url' as const,
          image_url: {
            url: `data:image/png;base64,${Buffer.from(image.bytes).toString('base64')}`,
            detail: 'high' as const,
          },
        },
      ]
      if (presencePolicyId !== 'control-binary-v1') return state
      preparedPresenceTransform = JSON.stringify({
        sourceImageTransform: {
          source: { width: image.width, height: image.height },
          output: { width: image.width, height: image.height },
          content: { left: 0, top: 0, width: image.width, height: image.height },
          scaleX: 1,
          scaleY: 1,
        },
      })
      return [...state, preparedPresenceTransform]
    }
    try {
      const runExclusions: string[] = []
      const runInput = {
        encodedImage: new Uint8Array(jpeg),
        authoredTarget: 'small amber marker beside the road',
        exclusions: runExclusions,
        includeCutout: true,
        signal: new AbortController().signal,
        decision,
        ...(presencePolicyId === 'control-binary-v1' ? { presenceDecision: presencePort } : {}),
        imageState,
        presentation,
      }
      const running = runtime.run(runInput)
      if (presencePolicyId === 'control-binary-v1')
        presencePort.decide = async () => {
          throw new Error('late presence port mutation')
        }
      runInput.encodedImage.fill(0)
      runInput.authoredTarget = 'mutated target after admission'
      runExclusions.push('mutated exclusion after admission')
      runInput.includeCutout = false
      runInput.signal = new AbortController().signal
      let result
      try {
        result = await running
      } catch (error) {
        const message = error instanceof Error ? error.message : 'runtime fixture failed'
        assert.fail(`${message}; presentation counts: ${presentationCounts.join(',')}`)
      }
      assert.equal(result.status, 'located')
      assert.equal(result.recipeId, 'h8a-cpu-flat-target-v2')
      assert.equal(stages.length, 4)
      assert.equal(capturedRequests.length, 4)
      const capturedPresence = capturedRequests[0]
      const capturedD = capturedRequests[1]
      const capturedU = capturedRequests[2]
      const capturedFinal = capturedRequests.at(-1)
      assert.ok(capturedPresence && capturedD && capturedU && capturedFinal)
      const firstText = (request: DecisionRequest) =>
        request.state.find((part): part is string => typeof part === 'string')
      const policyFields: Array<[string | undefined, string]> = []
      if (presencePolicyId !== 'control-binary-v1') {
        policyFields.push(
          [firstText(capturedPresence), H6_QUERY_POLICY_INSTRUCTIONS.presenceState],
          [
            capturedPresence.questions.presence?.instructions,
            H6_QUERY_POLICY_INSTRUCTIONS.presenceQuestion,
          ],
        )
      }
      policyFields.push(
        [firstText(capturedD), H6_QUERY_POLICY_INSTRUCTIONS.nominationState],
        [
          capturedD.questions.selection?.instructions,
          H6_QUERY_POLICY_INSTRUCTIONS.nominationQuestion,
        ],
        [firstText(capturedU), H6_QUERY_POLICY_INSTRUCTIONS.nominationState],
        [
          capturedU.questions.selection?.instructions,
          H6_QUERY_POLICY_INSTRUCTIONS.nominationQuestion,
        ],
        [firstText(capturedFinal), H6_QUERY_POLICY_INSTRUCTIONS.finalState],
        [
          capturedFinal.questions.selection?.instructions,
          H6_QUERY_POLICY_INSTRUCTIONS.finalQuestion,
        ],
      )
      for (const [field, suffix] of policyFields) {
        assert.ok(field)
        assert.equal(
          field.endsWith(suffix),
          queryPolicyId === 'strict-authored-scope-v1',
          `unexpected policy composition in ${suffix.slice(0, 24)}`,
        )
      }
      if (presencePolicyId === 'control-binary-v1') {
        const question = capturedPresence.questions.selection
        assert.ok(question?.type === 'choice')
        assert.equal(question.rankingSize, 1)
        assert.deepEqual(Object.keys(question.criteria), ['present', 'absent'])
        assert.equal(
          question.instructions,
          'Does this image contain small amber marker beside the road?\n\nUse only the supplied image. Choose exactly one closed label.',
        )
        assert.equal(capturedPresence.state[1], preparedPresenceTransform)
      }
      if (result.status !== 'located') assert.fail('full runtime should locate fixture mask')
      assert.ok(result.cutout)
      assert.equal(result.sourceFrame.width, expectedWidth)
      assert.equal(result.sourceFrame.height, expectedHeight)
      assert.equal(result.mask.width, expectedWidth)
      assert.equal(result.mask.height, expectedHeight)
      assert.equal(result.mask.format, 'binary-lsb0')
      assert.match(result.sourceFrame.sha256, /^[a-f0-9]{64}$/u)
      assert.match(result.originalEncodedSha256, /^[a-f0-9]{64}$/u)
      assert.equal(result.originalEncodedSha256, createHash('sha256').update(jpeg).digest('hex'))
      assert.notEqual(result.sourceFrame.sha256, result.originalEncodedSha256)
      assert.ok(imageStateCalls >= 1)
      assert.deepEqual(result.region, { left: 2, top: 2, width: 6, height: 6 })
      const firstMaskIndex = 2 * expectedWidth + 2
      assert.notEqual((result.mask.data[firstMaskIndex >> 3] ?? 0) & (1 << (firstMaskIndex & 7)), 0)
      assert.equal(result.cutout?.data.byteLength, 6 * 6 * 4)
      assert.deepEqual(
        Buffer.from(result.cutout?.data.subarray(0, 4) ?? []),
        expectedRgba.subarray((2 * expectedWidth + 2) * 4, (2 * expectedWidth + 2) * 4 + 4),
      )
      assert.deepEqual(stages, ['presence', 'nominate-D', 'nominate-U', 'final-select'])
      assert.deepEqual(presentationCounts, [
        'presence:1',
        'nomination:2:2',
        'nomination:1:2',
        'final:3:4',
      ])
      const { readdir } = await import('node:fs/promises')
      assert.deepEqual(await readdir(join(artifactRoot, 'h8a-full-runs')), [])
    } finally {
      await runtime.dispose()
      await rm(artifactRoot, { recursive: true, force: true })
    }

    async function pngRaster(image: {
      data: Uint8Array
      width: number
      height: number
    }): Promise<RasterImage> {
      const bytes = await sharp(image.data, {
        raw: { width: image.width, height: image.height, channels: 4 },
      })
        .png()
        .toBuffer()
      return { bytes: new Uint8Array(bytes), width: image.width, height: image.height }
    }
  })
}

await test('semantic unknown from composer differs from native failure', async () => {
  const { runH8aFullPipeline } = await import('./pipeline.js')
  const png = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png()
    .toBuffer()
  const metadata = {
    model: 'mock',
    provider: 'mock',
    requestId: '1',
    durationMs: 1,
    costUsd: 0,
    attempts: 1,
  }
  const decision = {
    async decide(request: DecisionRequest): Promise<DecisionResult> {
      if (request.questions.presence) {
        return {
          answers: {
            presence: {
              type: 'ranked-choice',
              ranking: ['absent'],
            },
          },
          metadata,
        }
      }
      throw new Error('unexpected stage')
    },
  }
  const imageState = async (image: RasterImage) => [
    {
      type: 'image_url' as const,
      image_url: {
        url: `data:image/png;base64,${Buffer.from(image.bytes).toString('base64')}`,
        detail: 'high' as const,
      },
    },
  ]
  const native = {
    async generate() {
      return {
        recipeId: 'h8a-cpu-flat-target-v2' as const,
        families: { D: [], U: [] },
        detectorPrompt: 'a fixture',
      }
    },
  }
  const artifactRoot = await mkdtemp(join(tmpdir(), 'h8af-pipeline-'))
  try {
    const result = await runH8aFullPipeline(
      {
        encodedImage: new Uint8Array(png),
        authoredTarget: 'fixture target',
        signal: new AbortController().signal,
      },
      {
        decision,
        imageState,
        native,
        artifactRoot,
      },
    )
    assert.equal(result.status, 'unknown')
    assert.equal(result.recipeId, 'h8a-cpu-flat-target-v2')
    assert.ok(result.reason === 'target-absent' || result.reason === 'no-nominees')
    await assert.rejects(
      runH8aFullPipeline(
        {
          encodedImage: new Uint8Array(png),
          authoredTarget: 'fixture target',
          signal: new AbortController().signal,
        },
        {
          decision,
          imageState: async () => [],
          native: {
            async generate() {
              throw new ClassifierError('PROVIDER', 'native transport failure')
            },
          },
          artifactRoot,
        },
      ),
      (error: unknown) => error instanceof ClassifierError && error.code === 'PROVIDER',
    )
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

await test('full runtime dispose aborts and joins an outstanding H6 decision', async () => {
  const { createH8aFullRuntime } = await import('./factory.js')
  const artifactRoot = await mkdtemp(join(tmpdir(), 'h8af-dispose-h6-'))
  const runtime = createH8aFullRuntime({
    pythonExecutable,
    assetRoot: join(tmpdir(), 'h8af-assets-unused'),
    artifactRoot,
    workerScriptPath: fakeWorkerScriptPath(),
  })
  const png = await sharp({
    create: { width: 48, height: 32, channels: 3, background: { r: 20, g: 30, b: 40 } },
  })
    .png()
    .toBuffer()
  const metadata = {
    model: 'fixture-model',
    provider: 'fixture-provider',
    requestId: 'fixture-request',
    durationMs: 1,
    costUsd: 0,
    attempts: 1,
  }
  let markEntered!: () => void
  const entered = new Promise<void>((resolveEntered) => {
    markEntered = resolveEntered
  })
  let settleDecision: ((value: DecisionResult) => void) | undefined
  let h6Signal: AbortSignal | undefined
  const decision = {
    decide(_request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
      h6Signal = signal
      markEntered()
      return new Promise<DecisionResult>((resolveDecision) => {
        settleDecision = resolveDecision
      })
    },
  }
  const imageState = async (image: RasterImage) => [
    {
      type: 'image_url' as const,
      image_url: {
        url: `data:image/png;base64,${Buffer.from(image.bytes).toString('base64')}`,
        detail: 'high' as const,
      },
    },
  ]
  const input = {
    encodedImage: new Uint8Array(png),
    authoredTarget: 'small amber marker beside the road',
    signal: new AbortController().signal,
    decision,
    imageState,
  }
  const run = runtime.run(input)
  const runOutcome = run.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  try {
    let entryTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        entered,
        new Promise<never>((_resolve, reject) => {
          entryTimer = setTimeout(
            () => reject(new Error('H6 fixture did not enter before its bound')),
            10_000,
          )
        }),
      ])
    } finally {
      if (entryTimer !== undefined) clearTimeout(entryTimer)
    }
    let disposeSettled = false
    const disposing = runtime.dispose().then(() => {
      disposeSettled = true
    })
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    assert.equal(h6Signal?.aborted, true)
    assert.equal(disposeSettled, false)
    assert.ok(settleDecision)
    settleDecision({
      answers: {
        presence: {
          type: 'ranked-choice',
          ranking: ['absent'],
        },
      },
      metadata,
    })
    const outcome = await runOutcome
    assert.ok('error' in outcome)
    if ('error' in outcome)
      assert.ok(outcome.error instanceof ClassifierError && outcome.error.code === 'DISPOSED')
    await disposing
    assert.equal(disposeSettled, true)
  } finally {
    if (settleDecision) {
      settleDecision({
        answers: {
          presence: {
            type: 'ranked-choice',
            ranking: ['absent'],
          },
        },
        metadata,
      })
    }
    await runtime.dispose()
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

await test('full runtime admits one active and two waiting runs, then rejects overflow', async () => {
  const { createH8aFullRuntime } = await import('./factory.js')
  const artifactRoot = await mkdtemp(join(tmpdir(), 'h8af-queue-'))
  const runtime = createH8aFullRuntime({
    pythonExecutable,
    assetRoot: join(tmpdir(), 'h8af-assets-unused'),
    artifactRoot,
    workerScriptPath: fakeWorkerScriptPath(),
  })
  const png = await sharp({
    create: { width: 48, height: 32, channels: 3, background: { r: 20, g: 30, b: 40 } },
  })
    .png()
    .toBuffer()
  const metadata = {
    model: 'fixture-model',
    provider: 'fixture-provider',
    requestId: 'fixture-request',
    durationMs: 1,
    costUsd: 0,
    attempts: 1,
  }
  const decision = {
    async decide(): Promise<DecisionResult> {
      return {
        answers: {
          presence: {
            type: 'ranked-choice',
            ranking: ['absent'],
          },
        },
        metadata,
      }
    },
  }
  const imageState = async (image: RasterImage) => [
    {
      type: 'image_url' as const,
      image_url: {
        url: `data:image/png;base64,${Buffer.from(image.bytes).toString('base64')}`,
        detail: 'high' as const,
      },
    },
  ]
  const originalMode = process.env.H8A_FAKE_WORKER_MODE
  const originalSleep = process.env.H8A_FAKE_SLEEP_SECONDS
  process.env.H8A_FAKE_WORKER_MODE = 'sleep'
  process.env.H8A_FAKE_SLEEP_SECONDS = '0.75'
  const controllers = [new AbortController(), new AbortController(), new AbortController()]
  const makeInput = (index: number) => ({
    encodedImage: new Uint8Array(png),
    authoredTarget: `fixture target ${index}`,
    signal: controllers[index]?.signal ?? new AbortController().signal,
    decision,
    imageState,
  })
  let active: Promise<unknown> | undefined
  let firstWaiting: Promise<unknown> | undefined
  let secondWaiting: Promise<unknown> | undefined
  try {
    const launchMarker = join(artifactRoot, 'h8a-full-tasks', 'fake-worker-launches.log')
    active = runtime.run(makeInput(0))
    const activeFailure = assert.rejects(
      active,
      (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
    )
    await waitForFakeWorkerLaunchCount(launchMarker, 1, 5000)
    firstWaiting = runtime.run(makeInput(1))
    secondWaiting = runtime.run(makeInput(2))
    const firstFailure = assert.rejects(
      firstWaiting,
      (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
    )
    const secondFailure = assert.rejects(
      secondWaiting,
      (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
    )
    await assert.rejects(
      runtime.run(makeInput(3)),
      (error: unknown) => error instanceof ClassifierError && error.code === 'CAPACITY',
    )
    assert.equal(await readFakeWorkerLaunchCount(launchMarker), 1)
    controllers.forEach((controller) => controller.abort(new Error('fixture cancellation')))
    await Promise.all([activeFailure, firstFailure, secondFailure])
  } finally {
    controllers.forEach((controller) => controller.abort(new Error('fixture cleanup')))
    await runtime.dispose()
    if (originalMode === undefined) delete process.env.H8A_FAKE_WORKER_MODE
    else process.env.H8A_FAKE_WORKER_MODE = originalMode
    if (originalSleep === undefined) delete process.env.H8A_FAKE_SLEEP_SECONDS
    else process.env.H8A_FAKE_SLEEP_SECONDS = originalSleep
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

await test('bounded child never signals a process group without a registered positive pid', async () => {
  const taskDir = await mkdtemp(join(tmpdir(), 'h8af-pid-guard-'))
  const kills: Array<{ pgid: number; signal: NodeJS.Signals }> = []
  try {
    const controller = new AbortController()
    controller.abort()
    const result = await runBoundedNativeChild({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      env: buildNativeChildEnv(taskDir),
      deadlineAt: performance.now() + 5000,
      signal: controller.signal,
      taskTempDir: taskDir,
      killProcessGroup: (pgid, signal) => {
        kills.push({ pgid, signal })
      },
    })
    assert.equal(result.status, 'cancelled')
    assert.equal(kills.length, 0)
  } finally {
    await rm(taskDir, { recursive: true, force: true })
  }
})

await test('bounded child enforces stdout cap for fixture flood worker', async () => {
  const taskDir = await mkdtemp(join(tmpdir(), 'h8af-flood-'))
  try {
    const child = await runBoundedNativeChild({
      command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(2_000_000))"],
      env: buildNativeChildEnv(taskDir),
      deadlineAt: performance.now() + 5000,
      signal: new AbortController().signal,
      taskTempDir: taskDir,
      stdoutLimit: 1024,
    })
    assert.equal(child.status, 'resource_limit')
  } finally {
    await rm(taskDir, { recursive: true, force: true })
  }
})

await test('lifecycle bounded child abort-before-spawn and invalid spawn never kill spy', async () => {
  const taskDir = await mkdtemp(join(tmpdir(), 'h8af-lifecycle-kill-guard-'))
  const kills: Array<{ pgid: number; signal: NodeJS.Signals }> = []
  const killSpy = (pgid: number, signal: NodeJS.Signals) => {
    assert.ok(Number.isInteger(pgid) && pgid > 0)
    kills.push({ pgid, signal })
  }
  try {
    const aborted = new AbortController()
    aborted.abort()
    const cancelled = await runBoundedNativeChild({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      env: buildNativeChildEnv(taskDir),
      deadlineAt: performance.now() + 5000,
      signal: aborted.signal,
      taskTempDir: taskDir,
      killProcessGroup: killSpy,
    })
    assert.equal(cancelled.status, 'cancelled')
    const invalid = await runBoundedNativeChild({
      command: '/nonexistent/h8af-invalid-native-command',
      args: [],
      env: buildNativeChildEnv(taskDir),
      deadlineAt: performance.now() + 5000,
      signal: new AbortController().signal,
      taskTempDir: taskDir,
      killProcessGroup: killSpy,
    })
    assert.equal(invalid.status, 'error')
    assert.equal(kills.length, 0)
  } finally {
    await rm(taskDir, { recursive: true, force: true })
  }
})

await test('lifecycle bounded child registers exit before fast leader close', async () => {
  const taskDir = await mkdtemp(join(tmpdir(), 'h8af-lifecycle-fast-exit-'))
  try {
    const result = await runBoundedNativeChild({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: buildNativeChildEnv(taskDir),
      deadlineAt: performance.now() + 5000,
      signal: new AbortController().signal,
      taskTempDir: taskDir,
    })
    assert.equal(result.status, 'complete')
    assert.equal(result.exitCode, 0)
  } finally {
    await rm(taskDir, { recursive: true, force: true })
  }
})

await test('lifecycle bounded child coalesces abort timeout and overflow termination', async () => {
  const taskDir = await mkdtemp(join(tmpdir(), 'h8af-lifecycle-coalesce-'))
  const kills: Array<{ pgid: number; signal: NodeJS.Signals }> = []
  let ownedPgid: number | undefined
  try {
    const controller = new AbortController()
    const run = runBoundedNativeChild({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},999999)'],
      env: buildNativeChildEnv(taskDir),
      deadlineAt: performance.now() + 120,
      signal: controller.signal,
      taskTempDir: taskDir,
      stdoutLimit: 4096,
      killProcessGroup: (pgid, signal) => {
        assert.ok(pgid > 0)
        ownedPgid = pgid
        kills.push({ pgid, signal })
        process.kill(-pgid, signal)
      },
    })
    controller.abort()
    controller.abort()
    const result = await run
    assert.ok(result.status === 'timeout' || result.status === 'cancelled')
    assert.equal(kills.filter((entry) => entry.signal === 'SIGTERM').length, 1)
  } finally {
    if (ownedPgid !== undefined && ownedPgid > 0) {
      await killOwnedProcessGroup(ownedPgid, 'SIGKILL')
    }
    await rm(taskDir, { recursive: true, force: true })
  }
})

await test('lifecycle bounded child SIGKILL settles stubborn descendant pipe holder', async () => {
  const taskDir = await mkdtemp(join(tmpdir(), 'h8af-lifecycle-stubborn-'))
  let watchedPgid: number | undefined
  const kills: NodeJS.Signals[] = []
  const leaderMarker = join(taskDir, 'leader-exited.marker')
  const leaderScript = join(taskDir, 'inherited-pipe-leader.mjs')
  try {
    await writeFile(
      leaderScript,
      `import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
const leaderMarker = process.argv[2]
const descendant = spawn(
  process.execPath,
  [
    '-e',
    "process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {}); require('node:fs').writeSync(3, Buffer.from('R')); setInterval(() => {}, 1 << 30)",
  ],
  { stdio: ['ignore', process.stdout, process.stderr, 'pipe'], detached: false },
)
const readyFd = descendant.stdio[3]
if (!readyFd) process.exit(1)
const [readyChunk] = await once(readyFd, 'data')
if (!readyChunk || readyChunk[0] !== 0x52) process.exit(1)
writeFileSync(leaderMarker, 'leader-exited')
process.exit(0)
`,
      'utf8',
    )
    let leaderExitedBeforeSigkill = false
    const result = await runBoundedNativeChild({
      command: process.execPath,
      args: [leaderScript, leaderMarker],
      env: buildNativeChildEnv(taskDir),
      deadlineAt: performance.now() + 20_000,
      signal: new AbortController().signal,
      taskTempDir: taskDir,
      killProcessGroup: (pgid, signal) => {
        watchedPgid = pgid
        kills.push(signal)
        if (signal === 'SIGKILL') {
          try {
            accessSync(leaderMarker)
            leaderExitedBeforeSigkill = true
          } catch {
            leaderExitedBeforeSigkill = false
          }
        }
        process.kill(-pgid, signal)
      },
    })
    const termIndex = kills.indexOf('SIGTERM')
    const killIndex = kills.indexOf('SIGKILL')
    assert.ok(termIndex >= 0 && killIndex > termIndex)
    assert.equal(result.status, 'complete')
    assert.ok(leaderExitedBeforeSigkill)
    await access(leaderMarker)
    assert.ok(watchedPgid !== undefined && watchedPgid > 0)
    await assertProcessGroupClosed(watchedPgid)
  } finally {
    if (watchedPgid !== undefined && watchedPgid > 0) {
      await killOwnedProcessGroup(watchedPgid, 'SIGKILL')
    }
    await rm(taskDir, { recursive: true, force: true })
  }
})

await test('lifecycle bounded child late exit waits for physical closure', async () => {
  const taskDir = await mkdtemp(join(tmpdir(), 'h8af-lifecycle-kill-denied-'))
  let ownedPgid: number | undefined
  const leaderMarker = join(taskDir, 'leader-exited.marker')
  const leaderScript = join(taskDir, 'kill-denied-leader.mjs')
  let runPromise: ReturnType<typeof runBoundedNativeChild> | undefined
  try {
    await writeFile(
      leaderScript,
      `import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
const leaderMarker = process.argv[2]
const descendant = spawn(
  process.execPath,
  [
    '-e',
    "process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {}); require('node:fs').writeSync(3, Buffer.from('R')); setInterval(() => {}, 1 << 30)",
  ],
  { stdio: ['ignore', process.stdout, process.stderr, 'pipe'], detached: false },
)
const readyFd = descendant.stdio[3]
if (!readyFd) process.exit(1)
const [readyChunk] = await once(readyFd, 'data')
if (!readyChunk || readyChunk[0] !== 0x52) process.exit(1)
writeFileSync(leaderMarker, 'leader-exited')
process.exit(0)
`,
      'utf8',
    )
    runPromise = runBoundedNativeChild({
      command: process.execPath,
      args: [leaderScript, leaderMarker],
      env: buildNativeChildEnv(taskDir),
      deadlineAt: performance.now() + 20_000,
      signal: new AbortController().signal,
      taskTempDir: taskDir,
      killProcessGroup: (pgid, _signal) => {
        ownedPgid = pgid
        throw new Error('injected kill denial')
      },
    })
    let runSettled = false
    void runPromise.then(
      () => {
        runSettled = true
      },
      () => {
        runSettled = true
      },
    )
    const pendingDeadline = performance.now() + 5000
    while (performance.now() < pendingDeadline) {
      if (ownedPgid !== undefined && ownedPgid > 0) {
        let leaderReady = false
        try {
          await access(leaderMarker)
          leaderReady = true
        } catch {
          leaderReady = false
        }
        if (leaderReady && (await processGroupAlive(ownedPgid))) break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(ownedPgid !== undefined && ownedPgid > 0)
    await access(leaderMarker)
    assert.equal(await processGroupAlive(ownedPgid), true)
    assert.equal(runSettled, false)
  } finally {
    if (ownedPgid !== undefined && ownedPgid > 0) {
      await killOwnedProcessGroup(ownedPgid, 'SIGKILL')
    }
    await rm(taskDir, { recursive: true, force: true })
  }
  assert.ok(runPromise)
  const result = await runPromise
  assert.equal(result.status, 'error')
  assert.match(result.errorMessage ?? '', /injected kill denial/)
  assert.ok(ownedPgid !== undefined && ownedPgid > 0)
  await assertProcessGroupClosed(ownedPgid)
})

await test('lifecycle bounded child stdout and stderr overflow retain capped bytes', async () => {
  const taskDir = await mkdtemp(join(tmpdir(), 'h8af-lifecycle-overflow-'))
  try {
    const stdoutCap = 2048
    const stdout = await runBoundedNativeChild({
      command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(100_000))"],
      env: buildNativeChildEnv(taskDir),
      deadlineAt: performance.now() + 5000,
      signal: new AbortController().signal,
      taskTempDir: taskDir,
      stdoutLimit: stdoutCap,
    })
    assert.equal(stdout.status, 'resource_limit')
    assert.ok(stdout.stdoutBytesTotal > stdoutCap)
    assert.ok(stdout.stdout.byteLength <= stdoutCap)

    const stderrCap = 1024
    const requestPath = join(taskDir, 'request.json')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(taskDir, { recursive: true })
    await writeFile(
      requestPath,
      JSON.stringify({
        schema: H8A_FULL_NATIVE_REQUEST_SCHEMA,
        request_id: randomUUID(),
        recipe_id: H8A_FULL_RECIPE_ID,
        authored_target: 'fixture',
        task_dir: taskDir,
        assets_dir: join(tmpdir(), 'h8af-assets-unused'),
        source_path: join(taskDir, 'missing.png'),
        source_sha256: '0'.repeat(64),
        width: 8,
        height: 8,
      }),
      'utf8',
    )
    const env = buildNativeChildEnv(taskDir)
    env.H8A_FAKE_WORKER_MODE = 'stderr_flood'
    env.H8A_FAKE_STDERR_BYTES = '200000'
    const stderr = await runBoundedNativeChild({
      command: process.execPath,
      args: [fakeWorkerScriptPath(), '--generate', requestPath],
      env,
      deadlineAt: performance.now() + 5000,
      signal: new AbortController().signal,
      taskTempDir: taskDir,
      stderrLimit: stderrCap,
    })
    assert.equal(stderr.status, 'resource_limit')
    assert.ok(stderr.stderrBytesTotal > stderrCap)
  } finally {
    await rm(taskDir, { recursive: true, force: true })
  }
})

await test('lifecycle bounded child success reports RSS sampling availability', async () => {
  const taskDir = await mkdtemp(join(tmpdir(), 'h8af-lifecycle-rss-'))
  try {
    const result = await runBoundedNativeChild({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 250)'],
      env: buildNativeChildEnv(taskDir),
      deadlineAt: performance.now() + 5000,
      signal: new AbortController().signal,
      taskTempDir: taskDir,
    })
    assert.equal(result.status, 'complete')
    assert.equal(result.rssSamplingAvailable, true)
    assert.equal(result.rssSampleIntervalMs, 100)
  } finally {
    await rm(taskDir, { recursive: true, force: true })
  }
})

await test('native port rejects fourth queued request with capacity', async () => {
  await withFakePort(
    async (port, _artifactRoot, source) => {
      const signal = new AbortController().signal
      const input = nativeInput(source, signal, { deadlineAt: performance.now() + 30_000 })
      const first = port.generate(input)
      const second = port.generate(input)
      const third = port.generate(input)
      await assert.rejects(port.generate(input), (error: unknown) => {
        return error instanceof ClassifierError && error.code === 'CAPACITY'
      })
      await Promise.all([first, second, third])
    },
    { env: { H8A_FAKE_WORKER_MODE: 'sleep', H8A_FAKE_SLEEP_SECONDS: '0.5' } },
  )
})

await test('native port aborts active job without rejecting shared decision port', async () => {
  await withFakePort(
    async (port, _artifactRoot, source) => {
      const controller = new AbortController()
      const run = port.generate(
        nativeInput(source, controller.signal, { deadlineAt: performance.now() + 30_000 }),
      )
      await new Promise((resolve) => setTimeout(resolve, 150))
      controller.abort()
      await assert.rejects(
        run,
        (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
      )
    },
    { env: { H8A_FAKE_WORKER_MODE: 'sleep', H8A_FAKE_SLEEP_SECONDS: '10' } },
  )
})

await test('native port dispose aborts active work and joins physical jobs', async () => {
  await withFakePort(
    async (port, _artifactRoot, source) => {
      const signal = new AbortController().signal
      void port
        .generate(nativeInput(source, signal, { deadlineAt: performance.now() + 30_000 }))
        .catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 150))
      await port.dispose()
    },
    { env: { H8A_FAKE_WORKER_MODE: 'sleep', H8A_FAKE_SLEEP_SECONDS: '10' } },
  )
})

await test('native port resolves only after task directory cleanup', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'h8af-artifacts-'))
  const source = await writeFixtureSource()
  let cleanupEntered = false
  let resolved = false
  const port = new H8aFullNativePort({
    pythonExecutable,
    assetRoot: join(tmpdir(), 'h8af-assets-unused'),
    artifactRoot,
    workerScriptPath: fakeWorkerScriptPath(),
    cleanupTaskDirectory: async (taskDir) => {
      cleanupEntered = true
      assert.equal(resolved, false)
      await new Promise((resolve) => setTimeout(resolve, 40))
      await rm(taskDir, { recursive: true, force: true })
    },
  })
  try {
    const signal = new AbortController().signal
    const promise = port.generate(nativeInput(source, signal)).then((value) => {
      resolved = true
      assert.equal(cleanupEntered, true)
      return value
    })
    await promise
    assert.equal(resolved, true)
  } finally {
    await port.dispose()
    await rm(artifactRoot, { recursive: true, force: true })
    await rm(source.sourcePath, { force: true })
  }
})

await test('native port snapshots scalar fields before queue wait', async () => {
  type NativeGenerateOutcome =
    | { readonly kind: 'fulfilled'; readonly value: H8aNativeGenerationOutput }
    | { readonly kind: 'rejected'; readonly reason: unknown }

  await withFakePort(
    async (port, artifactRoot, source) => {
      const signal = new AbortController().signal
      const input = nativeInput(source, signal, { authoredTarget: 'original target phrase' })
      const outcomePromise: Promise<NativeGenerateOutcome> = port.generate(input).then(
        (value): NativeGenerateOutcome => ({ kind: 'fulfilled', value }),
        (reason): NativeGenerateOutcome => ({ kind: 'rejected', reason }),
      )
      input.authoredTarget = 'mutated target phrase'
      input.width = 8
      try {
        await new Promise((resolve) => setTimeout(resolve, 120))
        const taskRoot = join(artifactRoot, 'h8a-full-tasks')
        const { readdir, readFile: readTaskFile } = await import('node:fs/promises')
        const jobDirs = (await readdir(taskRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
        assert.equal(jobDirs.length, 1)
        const request = JSON.parse(
          await readTaskFile(join(taskRoot, jobDirs[0]!, 'request.json'), 'utf8'),
        ) as {
          authored_target: string
          width: number
        }
        assert.equal(request.authored_target, 'original target phrase')
        assert.equal(request.width, 64)
        const outcome = await outcomePromise
        if (outcome.kind === 'rejected') {
          throw outcome.reason
        }
      } finally {
        await port.dispose()
        await outcomePromise
      }
    },
    { env: { H8A_FAKE_WORKER_MODE: 'sleep', H8A_FAKE_SLEEP_SECONDS: '1' } },
  )
})

await test('native port propagates typed cleanup failure after successful generation', async () => {
  await withFakePort(
    async (port, _artifactRoot, source) => {
      const signal = new AbortController().signal
      await assert.rejects(port.generate(nativeInput(source, signal)), (error: unknown) => {
        return error instanceof ClassifierError && error.code === 'PROVIDER'
      })
    },
    {
      cleanupTaskDirectory: async () => {
        throw new Error('injected cleanup failure')
      },
    },
  )
})

await test('native port expired deadline skips fake worker launch marker', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'h8af-artifacts-'))
  const source = await writeFixtureSource()
  const launchMarker = join(artifactRoot, 'h8a-full-tasks', 'fake-worker-launches.log')
  const port = new H8aFullNativePort({
    pythonExecutable,
    assetRoot: join(tmpdir(), 'h8af-assets-unused'),
    artifactRoot,
    workerScriptPath: fakeWorkerScriptPath(),
  })
  try {
    const signal = new AbortController().signal
    await assert.rejects(
      port.generate(nativeInput(source, signal, { deadlineAt: performance.now() - 1 })),
      (error: unknown) => error instanceof ClassifierError && error.code === 'TIMEOUT',
    )
    assert.equal(await readFakeWorkerLaunchCount(launchMarker), 0)
  } finally {
    await port.dispose()
    await rm(artifactRoot, { recursive: true, force: true })
    await rm(source.sourcePath, { force: true })
  }
})

await test('native port reports timeout when cleanup crosses deadline', async () => {
  await withFakePort(
    async (port, _artifactRoot, source) => {
      const signal = new AbortController().signal
      await assert.rejects(
        port.generate(nativeInput(source, signal, { deadlineAt: performance.now() + 80 })),
        (error: unknown) => error instanceof ClassifierError && error.code === 'TIMEOUT',
      )
    },
    {
      cleanupTaskDirectory: async (taskDir) => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        await rm(taskDir, { recursive: true, force: true })
      },
    },
  )
})

await test('native port rejects oversized native response JSON', async () => {
  await withFakePort(
    async (port, _artifactRoot, source) => {
      const signal = new AbortController().signal
      await assert.rejects(port.generate(nativeInput(source, signal)), (error: unknown) => {
        return error instanceof ClassifierError && error.code === 'PROVIDER'
      })
    },
    { env: { H8A_FAKE_WORKER_MODE: 'oversized_json', H8A_FAKE_JSON_BYTES: '5000000' } },
  )
})

await test('native port rejects mismatched response identity', async () => {
  await withFakePort(
    async (port, _artifactRoot, source) => {
      const signal = new AbortController().signal
      await assert.rejects(port.generate(nativeInput(source, signal)), (error: unknown) => {
        return error instanceof ClassifierError && error.code === 'PROVIDER'
      })
    },
    { env: { H8A_FAKE_WORKER_MODE: 'bad_identity' } },
  )
})

await test('native port rejects mask hash size and symlink packed paths', async () => {
  for (const mode of ['mask_hash_mismatch', 'mask_size_mismatch', 'mask_symlink'] as const) {
    await withFakePort(
      async (port, _artifactRoot, source) => {
        const signal = new AbortController().signal
        await assert.rejects(port.generate(nativeInput(source, signal)), (error: unknown) => {
          return error instanceof ClassifierError && error.code === 'PROVIDER'
        })
      },
      { env: { H8A_FAKE_WORKER_MODE: mode } },
    )
  }
})

await test('native port rejects wrong aggregate packed total', async () => {
  await withFakePort(
    async (port, _artifactRoot, source) => {
      const signal = new AbortController().signal
      await assert.rejects(port.generate(nativeInput(source, signal)), (error: unknown) => {
        return error instanceof ClassifierError && error.code === 'PROVIDER'
      })
    },
    { env: { H8A_FAKE_WORKER_MODE: 'wrong_packed_total' } },
  )
})

await test('native port derives empty masks from packed bits not metadata alone', async () => {
  await withFakePort(async (port, _artifactRoot, source) => {
    const signal = new AbortController().signal
    const result = await port.generate(nativeInput(source, signal))
    assert.deepEqual(
      result.families.D.map((item) => item.id),
      ['D00', 'D01'],
    )
  })
})

async function readFakeWorkerLaunchCount(markerPath: string): Promise<number> {
  try {
    const text = await readFile(markerPath, 'utf8')
    return text.split('\n').filter((line) => line.trim() === 'launch').length
  } catch {
    return 0
  }
}

async function waitForFakeWorkerLaunchCount(
  markerPath: string,
  minCount: number,
  waitMs: number,
): Promise<void> {
  const deadline = performance.now() + waitMs
  while (performance.now() < deadline) {
    if ((await readFakeWorkerLaunchCount(markerPath)) >= minCount) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`fake worker launch marker did not reach ${minCount}`)
}

await test('native port rejects expired deadline while first worker active without second launch', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'h8af-artifacts-'))
  const source = await writeFixtureSource()
  const launchMarker = join(artifactRoot, 'h8a-full-tasks', 'fake-worker-launches.log')
  const port = new H8aFullNativePort({
    pythonExecutable,
    assetRoot: join(tmpdir(), 'h8af-assets-unused'),
    artifactRoot,
    workerScriptPath: fakeWorkerScriptPath(),
  })
  const savedMode = process.env.H8A_FAKE_WORKER_MODE
  const savedSleep = process.env.H8A_FAKE_SLEEP_SECONDS
  process.env.H8A_FAKE_WORKER_MODE = 'sleep'
  process.env.H8A_FAKE_SLEEP_SECONDS = '0.75'
  let firstRun: ReturnType<H8aFullNativePort['generate']> | undefined
  let firstSettled = false
  try {
    const signal = new AbortController().signal
    firstRun = port.generate(
      nativeInput(source, signal, { deadlineAt: performance.now() + 30_000 }),
    )
    void firstRun.then(
      () => {
        firstSettled = true
      },
      () => {
        firstSettled = true
      },
    )
    await waitForFakeWorkerLaunchCount(launchMarker, 1, 5000)
    await assert.rejects(
      port.generate(nativeInput(source, signal, { deadlineAt: performance.now() + 150 })),
      (error: unknown) => error instanceof ClassifierError && error.code === 'TIMEOUT',
    )
    assert.equal(firstSettled, false)
    await firstRun
    assert.equal(await readFakeWorkerLaunchCount(launchMarker), 1)
  } finally {
    if (savedMode === undefined) delete process.env.H8A_FAKE_WORKER_MODE
    else process.env.H8A_FAKE_WORKER_MODE = savedMode
    if (savedSleep === undefined) delete process.env.H8A_FAKE_SLEEP_SECONDS
    else process.env.H8A_FAKE_SLEEP_SECONDS = savedSleep
    await port.dispose()
    if (firstRun) await firstRun.catch(() => {})
    await rm(artifactRoot, { recursive: true, force: true })
    await rm(source.sourcePath, { force: true })
  }
})

await test('native port keeps enqueue AbortSignal after input signal mutation', async () => {
  await withFakePort(
    async (port, artifactRoot, source) => {
      const launchMarker = join(artifactRoot, 'h8a-full-tasks', 'fake-worker-launches.log')
      const original = new AbortController()
      const replacement = new AbortController()
      const input = nativeInput(source, original.signal, { deadlineAt: performance.now() + 30_000 })
      const run = port.generate(input)
      await waitForFakeWorkerLaunchCount(launchMarker, 1, 5000)
      input.signal = replacement.signal
      const reason = new Error('original-signal-reason')
      original.abort(reason)
      await assert.rejects(run, (error: unknown) => {
        if (!(error instanceof ClassifierError) || error.code !== 'ABORTED') return false
        return error.details.cause === reason
      })
    },
    { env: { H8A_FAKE_WORKER_MODE: 'sleep', H8A_FAKE_SLEEP_SECONDS: '2' } },
  )
})

await test('native port rejects malformed error response identity as provider failure', async () => {
  await withFakePort(
    async (port, _artifactRoot, source) => {
      const signal = new AbortController().signal
      await assert.rejects(port.generate(nativeInput(source, signal)), (error: unknown) => {
        return error instanceof ClassifierError && error.code === 'PROVIDER'
      })
    },
    { env: { H8A_FAKE_WORKER_MODE: 'error_bad_identity' } },
  )
})

await test('native port rejects invalid enqueue input before fake worker launch marker', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'h8af-artifacts-'))
  const source = await writeFixtureSource()
  const launchMarker = join(artifactRoot, 'h8a-full-tasks', 'fake-worker-launches.log')
  const port = new H8aFullNativePort({
    pythonExecutable,
    assetRoot: join(tmpdir(), 'h8af-assets-unused'),
    artifactRoot,
    workerScriptPath: fakeWorkerScriptPath(),
  })
  try {
    const signal = new AbortController().signal
    await assert.rejects(
      port.generate(nativeInput(source, signal, { deadlineAt: Number.NaN })),
      (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
    )
    assert.equal(await readFakeWorkerLaunchCount(launchMarker), 0)
  } finally {
    await port.dispose()
    await rm(artifactRoot, { recursive: true, force: true })
    await rm(source.sourcePath, { force: true })
  }
})

await test('python unit suite entrypoint exits zero', () => {
  const result = spawnSync(
    pythonExecutable,
    [join(dirname(fileURLToPath(import.meta.url)), 'test_native.py')],
    {
      encoding: 'utf8',
    },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
