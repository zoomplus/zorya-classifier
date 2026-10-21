import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import type { DecisionRequest, RasterImage } from '../src/entities/contracts.js'
import { ClassifierError } from '../src/entities/errors.js'
import { createSharpRaster } from '../src/infrastructure/raster.js'
import { createOpenRouterDecisions } from '../src/openrouter.js'
import { createH3cVerifier, H3C_VERDICTS } from '../benchmarks/v03/h3c-verifier.js'
import type { H3cVerificationInput } from '../benchmarks/v03/h3c-verifier.js'

const metadata = {
  model: 'openai/gpt-6-luna-decisions',
  provider: 'OpenAI',
  requestId: 'fixture-h3c',
  durationMs: 1,
  costUsd: 0.001,
  attempts: 1,
} as const

async function image(): Promise<RasterImage & { data: Uint8Array }> {
  const data = Buffer.alloc(32 * 24 * 4, 255)
  for (let y = 8; y < 14; y++) {
    for (let x = 12; x < 20; x++) {
      const offset = (y * 32 + x) * 4
      data[offset] = 230
      data[offset + 1] = 20
      data[offset + 2] = 40
    }
  }
  const bytes = await sharp(data, { raw: { width: 32, height: 24, channels: 4 } })
    .png()
    .toBuffer()
  return { bytes: new Uint8Array(bytes), data: new Uint8Array(data), width: 32, height: 24 }
}

function mask() {
  const data = new Uint8Array(32 * 24)
  for (let y = 8; y < 14; y++) for (let x = 12; x < 20; x++) data[y * 32 + x] = 1
  return { data, width: 32, height: 24, format: 'binary-u8' as const }
}

function result(request: DecisionRequest, choice: (typeof H3C_VERDICTS)[number]) {
  const criteria = request.questions.verification
  assert.ok(criteria?.type === 'choice')
  return {
    answers: {
      verification: {
        type: 'choice' as const,
        choice,
        probabilities: Object.fromEntries(
          H3C_VERDICTS.map((entry) => [entry, entry === choice ? 1 : 0]),
        ),
      },
    },
    metadata,
  }
}

await test('H3c uses the actual mask, exact authored identity, and stable raw-maximum ties', async () => {
  const source = await image()
  const selectedMask = mask()
  let requestSeen: DecisionRequest | undefined
  const verifier = createH3cVerifier({
    imageState: createSharpRaster().imageState,
    decision: {
      async decide(request) {
        requestSeen = request
        const criteria = request.questions.verification
        assert.ok(criteria?.type === 'choice')
        return {
          answers: {
            verification: {
              type: 'choice',
              choice: 'unknown',
              probabilities: Object.fromEntries(H3C_VERDICTS.map((key) => [key, 0.25])),
            },
          },
          metadata,
        }
      },
    },
  })
  const pending = verifier.verify({
    image: { data: source.data, width: source.width, height: source.height, format: 'rgba8' },
    mask: selectedMask,
    box: { left: 12, top: 8, width: 8, height: 6 },
    alias: 'C00',
    target: 'Authored Bowl',
    exclusions: ['not a plate'],
    signal: new AbortController().signal,
  })
  source.data.fill(0)
  selectedMask.data.fill(0)
  const checked = await pending
  assert.equal(checked.verdict, 'match-complete-pure')
  assert.equal(checked.selection.nativeChoice, 'unknown')
  assert.deepEqual(checked.selection.tied, [...H3C_VERDICTS])
  assert.deepEqual(checked.witness, { x: 12, y: 8, origin: 'selected-mask-foreground' })
  assert.ok(requestSeen)
  assert.match(
    requestSeen.questions.verification?.type === 'choice'
      ? requestSeen.questions.verification.instructions
      : '',
    /Authored Bowl/u,
  )
  assert.match(JSON.stringify(requestSeen.questions.verification), /not a plate/u)
  assert.equal(requestSeen.state.filter((part) => typeof part !== 'string').length, 4)
  assert.equal(JSON.stringify(requestSeen).includes('/root/work/'), false)
})

await test('H3c rejects a box that invents extent beyond actual foreground before any decision call', async () => {
  const source = await image()
  let calls = 0
  const verifier = createH3cVerifier({
    imageState: createSharpRaster().imageState,
    decision: {
      async decide() {
        calls++
        throw new Error('must not dispatch')
      },
    },
  })
  await assert.rejects(
    verifier.verify({
      image: { data: source.data, width: source.width, height: source.height, format: 'rgba8' },
      mask: mask(),
      box: { left: 11, top: 8, width: 9, height: 6 },
      alias: 'C00',
      target: 'Bowl',
      exclusions: [],
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
  )
  assert.equal(calls, 0)
})

await test('H3c rejects oversized dimensions and invalid byte lengths before image preparation or dispatch', async () => {
  let imageStateCalls = 0
  let decisionCalls = 0
  const verifier = createH3cVerifier({
    imageState: async () => {
      imageStateCalls++
      return []
    },
    decision: {
      async decide() {
        decisionCalls++
        throw new Error('must not dispatch')
      },
    },
  })
  const base = await image()
  const validMask = mask()
  const cases: H3cVerificationInput[] = [
    {
      image: {
        data: new Uint8Array(4),
        width: 16385,
        height: 1,
        format: 'rgba8',
      },
      mask: { data: new Uint8Array(16385), width: 16385, height: 1, format: 'binary-u8' },
      box: { left: 0, top: 0, width: 1, height: 1 },
      alias: 'C00',
      target: 'Bowl',
      exclusions: [],
      signal: new AbortController().signal,
    },
    {
      image: { data: base.data.subarray(0, 4), width: 32, height: 24, format: 'rgba8' },
      mask: validMask,
      box: { left: 12, top: 8, width: 8, height: 6 },
      alias: 'C00',
      target: 'Bowl',
      exclusions: [],
      signal: new AbortController().signal,
    },
  ]
  for (const input of cases) {
    await assert.rejects(
      verifier.verify(input),
      (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
    )
  }
  assert.equal(imageStateCalls, 0)
  assert.equal(decisionCalls, 0)
})

await test('H3c snapshots target, alias, box, and signal before asynchronous image preparation', async () => {
  const source = await image()
  const originalSignal = new AbortController().signal
  const replacementSignal = new AbortController().signal
  let seenSignal: AbortSignal | undefined
  let requestSeen: DecisionRequest | undefined
  const verifier = createH3cVerifier({
    imageState: createSharpRaster().imageState,
    decision: {
      async decide(request, signal) {
        requestSeen = request
        seenSignal = signal
        return result(request, 'match-complete-pure')
      },
    },
  })
  const input: H3cVerificationInput = {
    image: { data: source.data, width: source.width, height: source.height, format: 'rgba8' },
    mask: mask(),
    box: { left: 12, top: 8, width: 8, height: 6 },
    alias: 'C00',
    target: 'Authored Bowl',
    exclusions: ['not a plate'],
    signal: originalSignal,
  }
  const pending = verifier.verify(input)
  input.alias = 'Changed'
  input.target = 'Changed target'
  input.box.left = 11
  input.signal = replacementSignal
  const checked = await pending
  assert.equal(checked.verdict, 'match-complete-pure')
  assert.equal(seenSignal, originalSignal)
  assert.ok(requestSeen)
  const textState = requestSeen.state.filter((part): part is string => typeof part === 'string')
  assert.ok(textState.some((part) => part.includes('C00')))
  assert.ok(textState.some((part) => part.includes('Authored Bowl')))
  assert.ok(textState.some((part) => part.includes('"left":12')))
  assert.match(JSON.stringify(requestSeen.questions.verification), /Authored Bowl/u)
  assert.doesNotMatch(textState.join('\n'), /Changed/u)
})

await test('H3c honors cancellation after a late decision and never returns late success', async () => {
  const source = await image()
  const controller = new AbortController()
  let release: ((value: ReturnType<typeof result>) => void) | undefined
  const verifier = createH3cVerifier({
    imageState: createSharpRaster().imageState,
    decision: {
      decide(request) {
        return new Promise((resolve) => {
          release = resolve as (value: ReturnType<typeof result>) => void
          void request
        })
      },
    },
  })
  const pending = verifier.verify({
    image: { data: source.data, width: source.width, height: source.height, format: 'rgba8' },
    mask: mask(),
    box: { left: 12, top: 8, width: 8, height: 6 },
    alias: 'C00',
    target: 'Bowl',
    exclusions: [],
    signal: controller.signal,
  })
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0))
  controller.abort(new ClassifierError('ABORTED', 'owner cancelled'))
  const captured = release
  assert.ok(captured)
  captured(
    result(
      {
        state: [],
        questions: {
          verification: {
            type: 'choice',
            rankingSize: 1,
            instructions: '',
            criteria: Object.fromEntries(H3C_VERDICTS.map((entry) => [entry, entry])),
          },
        },
      },
      'match-complete-pure',
    ),
  )
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
  )
})

await test('H3c request passes through the real Decisions adapter with fixed OpenAI routing and no fallback', async () => {
  const source = await image()
  let physicalCalls = 0
  let adapterRequest: Record<string, unknown> | undefined
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    physicalCalls++
    adapterRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
    const sent = adapterRequest as {
      questions: { verification: { criteria: Record<string, string> } }
    }
    return new Response(
      JSON.stringify({
        model: 'openai/gpt-6-luna-decisions',
        provider: 'OpenAI',
        id: 'mock-adapter-h3c',
        answers: {
          verification: {
            type: 'choice',
            choice: 'wrong-object-or-contaminated',
            probabilities: Object.fromEntries(
              Object.keys(sent.questions.verification.criteria).map((key) => [
                key,
                Number(key === 'wrong-object-or-contaminated'),
              ]),
            ),
          },
        },
        usage: { cost: 0.001 },
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }
  const adapter = createOpenRouterDecisions({
    apiKey: 'test-only-key',
    model: 'openai/gpt-6-luna-decisions',
    provider: 'openai',
    providerName: 'OpenAI',
    fetch,
  })
  const checked = await createH3cVerifier({
    decision: adapter,
    imageState: createSharpRaster().imageState,
  }).verify({
    image: { data: source.data, width: source.width, height: source.height, format: 'rgba8' },
    mask: mask(),
    box: { left: 12, top: 8, width: 8, height: 6 },
    alias: 'C00',
    target: 'Bowl',
    exclusions: [],
    signal: new AbortController().signal,
  })
  assert.equal(checked.verdict, 'wrong-object-or-contaminated')
  assert.equal(physicalCalls, 1)
  assert.equal(adapterRequest?.model, 'openai/gpt-6-luna-decisions')
  assert.deepEqual(adapterRequest?.provider, { only: ['openai'], allow_fallbacks: false })
  const state = adapterRequest?.state
  assert.ok(Array.isArray(state))
  assert.equal(state.filter((part) => typeof part !== 'string').length, 4)
})
