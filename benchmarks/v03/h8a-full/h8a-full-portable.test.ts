import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { test } from 'node:test'
import type {
  DecisionRequest,
  DecisionResult,
  DecisionState,
  RasterPort,
} from '../../../src/entities/contracts.js'
import { ClassifierError } from '../../../src/entities/errors.js'
import { buildDinoPrompt } from './contracts.js'
import {
  copyEncodedImageBytes,
  decodeOrientedSource,
  orientedDimensionsFromHeader,
} from './image-source.js'
import {
  clipPackedMaskToVisibleAlpha,
  foregroundBounds,
  maskHasForeground,
  validatePackedMaskCopy,
} from './mask-geometry.js'
import { buildNativeChildEnv } from './native-bounded-child.js'
import { removeOwnedEmptyDirectory, smokeErrorReceipt } from './native-smoke.js'
import { createH8aFullRuntime } from './factory.js'
import {
  captureH8aFullRun,
  runH8aFullPipelineSnapshot,
  type H8aFullRunSnapshot,
} from './pipeline.js'
import type { H8aNativeGenerationInput, H8aNativeGenerationOutput } from './native-port.js'
import { H6_QUERY_POLICY_INSTRUCTIONS } from '../h6-query-policy.js'
import type { H6QueryPolicyId } from '../h6-query-policy.js'
import { H8A_FULL_RECIPE_ID } from './constants.js'

function mask(
  width: number,
  height: number,
  rect: { left: number; top: number; width: number; height: number },
) {
  const pixels = width * height
  const data = new Uint8Array(Math.ceil(pixels / 8))
  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      const index = y * width + x
      data[index >> 3] = (data[index >> 3] ?? 0) | (1 << (index & 7))
    }
  }
  return { data, width, height, format: 'binary-lsb0' as const }
}

await test('smoke cleanup removes only empty owned directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8af-smoke-cleanup-'))
  const empty = join(root, 'empty')
  const occupied = join(root, 'occupied')
  try {
    await mkdir(empty)
    await removeOwnedEmptyDirectory(empty)
    await assert.rejects(access(empty))
    await mkdir(occupied)
    const sentinel = join(occupied, 'keep.txt')
    await writeFile(sentinel, 'retain')
    await assert.rejects(removeOwnedEmptyDirectory(occupied))
    assert.equal(await readFile(sentinel, 'utf8'), 'retain')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('smoke error receipt bounds causes and sanitizes secrets, URLs, and paths', () => {
  const cause = new Error(
    `access token=fixture-only-secret failed at /root/private/models; see https://example.invalid/?key=secret`,
    { cause: new Error('z'.repeat(2000)) },
  )
  const error = new ClassifierError(
    'PROVIDER',
    `native error sk-or-v1-fixture-only-secret ${'x'.repeat(2000)}`,
    { cause },
  )
  const receipt = smokeErrorReceipt(error)
  assert.ok(receipt)
  const encoded = JSON.stringify(receipt)
  assert.ok(encoded.length < 1800)
  assert.doesNotMatch(encoded, /fixture-only-secret|example\.invalid|\/root\/private/u)
  assert.match(receipt.message, /\[redacted\]/u)
  assert.ok(receipt.cause)
  assert.ok(receipt.cause.message.length <= 512)
})

await test('buildDinoPrompt keeps authored target verbatim with generic prefix', () => {
  const target = 'the visible body sprite of unit type Explorer in the main Freeciv map canvas'
  assert.equal(buildDinoPrompt(target), `a ${target}`)
  assert.equal(buildDinoPrompt('Car'), 'a Car')
})

await test('module import has no background side effects', async () => {
  const before = process.memoryUsage().heapUsed
  await import('./factory.js')
  assert.ok(process.memoryUsage().heapUsed - before < 50 * 1024 * 1024)
})

await test('header validation runs before RGBA allocation', async () => {
  const png = await sharp({
    create: { width: 48, height: 32, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer()
  const owned = copyEncodedImageBytes(new Uint8Array(png))
  const header = await orientedDimensionsFromHeader(owned)
  assert.deepEqual(header, { width: 48, height: 32, orientation: 1 })
  const decoded = await decodeOrientedSource(owned)
  assert.equal(decoded.width, 48)
  decoded.dispose()
})

await test('EXIF orientation swaps oriented dimensions before decode', async () => {
  const portrait = await sharp({
    create: { width: 120, height: 80, channels: 3, background: { r: 5, g: 6, b: 7 } },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer()
  const dims = await orientedDimensionsFromHeader(new Uint8Array(portrait))
  assert.deepEqual(dims, { width: 80, height: 120, orientation: 6 })
})

await test('packed mask validation rejects padding bits and copies bytes', () => {
  const bad = mask(3, 1, { left: 0, top: 0, width: 3, height: 1 })
  bad.data[0] = 0x0f
  assert.throws(() => validatePackedMaskCopy(bad, 3, 1))
  const valid = validatePackedMaskCopy(mask(5, 7, { left: 1, top: 2, width: 2, height: 3 }), 5, 7)
  assert.equal(valid.data.byteLength, Math.ceil((5 * 7) / 8))
})

await test('empty mask is not foreground and disconnected components keep bounds', () => {
  const empty = mask(10, 10, { left: 0, top: 0, width: 0, height: 0 })
  assert.equal(maskHasForeground(empty), false)
  const disconnected = mask(20, 20, { left: 2, top: 2, width: 2, height: 2 })
  const secondIndex = 12 * 20 + 12
  disconnected.data[secondIndex >> 3] =
    (disconnected.data[secondIndex >> 3] ?? 0) | (1 << (secondIndex & 7))
  const bounds = foregroundBounds(disconnected)
  assert.ok(bounds)
  assert.equal(bounds?.left, 2)
  assert.equal(bounds?.width, 11)
})

await test('source alpha removes invisible packed-mask pixels without joining components', () => {
  const source = new Uint8Array(5 * 3 * 4)
  for (let index = 0; index < 15; index++) source[index * 4 + 3] = 255
  source[(0 * 5 + 0) * 4 + 3] = 0
  const original = mask(5, 3, { left: 0, top: 0, width: 1, height: 1 })
  const secondIndex = 2 * 5 + 4
  original.data[secondIndex >> 3] =
    (original.data[secondIndex >> 3] ?? 0) | (1 << (secondIndex & 7))
  const clipped = clipPackedMaskToVisibleAlpha(original, {
    data: source,
    width: 5,
    height: 3,
    format: 'rgba8',
  })
  assert.deepEqual(foregroundBounds(clipped), { left: 4, top: 2, width: 1, height: 1 })
  const cleared = clipPackedMaskToVisibleAlpha(original, {
    data: new Uint8Array(source.length),
    width: 5,
    height: 3,
    format: 'rgba8',
  })
  assert.equal(maskHasForeground(cleared), false)
})

await test('native child env excludes provider credential keys', () => {
  const prior = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = 'test-only-not-a-secret'
  try {
    const env = buildNativeChildEnv(join(tmpdir(), 'h8af-task'))
    assert.equal(env.OPENROUTER_API_KEY, undefined)
    assert.equal(env.HF_HUB_OFFLINE, '1')
  } finally {
    if (prior === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = prior
  }
})

await test('unknown H8a query policy fails before pipeline ports or filesystem work', async () => {
  let portCalls = 0
  const taskDirectory = join(tmpdir(), `h8af-invalid-policy-${Date.now()}`)
  const snapshot: H8aFullRunSnapshot = {
    encodedImage: new Uint8Array([1]),
    authoredTarget: 'fixture target',
    exclusions: [],
    includeCutout: false,
    deadlineAt: performance.now() + 10_000,
    taskDirectory,
  }
  await assert.rejects(
    Reflect.apply(runH8aFullPipelineSnapshot, undefined, [
      snapshot,
      {
        queryPolicyId: 'unrecognized-policy',
        decision: {
          async decide(): Promise<DecisionResult> {
            portCalls++
            return {
              answers: {},
              metadata: {
                model: 'm',
                provider: 'p',
                requestId: 'r',
                durationMs: 1,
                costUsd: 0,
                attempts: 1,
              },
            }
          },
        },
        imageState: async (): Promise<DecisionState> => {
          portCalls++
          return []
        },
        native: {
          async generate(): Promise<H8aNativeGenerationOutput> {
            portCalls++
            throw new Error('native port must not run')
          },
        },
      },
      new AbortController().signal,
    ]),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
  )
  assert.equal(portCalls, 0)
  await assert.rejects(access(taskDirectory))

  assert.throws(
    () =>
      Reflect.apply(createH8aFullRuntime, undefined, [
        {
          pythonExecutable: 'python',
          assetRoot: 'assets',
          artifactRoot: 'artifacts',
          queryPolicyId: 'unrecognized-policy',
        },
      ]),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
  )
})

await test('direct pipeline snapshots policy before asynchronous native generation', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'h8af-query-policy-snapshot-'))
  const png = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 255, g: 255, b: 255 } },
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
  const requests: DecisionRequest[] = []
  let markNativeStarted!: () => void
  const nativeStarted = new Promise<void>((resolveStarted) => {
    markNativeStarted = resolveStarted
  })
  let releaseNative!: () => void
  const nativeGate = new Promise<void>((resolveNative) => {
    releaseNative = resolveNative
  })
  const dependencies: {
    queryPolicyId: H6QueryPolicyId
    decision: { decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> }
    imageState: RasterPort['imageState']
    native: { generate(input: H8aNativeGenerationInput): Promise<H8aNativeGenerationOutput> }
  } = {
    queryPolicyId: 'strict-authored-scope-v1',
    decision: {
      async decide(request) {
        requests.push(structuredClone(request))
        if (request.questions.presence)
          return {
            answers: { presence: { type: 'ranked-choice', ranking: ['present'] } },
            metadata,
          }
        const question = request.questions.selection
        assert.ok(question?.type === 'choice')
        const keys = Object.keys(question.criteria)
        const rankingSize = question.rankingSize
        const ranking =
          rankingSize === 4
            ? keys.slice(0, Math.min(4, keys.length))
            : [keys.includes('D00') ? 'D00' : (keys[0] ?? 'none')]
        return { answers: { selection: { type: 'ranked-choice', ranking } }, metadata }
      },
    },
    async imageState(image) {
      return [
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${Buffer.from(image.bytes).toString('base64')}`,
            detail: 'high',
          },
        },
      ]
    },
    native: {
      async generate(input) {
        assert.equal('queryPolicyId' in input, false)
        markNativeStarted()
        await nativeGate
        const candidateMask = mask(input.width, input.height, {
          left: 4,
          top: 4,
          width: 8,
          height: 8,
        })
        const secondMask = mask(input.width, input.height, {
          left: 18,
          top: 18,
          width: 6,
          height: 6,
        })
        return {
          recipeId: H8A_FULL_RECIPE_ID,
          families: {
            D: [{ id: 'native-d0', mask: candidateMask }],
            U: [{ id: 'native-u0', mask: secondMask }],
          },
          detectorPrompt: 'fixture prompt',
        }
      },
    },
  }
  const snapshot: H8aFullRunSnapshot = {
    encodedImage: new Uint8Array(png),
    authoredTarget: 'fixture visible instance',
    exclusions: [],
    includeCutout: false,
    deadlineAt: performance.now() + 20_000,
    taskDirectory: join(artifactRoot, 'h8a-full-runs', 'fixture'),
  }
  try {
    const pending = runH8aFullPipelineSnapshot(snapshot, dependencies, new AbortController().signal)
    await nativeStarted
    dependencies.queryPolicyId = 'legacy-v1'
    releaseNative()
    const result = await pending
    assert.equal(result.status, 'located')
    assert.equal(requests.length, 4)
    const presenceText = requests[0]?.state.find((part): part is string => typeof part === 'string')
    assert.ok(presenceText?.endsWith(H6_QUERY_POLICY_INSTRUCTIONS.presenceState))
    assert.ok(
      requests[0]?.questions.presence?.instructions.endsWith(
        H6_QUERY_POLICY_INSTRUCTIONS.presenceQuestion,
      ),
    )
    assert.ok(
      requests[1]?.questions.selection?.instructions.endsWith(
        H6_QUERY_POLICY_INSTRUCTIONS.nominationQuestion,
      ),
    )
    assert.ok(
      requests
        .at(-1)
        ?.questions.selection?.instructions.endsWith(H6_QUERY_POLICY_INSTRUCTIONS.finalQuestion),
    )
  } finally {
    releaseNative()
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

await test('binary presence port is validated and method-snapshotted at H8a admission', async () => {
  const original = async (): Promise<DecisionResult> => ({
    answers: {},
    metadata: {
      model: 'fixture-model',
      provider: 'fixture-provider',
      requestId: 'fixture-request',
      durationMs: 1,
      costUsd: 0,
      attempts: 1,
    },
  })
  const replacement = async (): Promise<DecisionResult> => {
    throw new Error('mutated port used')
  }
  const presenceDecision = { decide: original }
  let presencePortReads = 0
  const signal = new AbortController().signal
  const dependencies = {
    decision: {
      async decide(): Promise<DecisionResult> {
        return {
          answers: {},
          metadata: {
            model: 'fixture-model',
            provider: 'fixture-provider',
            requestId: 'fixture-request',
            durationMs: 1,
            costUsd: 0,
            attempts: 1,
          },
        }
      },
    },
    get presenceDecision() {
      presencePortReads++
      return presenceDecision
    },
    presencePolicyId: 'control-binary-v1' as const,
    imageState: async () => [],
    native: {
      async generate(): Promise<H8aNativeGenerationOutput> {
        throw new Error('unused')
      },
    },
    artifactRoot: tmpdir(),
  }
  const captured = captureH8aFullRun(
    {
      encodedImage: new Uint8Array([1]),
      authoredTarget: 'fixture visible target',
      signal,
    },
    dependencies,
  )
  assert.equal(presencePortReads, 1)
  presenceDecision.decide = replacement
  assert.equal(captured.dependencies.presencePolicyId, 'control-binary-v1')
  assert.ok(captured.dependencies.presenceDecision)
  assert.deepEqual(
    await captured.dependencies.presenceDecision.decide({ state: [], questions: {} }, signal),
    {
      answers: {},
      metadata: {
        model: 'fixture-model',
        provider: 'fixture-provider',
        requestId: 'fixture-request',
        durationMs: 1,
        costUsd: 0,
        attempts: 1,
      },
    },
  )
})
