import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import sharp from 'sharp'
import type { DecisionRequest, ImagePart } from '../src/entities/contracts.js'
import { ClassifierError } from '../src/entities/errors.js'
import type { ErrorCode } from '../src/entities/errors.js'
import { createOpenRouterJev } from '../src/openrouter.js'
import { acceptsChoiceMass } from '../src/shared/choice-mass.js'

const secret = 'secret-token-do-not-return'
const signal = () => new AbortController().signal
const request = (): DecisionRequest => ({
  state: ['Locate the player arrow.'],
  questions: {
    target: {
      type: 'choice',
      instructions: 'Choose the matching region.',
      criteria: { a: 'Region A', b: 'Region B' },
    },
  },
})
const answer = () => ({
  answers: { target: { type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.4 } } },
})
const jsonResponse = (value: unknown = answer(), init?: ResponseInit) =>
  new Response(JSON.stringify(value), init)
const injected =
  (response: Response): typeof fetch =>
  () =>
    Promise.resolve(response)
function hasCode(
  code: ErrorCode,
  extra?: (error: ClassifierError) => void,
): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof ClassifierError)
    assert.equal(error.code, code)
    assert.equal(
      JSON.stringify({ message: error.message, details: error.details }).includes(secret),
      false,
    )
    extra?.(error)
    return true
  }
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred has not initialized')
  }
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
async function image(
  format: 'png' | 'jpeg' = 'png',
  width = 280,
  height = 280,
): Promise<ImagePart> {
  const bytes = await sharp({ create: { width, height, channels: 3, background: '#abcdef' } })
    .toFormat(format)
    .toBuffer()
  return {
    type: 'image_url',
    image_url: { url: `data:image/${format};base64,${bytes.toString('base64')}`, detail: 'high' },
  }
}

await test('adapter pins route, provider and no-fallback and preserves unknown metadata', async () => {
  let calls = 0
  const owner = signal()
  const input = request()
  const port = createOpenRouterJev({
    apiKey: secret,
    fetch: (url, init) => {
      calls++
      assert.equal(url, 'https://openrouter.ai/api/alpha/decisions')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.signal, owner)
      assert.equal(init?.redirect, 'error')
      assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${secret}`)
      assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json')
      assert.equal(typeof init.body, 'string')
      assert.deepEqual(JSON.parse(String(init.body)), {
        ...input,
        model: 'typesafe/jev-1.14',
        provider: { only: ['typesafe'], allow_fallbacks: false },
      })
      return Promise.resolve(jsonResponse())
    },
  })
  const result = await port.decide(input, owner)
  assert.equal(calls, 1)
  assert.deepEqual(result.answers, answer().answers)
  assert.deepEqual(
    { ...result.metadata, durationMs: 0 },
    { model: null, provider: null, requestId: null, costUsd: null, durationMs: 0, attempts: 1 },
  )
  assert.ok(result.metadata.durationMs >= 0)
  assert.equal(getEventListeners(owner, 'abort').length, 0)
})

for (const model of ['typesafe/jev-1.14', 'typesafe/jev-1.14-20261014']) {
  await test(`accepts exact model identity ${model} and real zero cost`, async () => {
    const result = await createOpenRouterJev({
      apiKey: secret,
      fetch: injected(
        jsonResponse({
          ...answer(),
          id: 'request-id',
          model,
          provider: 'TypeSafe',
          usage: { cost: 0, input_tokens: 20, output_tokens: 4, total_tokens: 24 },
        }),
      ),
    }).decide(request(), signal())
    assert.equal(result.metadata.model, model)
    assert.equal(result.metadata.provider, 'TypeSafe')
    assert.equal(result.metadata.costUsd, 0)
    assert.equal(result.metadata.requestId, 'request-id')
  })
}

await test('uses header request ID only when response ID is unknown', async () => {
  const result = await createOpenRouterJev({
    apiKey: secret,
    fetch: injected(
      jsonResponse(
        { ...answer(), id: null, model: null, provider: null, usage: null },
        { headers: { 'x-generation-id': 'header-id' } },
      ),
    ),
  }).decide(request(), signal())
  assert.equal(result.metadata.requestId, 'header-id')
  assert.equal(result.metadata.costUsd, null)
})

for (const invalid of [
  { model: 'typesafe/jev-1.13-20260917' },
  { model: 'typesafe/jev-1.14-untrusted' },
  { model: 'typesafe/jev-1.14-20260230' },
  { provider: 'other-provider' },
  { usage: { cost: -1 } },
  { unexpected: secret },
]) {
  await test(`rejects untrusted response metadata ${Object.keys(invalid)[0]} ${JSON.stringify(invalid)}`, async () => {
    await assert.rejects(
      createOpenRouterJev({
        apiKey: secret,
        fetch: injected(jsonResponse({ ...answer(), ...invalid })),
      }).decide(request(), signal()),
      hasCode('INVALID_RESPONSE'),
    )
  })
}

for (const format of ['png', 'jpeg'] as const) {
  await test(`sends direct top-level ${format} image state unchanged`, async () => {
    const input = request()
    input.state.push(await image(format))
    const port = createOpenRouterJev({
      apiKey: secret,
      fetch: (_url, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)).state, input.state)
        return Promise.resolve(jsonResponse())
      },
    })
    await port.decide(input, signal())
  })
}

for (const dimensions of [
  [279, 280],
  [280, 279],
  [1569, 280],
  [280, 1569],
] as const) {
  await test(`rejects unprepared image dimensions ${dimensions.join('x')}`, async () => {
    const input = request()
    input.state.push(await image('png', ...dimensions))
    await assert.rejects(
      createOpenRouterJev({
        apiKey: secret,
        fetch: () => {
          assert.fail('no HTTP on invalid image')
        },
      }).decide(input, signal()),
      hasCode('INVALID_INPUT'),
    )
  })
}

await test('accepts maximum prepared image side', async () => {
  const input = request()
  input.state.push(await image('jpeg', 1568, 280))
  await createOpenRouterJev({ apiKey: secret, fetch: injected(jsonResponse()) }).decide(
    input,
    signal(),
  )
})

for (const url of [
  'https://example.com/private.png',
  'data:audio/wav;base64,AAAA',
  'data:image/png;base64,AAAA',
  'data:image/jpeg;base64,!!!!',
  'data:image/jpeg;base64,/9j/=',
]) {
  await test(`rejects unsupported image representation ${url}`, async () => {
    const input = request()
    input.state.push({ type: 'image_url', image_url: { url, detail: 'high' } })
    await assert.rejects(
      createOpenRouterJev({
        apiKey: secret,
        fetch: () => {
          assert.fail('no HTTP for unsupported image')
        },
      }).decide(input, signal()),
      hasCode('INVALID_INPUT'),
    )
  })
}

await test('rejects nested raw audio and extra request fields before transport', async () => {
  const port = createOpenRouterJev({
    apiKey: secret,
    fetch: () => {
      assert.fail('invalid state must not reach HTTP')
    },
  })
  await assert.rejects(
    port.decide(
      Object.assign(request(), {
        state: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }],
      }),
      signal(),
    ),
    hasCode('INVALID_INPUT'),
  )
  await assert.rejects(
    port.decide(Object.assign(request(), { model: 'unapproved' }), signal()),
    hasCode('INVALID_INPUT'),
  )
})

for (const count of [1, 2, 255, 256]) {
  await test(`Choice enforces 2..255 options: ${count}`, async () => {
    const criteria = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`k${index}`, `Option ${index}`]),
    )
    const input: DecisionRequest = {
      state: ['A scene'],
      questions: { target: { type: 'choice', instructions: 'Select one.', criteria } },
    }
    let calls = 0
    const port = createOpenRouterJev({
      apiKey: secret,
      fetch: () => {
        calls++
        return Promise.resolve(
          jsonResponse({
            answers: {
              target: {
                type: 'choice',
                choice: 'k0',
                probabilities: Object.fromEntries(
                  Object.keys(criteria).map((key) => [key, 1 / count]),
                ),
              },
            },
          }),
        )
      },
    })
    if (count < 2 || count > 255) {
      await assert.rejects(port.decide(input, signal()), hasCode('INVALID_INPUT'))
      assert.equal(calls, 0)
    } else {
      const result = await port.decide(input, signal())
      assert.equal(result.answers.target?.type, 'choice')
      assert.equal(calls, 1)
    }
  })
}

await test('preserves categorical ties, raw scores and independent confidence', async () => {
  const raw = {
    answers: {
      target: {
        type: 'choice',
        choice: 'b',
        probabilities: { a: 0.5, b: 0.5 },
        confidence: 0.95,
      },
    },
  }
  const result = await createOpenRouterJev({
    apiKey: secret,
    fetch: injected(jsonResponse(raw)),
  }).decide(request(), signal())
  assert.deepEqual(result.answers, raw.answers)
})

await test('supports bounded Noul without conflating it with Choice', async () => {
  const input: DecisionRequest = {
    state: ['A scene'],
    questions: { presence: { type: 'noul', instructions: 'Player marker is present.' } },
  }
  const result = await createOpenRouterJev({
    apiKey: secret,
    fetch: injected(jsonResponse({ answers: { presence: { type: 'noul', noul: 0.7 } } })),
  }).decide(input, signal())
  assert.deepEqual(result.answers, { presence: { type: 'noul', noul: 0.7 } })
})

for (const invalid of [
  {},
  { other: answer().answers.target },
  { target: answer().answers.target, other: answer().answers.target },
  { target: { type: 'noul', noul: 0.8 } },
  { target: { type: 'choice', choice: 'c', probabilities: { a: 0.6, b: 0.4 } } },
  { target: { type: 'choice', choice: 'b', probabilities: { a: 0.6, b: 0.4 } } },
  { target: { type: 'choice', choice: 'a', probabilities: { a: 1 } } },
  { target: { type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.4, c: 0 } } },
  { target: { type: 'choice', choice: 'a', probabilities: { a: 1.1, b: -0.1 } } },
]) {
  await test(`rejects mismatched question/answer distribution ${JSON.stringify(invalid)}`, async () => {
    await assert.rejects(
      createOpenRouterJev({
        apiKey: secret,
        fetch: injected(jsonResponse({ answers: invalid })),
      }).decide(request(), signal()),
      hasCode('INVALID_RESPONSE'),
    )
  })
}

await test('takes immutable request snapshot before any await', async () => {
  const input = request()
  const response = deferred<Response>()
  const operation = createOpenRouterJev({ apiKey: secret, fetch: () => response.promise }).decide(
    input,
    signal(),
  )
  delete input.questions.target
  input.state.length = 0
  response.resolve(jsonResponse())
  assert.deepEqual((await operation).answers, answer().answers)
})

await test('lower request cap rejects before fetch, including encoded JSON overhead', async () => {
  const port = createOpenRouterJev({
    apiKey: secret,
    maxRequestBytes: 250,
    fetch: () => {
      assert.fail('byte cap must prevent transport')
    },
  })
  await assert.rejects(port.decide(request(), signal()), hasCode('RESOURCE_LIMIT'))
})

for (const options of [
  { maxRequestBytes: 32 * 1024 * 1024 + 1 },
  { maxResponseBytes: 1024 * 1024 + 1 },
  { maxRequestBytes: 0 },
  { maxResponseBytes: -1 },
  { apiKey: 'bad\nkey' },
  { endpoint: 'https://unapproved.example' },
]) {
  await test(`factory rejects unsafe options ${JSON.stringify(options)}`, () => {
    assert.throws(
      () => createOpenRouterJev({ apiKey: secret, ...options }),
      hasCode('INVALID_INPUT'),
    )
  })
}

for (const [status, code] of [
  [401, 'AUTHENTICATION'],
  [403, 'AUTHENTICATION'],
  [413, 'RESOURCE_LIMIT'],
  [415, 'UNSUPPORTED'],
  [429, 'PROVIDER'],
  [500, 'PROVIDER'],
  [302, 'PROVIDER'],
] as const) {
  await test(`HTTP ${status} is sanitized, body cancelled, no retry`, async () => {
    let calls = 0
    let cancels = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(secret))
      },
      cancel() {
        cancels++
      },
    })
    const response = new Response(body, { status })
    await assert.rejects(
      createOpenRouterJev({
        apiKey: secret,
        fetch: () => {
          calls++
          return Promise.resolve(response)
        },
      }).decide(request(), signal()),
      hasCode(code, (error) => assert.equal(error.details.status, status)),
    )
    assert.equal(calls, 1)
    assert.equal(cancels, 1)
    assert.equal(body.locked, false)
  })
}

await test('declared response cap cancels before reading provider body', async () => {
  let cancels = 0
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancels++
    },
  })
  const response = new Response(body, { headers: { 'content-length': '101' } })
  await assert.rejects(
    createOpenRouterJev({
      apiKey: secret,
      maxResponseBytes: 100,
      fetch: injected(response),
    }).decide(request(), signal()),
    hasCode('RESOURCE_LIMIT'),
  )
  assert.equal(cancels, 1)
  assert.equal(body.locked, false)
})

await test('actual streamed response cap works without or with false Content-Length', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    let cancels = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(101))
      },
      cancel() {
        cancels++
      },
    })
    await assert.rejects(
      createOpenRouterJev({
        apiKey: secret,
        maxResponseBytes: 100,
        fetch: injected(new Response(body, { headers })),
      }).decide(request(), signal()),
      hasCode('RESOURCE_LIMIT'),
    )
    assert.equal(cancels, 1)
    assert.equal(body.locked, false)
  }
})

for (const response of [
  new Response('{'),
  new Response(new Uint8Array([255])),
  new Response(null),
  jsonResponse({ answers: {} }),
]) {
  await test(`malformed successful response is rejected ${response.body === null ? 'empty' : 'body'}`, async () => {
    await assert.rejects(
      createOpenRouterJev({ apiKey: secret, fetch: injected(response) }).decide(
        request(),
        signal(),
      ),
      hasCode('INVALID_RESPONSE'),
    )
    assert.equal(response.body?.locked ?? false, false)
  })
}

await test('fetch and stream exceptions cannot leak messages or details, including forged ClassifierError', async () => {
  const port = createOpenRouterJev({
    apiKey: secret,
    fetch: () => Promise.reject(new ClassifierError('AUTHENTICATION', secret, { secret })),
  })
  await assert.rejects(port.decide(request(), signal()), hasCode('PROVIDER'))
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new ClassifierError('INVALID_RESPONSE', secret, { secret }))
    },
  })
  await assert.rejects(
    createOpenRouterJev({ apiKey: secret, fetch: injected(new Response(body)) }).decide(
      request(),
      signal(),
    ),
    hasCode('PROVIDER'),
  )
  assert.equal(body.locked, false)
})

await test('pre-aborted signal prevents transport and sanitizes cancellation reason', async () => {
  const owner = new AbortController()
  owner.abort(new ClassifierError('AUTHENTICATION', secret, { secret }))
  await assert.rejects(
    createOpenRouterJev({
      apiKey: secret,
      fetch: () => {
        assert.fail('must not fetch')
      },
    }).decide(request(), owner.signal),
    hasCode('ABORTED'),
  )
})

await test('retains TIMEOUT code while sanitizing caller reason', async () => {
  const owner = new AbortController()
  owner.abort(new ClassifierError('TIMEOUT', secret, { secret }))
  await assert.rejects(
    createOpenRouterJev({ apiKey: secret, fetch: injected(jsonResponse()) }).decide(
      request(),
      owner.signal,
    ),
    hasCode('TIMEOUT'),
  )
})

await test('late fetch response after abort is cancelled/released and never returns success', async () => {
  const owner = new AbortController()
  const late = deferred<Response>()
  let cancels = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from(JSON.stringify(answer())))
    },
    cancel() {
      cancels++
    },
  })
  const operation = createOpenRouterJev({ apiKey: secret, fetch: () => late.promise }).decide(
    request(),
    owner.signal,
  )
  const rejection = assert.rejects(operation, hasCode('ABORTED'))
  owner.abort(secret)
  late.resolve(new Response(body))
  await rejection
  assert.equal(cancels, 1)
  assert.equal(body.locked, false)
  assert.equal(getEventListeners(owner.signal, 'abort').length, 0)
})

await test('abort during body read cancels once, joins physical cleanup, releases reader/listener', async () => {
  const owner = new AbortController()
  const reading = deferred<void>()
  const cancelled = deferred<void>()
  const cleanup = deferred<void>()
  let cancels = 0
  let settled = false
  const body = new ReadableStream<Uint8Array>({
    pull() {
      reading.resolve()
    },
    cancel() {
      cancels++
      cancelled.resolve()
      return cleanup.promise
    },
  })
  const operation = createOpenRouterJev({
    apiKey: secret,
    fetch: injected(new Response(body)),
  }).decide(request(), owner.signal)
  const rejection = assert.rejects(operation, hasCode('ABORTED')).then(() => {
    settled = true
  })
  await reading.promise
  assert.equal(getEventListeners(owner.signal, 'abort').length, 1)
  owner.abort(secret)
  await cancelled.promise
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(body.locked, true)
  cleanup.resolve()
  await rejection
  assert.equal(cancels, 1)
  assert.equal(body.locked, false)
  assert.equal(getEventListeners(owner.signal, 'abort').length, 0)
})

await test('cancellation rejection is sanitized and visible without retaining reader', async () => {
  const owner = new AbortController()
  const reading = deferred<void>()
  const body = new ReadableStream<Uint8Array>({
    pull() {
      reading.resolve()
    },
    cancel() {
      return Promise.reject(new Error(secret))
    },
  })
  const operation = createOpenRouterJev({
    apiKey: secret,
    fetch: injected(new Response(body)),
  }).decide(request(), owner.signal)
  const rejection = assert.rejects(
    operation,
    hasCode('ABORTED', (error) => assert.equal(error.details.cleanupFailed, true)),
  )
  await reading.promise
  owner.abort(secret)
  await rejection
  assert.equal(body.locked, false)
  assert.equal(getEventListeners(owner.signal, 'abort').length, 0)
})

await test('rejects prototype setter keys rather than silently dropping requested options', async () => {
  const input = request()
  const question = input.questions.target
  assert.ok(question?.type === 'choice')
  Object.defineProperty(question.criteria, '__proto__', { value: 'Third option', enumerable: true })
  await assert.rejects(
    createOpenRouterJev({
      apiKey: secret,
      fetch: () => {
        assert.fail('must not fetch altered question')
      },
    }).decide(input, signal()),
    hasCode('INVALID_INPUT'),
  )
})

await test('rejects prototype setter keys in provider answer rather than stripping them', async () => {
  const raw = answer()
  Object.defineProperty(raw.answers.target.probabilities, '__proto__', {
    value: 0,
    enumerable: true,
  })
  await assert.rejects(
    createOpenRouterJev({ apiKey: secret, fetch: injected(jsonResponse(raw)) }).decide(
      request(),
      signal(),
    ),
    hasCode('INVALID_RESPONSE'),
  )
})

await test('abort racing with body EOF cannot publish successful answer', async () => {
  const owner = new AbortController()
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(Buffer.from(JSON.stringify(answer())))
      },
      pull(controller) {
        controller.close()
        owner.abort(secret)
      },
    },
    { highWaterMark: 0 },
  )
  await assert.rejects(
    createOpenRouterJev({ apiKey: secret, fetch: injected(new Response(body)) }).decide(
      request(),
      owner.signal,
    ),
    hasCode('ABORTED'),
  )
  assert.equal(body.locked, false)
  assert.equal(getEventListeners(owner.signal, 'abort').length, 0)
})

await test('copies fragmented reused stream buffers without retaining per-chunk allocations', async () => {
  const bytes = Buffer.from(JSON.stringify(answer()))
  const scratch = new Uint8Array(1)
  let offset = 0
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset === bytes.length) {
          controller.close()
          return
        }
        scratch[0] = bytes[offset++] ?? 0
        controller.enqueue(scratch)
      },
    },
    { highWaterMark: 0 },
  )
  const result = await createOpenRouterJev({
    apiKey: secret,
    fetch: injected(new Response(body)),
  }).decide(request(), signal())
  assert.deepEqual(result.answers, answer().answers)
  assert.equal(body.locked, false)
})

await test('complete request byte cap includes criteria, instructions, keys and JSON escaping', async () => {
  for (const value of [
    'a'.repeat(1000),
    '\u0000'.repeat(200),
    '\ud800'.repeat(200),
    '😀'.repeat(300),
  ]) {
    const input = request()
    input.questions.target = {
      type: 'choice',
      instructions: value,
      criteria: { a: value, b: value },
    }
    await assert.rejects(
      createOpenRouterJev({
        apiKey: secret,
        maxRequestBytes: 1024,
        fetch: () => {
          assert.fail('oversized serialized body must not reach transport')
        },
      }).decide(input, signal()),
      hasCode('RESOURCE_LIMIT'),
    )
  }
})

await test('accepts exact serialized request cap and rejects one byte below it', async () => {
  for (const value of ['ASCII', 'é', '中', '😀', '\u0000', '\n', '\ud800', '\udc00', '\\', '"']) {
    const input = request()
    input.state = [value]
    const bytes = Buffer.byteLength(
      JSON.stringify({
        ...input,
        model: 'typesafe/jev-1.14',
        provider: { only: ['typesafe'], allow_fallbacks: false },
      }),
    )
    await createOpenRouterJev({
      apiKey: secret,
      maxRequestBytes: bytes,
      fetch: injected(jsonResponse()),
    }).decide(input, signal())
    await assert.rejects(
      createOpenRouterJev({
        apiKey: secret,
        maxRequestBytes: bytes - 1,
        fetch: () => {
          assert.fail('one byte over cap')
        },
      }).decide(input, signal()),
      hasCode('RESOURCE_LIMIT'),
    )
  }
})

await test('rejects oversized criteria before allocating full serialized body', async () => {
  const criteria = Object.fromEntries(
    Array.from({ length: 255 }, (_, index) => [`k${index}`, 'x'.repeat(64_000)]),
  )
  const questions = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `q${index}`,
      { type: 'choice' as const, instructions: 'Choose.', criteria },
    ]),
  )
  await assert.rejects(
    createOpenRouterJev({
      apiKey: secret,
      fetch: () => {
        assert.fail('must reject oversized 249MiB logical input')
      },
    }).decide({ state: ['scene'], questions }, signal()),
    hasCode('RESOURCE_LIMIT'),
  )
})

await test('rejects accessors, cycles and overlong collections before schema cloning', async () => {
  const getter = request()
  Object.defineProperty(getter, 'state', {
    enumerable: true,
    get() {
      throw new Error(secret)
    },
  })
  const cycle = request()
  Object.assign(cycle, { cycle })
  for (const value of [
    getter,
    cycle,
    Object.assign(request(), { state: Array.from({ length: 65 }, () => 'a') }),
  ]) {
    await assert.rejects(
      createOpenRouterJev({
        apiKey: secret,
        fetch: () => {
          assert.fail('invalid input must not reach transport')
        },
      }).decide(value, signal()),
      hasCode('INVALID_INPUT'),
    )
  }
})

await test('rejects unnormalized choice distribution without renormalizing it', async () => {
  await assert.rejects(
    createOpenRouterJev({
      apiKey: secret,
      fetch: injected(
        jsonResponse({
          answers: { target: { type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.1 } } },
        }),
      ),
    }).decide(request(), signal()),
    hasCode('INVALID_RESPONSE'),
  )
})

// Published provider evidence: screen-locator-jev-latency-2026-10-16/runs/v3/call-1/response.raw
await test('replays actual Jev 1.14 wire: screen-locator-jev-latency-2026-10-16', async () => {
  const raw =
    '{"model":"typesafe/jev-1.14-20261014","answers":{"selection":{"type":"choice","choice":"P11","probabilities":{"P01":0.02,"P02":0,"P03":0,"P04":0.05,"P05":0,"P06":0,"P07":0.33,"P08":0,"P09":0,"P10":0,"P11":0.6,"P12":0,"P13":0,"P14":0,"P15":0,"P16":0},"confidence":0.57},"presence":{"type":"noul","noul":0.85},"multiplicity":{"type":"noul","noul":0.19}},"usage":{"input_tokens":8998,"output_tokens":198,"cost":0.000377916},"id":"gen-dec-1792159419-PsVOscv7usGpbRLcX3m3","provider":"TypeSafe"}'
  assert.equal(
    createHash('sha256').update(raw).digest('hex'),
    '603e43603ee797f1ccf27d118474bf862cb64653b6b332aaac4a7ce15f9adbc7',
  )
  const input = {
    state: ['Offline response compatibility fixture.'],
    questions: {
      selection: {
        type: 'choice',
        instructions: 'Offline wire replay; no inference.',
        criteria: {
          P01: 'P01',
          P02: 'P02',
          P03: 'P03',
          P04: 'P04',
          P05: 'P05',
          P06: 'P06',
          P07: 'P07',
          P08: 'P08',
          P09: 'P09',
          P10: 'P10',
          P11: 'P11',
          P12: 'P12',
          P13: 'P13',
          P14: 'P14',
          P15: 'P15',
          P16: 'P16',
        },
      },
      presence: { type: 'noul', instructions: 'Offline wire replay; no inference.' },
      multiplicity: { type: 'noul', instructions: 'Offline wire replay; no inference.' },
    },
  } satisfies DecisionRequest
  const result = await createOpenRouterJev({
    apiKey: secret,
    fetch: injected(new Response(raw)),
  }).decide(input, signal())
  assert.equal(result.metadata.model, 'typesafe/jev-1.14-20261014')
  assert.equal(result.metadata.costUsd, 0.000377916)
  assert.deepEqual(result.answers, {
    selection: {
      type: 'choice',
      choice: 'P11',
      probabilities: {
        P01: 0.02,
        P02: 0,
        P03: 0,
        P04: 0.05,
        P05: 0,
        P06: 0,
        P07: 0.33,
        P08: 0,
        P09: 0,
        P10: 0,
        P11: 0.6,
        P12: 0,
        P13: 0,
        P14: 0,
        P15: 0,
        P16: 0,
      },
      confidence: 0.57,
    },
    presence: { type: 'noul', noul: 0.85 },
    multiplicity: { type: 'noul', noul: 0.19 },
  })
})

// Published provider evidence: screen-locator-jev-1-14-2026-10-16/runs/v3/execution-v1/09-ng-002-choice/response.raw
await test('replays actual Jev 1.14 wire: screen-locator-jev-1-14-2026-10-16', async () => {
  const raw =
    '{"model":"typesafe/jev-1.14-20261014","answers":{"selection":{"type":"choice","choice":"C","probabilities":{"A":0.17,"B":0.02,"C":0.59,"D":0.02,"none":0.2},"confidence":0.49},"presence":{"type":"noul","noul":0.71}},"usage":{"input_tokens":7533,"output_tokens":69,"cost":0.000316386},"id":"gen-dec-1792156447-AmPrR3guEc5n9HQo4YMZ","provider":"TypeSafe"}'
  assert.equal(
    createHash('sha256').update(raw).digest('hex'),
    '8090dc576cb553de89f9e52402870b27a171fbbfc9e89f36ab630a702449dbef',
  )
  const input = {
    state: ['Offline response compatibility fixture.'],
    questions: {
      selection: {
        type: 'choice',
        instructions: 'Offline wire replay; no inference.',
        criteria: { A: 'A', B: 'B', C: 'C', D: 'D', none: 'none' },
      },
      presence: { type: 'noul', instructions: 'Offline wire replay; no inference.' },
    },
  } satisfies DecisionRequest
  const result = await createOpenRouterJev({
    apiKey: secret,
    fetch: injected(new Response(raw)),
  }).decide(input, signal())
  assert.equal(result.metadata.model, 'typesafe/jev-1.14-20261014')
  assert.equal(result.metadata.costUsd, 0.000316386)
  assert.deepEqual(result.answers, {
    selection: {
      type: 'choice',
      choice: 'C',
      probabilities: { A: 0.17, B: 0.02, C: 0.59, D: 0.02, none: 0.2 },
      confidence: 0.49,
    },
    presence: { type: 'noul', noul: 0.71 },
  })
})

await test('non-enumerable declared fields and proxies cannot bypass preflight byte accounting', async () => {
  const hidden = request()
  Object.defineProperty(hidden, 'state', { value: ['x'.repeat(64_000)], enumerable: false })
  const proxy = new Proxy(request(), {
    get() {
      throw new Error(secret)
    },
  })
  for (const input of [hidden, proxy]) {
    await assert.rejects(
      createOpenRouterJev({
        apiKey: secret,
        maxRequestBytes: 1024,
        fetch: () => {
          assert.fail('must reject hidden input')
        },
      }).decide(input, signal()),
      hasCode('INVALID_INPUT'),
    )
  }
})

for (const hook of ['own-method', 'own-getter', 'inherited-getter'] as const) {
  await test(`owned snapshot never invokes caller array iterator: ${hook}`, async () => {
    const input = request()
    let invoked = 0
    const trap = () => {
      invoked++
      throw new Error('caller iterator must not execute')
    }
    if (hook === 'own-method') Object.defineProperty(input.state, Symbol.iterator, { value: trap })
    else if (hook === 'own-getter')
      Object.defineProperty(input.state, Symbol.iterator, { get: trap })
    else {
      const prototype: object = Object.create(Array.prototype)
      Object.defineProperty(prototype, Symbol.iterator, { get: trap })
      Object.setPrototypeOf(input.state, prototype)
    }
    const port = createOpenRouterJev({
      apiKey: secret,
      fetch: (_url, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)).state, ['Locate the player arrow.'])
        return Promise.resolve(jsonResponse())
      },
    })
    assert.deepEqual((await port.decide(input, signal())).answers, answer().answers)
    assert.equal(invoked, 0)
  })
}

await test('choice mass remains strict without explicit rounding provenance', () => {
  assert.equal(acceptsChoiceMass([0.505, 0.495]), true)
  assert.equal(acceptsChoiceMass([0.4999996, 0.5]), true)
  assert.equal(acceptsChoiceMass([0.49, 0.5]), false)
  assert.equal(acceptsChoiceMass(Array.from({ length: 153 }, () => 0.01)), false)
  for (const scores of [[], [NaN, 1], [Infinity, 0], [-0.1, 1.1], [-1e-12, 1]]) {
    assert.equal(acceptsChoiceMass(scores), false)
    assert.equal(acceptsChoiceMass(scores, 0.01), false)
  }
})

await test('explicit rounding validates clipped feasible mass, not a fixed sum tolerance', () => {
  assert.equal(acceptsChoiceMass([0.49, 0.5], 0.01), true)
  assert.equal(acceptsChoiceMass([0.06999999999999999, 0.92], 0.01), true)
  assert.equal(
    acceptsChoiceMass(
      Array.from({ length: 153 }, () => 0.01),
      0.01,
    ),
    true,
  )
  assert.equal(
    acceptsChoiceMass(
      Array.from({ length: 255 }, () => 0.01),
      0.01,
    ),
    false,
  )
  assert.equal(acceptsChoiceMass([0.01, 0.01], 0.01), false)
  assert.equal(acceptsChoiceMass([0.505, 0.485], 0.01), false)
  assert.equal(acceptsChoiceMass([0.500000000002, 0.49], 0.01), false)
  assert.equal(acceptsChoiceMass([1, 0, 0.01], 0.01), true)
  assert.equal(acceptsChoiceMass([1, 1], 0.01), false)
  // All-zero rounded output can be consistent but supplies no ranking information.
  assert.equal(
    acceptsChoiceMass(
      Array.from({ length: 153 }, () => 0),
      0.01,
    ),
    false,
  )
  assert.equal(
    acceptsChoiceMass(
      Array.from({ length: 201 }, () => 0),
      0.01,
    ),
    true,
  )
})

await test('adapter annotates only rounded mass and preserves raw native ties', async () => {
  const probabilities = { a: 0.33, b: 0.33, c: 0.33 }
  const input = request()
  input.questions.target = {
    type: 'choice',
    instructions: 'Choose.',
    criteria: { a: 'A', b: 'B', c: 'C' },
  }
  const result = await createOpenRouterJev({
    apiKey: secret,
    fetch: injected(
      jsonResponse({
        answers: { target: { type: 'choice', choice: 'c', probabilities, confidence: 0 } },
      }),
    ),
  }).decide(input, signal())
  assert.deepEqual(result.answers.target, {
    type: 'choice',
    choice: 'c',
    probabilities,
    confidence: 0,
    probabilityRoundingStep: 0.01,
  })
  const exact = await createOpenRouterJev({
    apiKey: secret,
    fetch: injected(jsonResponse()),
  }).decide(request(), signal())
  assert.equal(Object.hasOwn(exact.answers.target ?? {}, 'probabilityRoundingStep'), false)
})

for (const malformed of [
  { type: 'choice', choice: 'a', probabilities: { a: 0.505, b: 0.485 } },
  { type: 'choice', choice: 'b', probabilities: { a: 0.5, b: 0.49 } },
  { type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.4 }, probabilityRoundingStep: 0.01 },
]) {
  await test(`rounded transport still rejects malformed distribution ${JSON.stringify(malformed)}`, async () => {
    await assert.rejects(
      createOpenRouterJev({
        apiKey: secret,
        fetch: injected(jsonResponse({ answers: { target: malformed } })),
      }).decide(request(), signal()),
      hasCode('INVALID_RESPONSE'),
    )
  })
}

// Exact sanitized wire from the separately retained protocol probe; no new provider request.
await test('replays actual 153-option Jev 1.14 rounded response without normalizing scores', async () => {
  const raw =
    '{\n  "model": "typesafe/jev-1.14-20261014",\n  "answers": {\n    "selection": {\n      "type": "choice",\n      "choice": "C000",\n      "probabilities": {\n        "C000": 0.06999999999999999,\n        "C001": 0.03,\n        "C002": 0.01,\n        "C003": 0.01,\n        "C004": 0.03,\n        "C005": 0,\n        "C006": 0,\n        "C007": 0,\n        "C008": 0.05,\n        "C009": 0,\n        "C010": 0.01,\n        "C011": 0.03,\n        "C012": 0.05,\n        "C013": 0.01,\n        "C014": 0,\n        "C015": 0,\n        "C016": 0.01,\n        "C017": 0,\n        "C018": 0.01,\n        "C019": 0.03,\n        "C020": 0.03,\n        "C021": 0.03,\n        "C022": 0,\n        "C023": 0.01,\n        "C024": 0.05,\n        "C025": 0,\n        "C026": 0.01,\n        "C027": 0.01,\n        "C028": 0.01,\n        "C029": 0,\n        "C030": 0,\n        "C031": 0,\n        "C032": 0.04,\n        "C033": 0,\n        "C034": 0,\n        "C035": 0,\n        "C036": 0.01,\n        "C037": 0,\n        "C038": 0,\n        "C039": 0.01,\n        "C040": 0,\n        "C041": 0,\n        "C042": 0,\n        "C043": 0,\n        "C044": 0,\n        "C045": 0,\n        "C046": 0,\n        "C047": 0,\n        "C048": 0.01,\n        "C049": 0,\n        "C050": 0,\n        "C051": 0,\n        "C052": 0.01,\n        "C053": 0,\n        "C054": 0,\n        "C055": 0,\n        "C056": 0,\n        "C057": 0,\n        "C058": 0.01,\n        "C059": 0.01,\n        "C060": 0.01,\n        "C061": 0.01,\n        "C062": 0.03,\n        "C063": 0.03,\n        "C064": 0.01,\n        "C065": 0,\n        "C066": 0.01,\n        "C067": 0.01,\n        "C068": 0,\n        "C069": 0,\n        "C070": 0,\n        "C071": 0,\n        "C072": 0,\n        "C073": 0,\n        "C074": 0,\n        "C075": 0,\n        "C076": 0,\n        "C077": 0,\n        "C078": 0,\n        "C079": 0,\n        "C080": 0,\n        "C081": 0,\n        "C082": 0,\n        "C083": 0.01,\n        "C084": 0,\n        "C085": 0,\n        "C086": 0,\n        "C087": 0,\n        "C088": 0,\n        "C089": 0,\n        "C090": 0,\n        "C091": 0,\n        "C092": 0,\n        "C093": 0,\n        "C094": 0,\n        "C095": 0,\n        "C096": 0.04,\n        "C097": 0,\n        "C098": 0.01,\n        "C099": 0,\n        "C100": 0,\n        "C101": 0.01,\n        "C102": 0,\n        "C103": 0.01,\n        "C104": 0,\n        "C105": 0,\n        "C106": 0,\n        "C107": 0,\n        "C108": 0,\n        "C109": 0.01,\n        "C110": 0,\n        "C111": 0,\n        "C112": 0,\n        "C113": 0,\n        "C114": 0,\n        "C115": 0,\n        "C116": 0,\n        "C117": 0,\n        "C118": 0,\n        "C119": 0,\n        "C120": 0,\n        "C121": 0,\n        "C122": 0,\n        "C123": 0.01,\n        "C124": 0,\n        "C125": 0,\n        "C126": 0,\n        "C127": 0.03,\n        "C128": 0.04,\n        "C129": 0.03,\n        "C130": 0,\n        "C131": 0.01,\n        "C132": 0,\n        "C133": 0,\n        "C134": 0.01,\n        "C135": 0.01,\n        "C136": 0.01,\n        "C137": 0.02,\n        "C138": 0,\n        "C139": 0.02,\n        "C140": 0,\n        "C141": 0,\n        "C142": 0,\n        "C143": 0,\n        "C144": 0,\n        "C145": 0,\n        "C146": 0,\n        "C147": 0,\n        "C148": 0,\n        "C149": 0,\n        "C150": 0,\n        "C151": 0,\n        "C152": 0\n      },\n      "confidence": 0.06\n    },\n    "presence": {\n      "type": "noul",\n      "noul": 0.98\n    }\n  },\n  "usage": {\n    "input_tokens": 27042,\n    "output_tokens": 1567,\n    "cost": 0.001135764\n  },\n  "id": "gen-dec-1792273040-UUgkxIwXlvDB59Ud1l0G",\n  "provider": "TypeSafe"\n}'
  assert.equal(
    createHash('sha256').update(raw).digest('hex'),
    '1beed7d94f2635fe16fb2d9118a16105e36fba50cbc8d01f86bb6120a7624020',
  )
  const input: DecisionRequest = {
    state: ['Offline response compatibility fixture.'],
    questions: {
      selection: {
        type: 'choice',
        instructions: 'Offline wire replay; no inference.',
        criteria: Object.fromEntries(
          Array.from({ length: 153 }, (_, index) => {
            const id = `C${String(index).padStart(3, '0')}`
            return [id, id]
          }),
        ),
      },
      presence: { type: 'noul', instructions: 'Offline wire replay; no inference.' },
    },
  }
  const result = await createOpenRouterJev({
    apiKey: secret,
    fetch: injected(new Response(raw)),
  }).decide(input, signal())
  const selected = result.answers.selection
  assert.equal(selected?.type, 'choice')
  if (selected?.type !== 'choice') assert.fail('Expected choice response')
  assert.equal(selected.choice, 'C000')
  assert.equal(selected.probabilities.C000, 0.06999999999999999)
  assert.equal(selected.confidence, 0.06)
  assert.equal(selected.probabilityRoundingStep, 0.01)
  assert.equal(Object.keys(selected.probabilities).length, 153)
  assert.equal(acceptsChoiceMass(Object.values(selected.probabilities)), false)
  assert.equal(acceptsChoiceMass(Object.values(selected.probabilities), 0.01), true)
  const { probabilityRoundingStep, ...unannotated } = selected
  assert.equal(probabilityRoundingStep, 0.01)
  assert.deepEqual(unannotated, JSON.parse(raw).answers.selection)
  assert.deepEqual(result.answers.presence, { type: 'noul', noul: 0.98 })
  assert.equal(result.metadata.costUsd, 0.001135764)
  assert.equal(result.metadata.model, 'typesafe/jev-1.14-20261014')
  assert.equal(result.metadata.provider, 'TypeSafe')
})
