import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'

import {
  ClassifierError,
  createClassifier,
  type DecisionPort,
  type DecisionRequest,
  type DecisionResult,
  type ObjectProposalBatch,
  type ObjectProposalInput,
  type ObjectProposalPort,
} from '../src/index.js'
import { createMobileSamObjectProposals } from '../src/segmentation.js'

const metadata = {
  model: 'fixture',
  provider: 'fixture',
  requestId: null,
  durationMs: 0,
  costUsd: 0,
  attempts: 1,
}

function fixtureDecision(onDecision?: (request: DecisionRequest) => void): DecisionPort {
  return {
    async decide(request) {
      onDecision?.(request)
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => {
          if (question.type === 'noul') return [id, { type: 'noul' as const, noul: 1 }]
          const keys = Object.keys(question.criteria)
          const choice = id === 'selection' && keys.includes('C00') ? 'C00' : keys[0]!
          return [
            id,
            {
              type: 'choice' as const,
              choice,
              probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
            },
          ]
        }),
      )
      return { answers, metadata } as DecisionResult
    },
  }
}

function proposalPort(
  onPropose?: (
    input: ObjectProposalInput,
  ) => ObjectProposalBatch | Promise<ObjectProposalBatch | void> | void,
  onSettle?: () => Promise<void> | void,
): ObjectProposalPort & { disposed: number; proposed: number; settled: number } {
  const counts = { disposed: 0, proposed: 0, settled: 0 }
  return {
    get disposed() {
      return counts.disposed
    },
    get proposed() {
      return counts.proposed
    },
    get settled() {
      return counts.settled
    },
    async propose(input): Promise<ObjectProposalBatch> {
      counts.proposed++
      const override = await onPropose?.(input)
      if (override) return await override
      const data = new Uint8Array(Math.ceil((input.image.width * input.image.height) / 8))
      data.fill(0xff)
      const used = (input.image.width * input.image.height) % 8
      if (used !== 0) data[data.length - 1] = (1 << used) - 1
      return {
        proposals: [
          {
            id: 'C00',
            mask: {
              data,
              width: input.image.width,
              height: input.image.height,
              format: 'binary-lsb0',
            },
            qualityScore: 0.8,
          },
        ],
        metadata: {
          method: 'fixture-proposals',
          backend: 'fixture',
          durationMs: 0,
          input: { width: input.image.width, height: input.image.height },
        },
      }
    },
    async settle() {
      counts.settled++
      await onSettle?.()
    },
    async dispose() {
      counts.disposed++
    },
  }
}

async function fixturePng(size = 64): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: size, height: size, channels: 4, background: '#405060' },
    })
      .png()
      .toBuffer(),
  )
}

function input(image: Uint8Array, signal?: AbortSignal) {
  return {
    image,
    target: 'the fixture object',
    mode: 'whole-object' as const,
    ...(signal === undefined ? {} : { signal }),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

await test('public whole-object and extract consumers accept the caller-owned proposal port', async () => {
  const seen: DecisionRequest[] = []
  const port = proposalPort()
  const classifier = createClassifier({
    decision: fixtureDecision((request) => seen.push(request)),
    objectProposals: port,
  })
  try {
    const image = await fixturePng()
    const location = await classifier.locate(input(image))
    assert.equal(location.status, 'located')
    if (location.status === 'located') {
      assert.equal(location.method, 'pixel-mask-proposals-v1')
      assert.deepEqual(location.region, { left: 0, top: 0, width: 64, height: 64 })
      assert.equal(location.proposalMetadata?.method, 'fixture-proposals')
    }
    assert.ok(seen.some((request) => 'selection' in request.questions))

    const extracted = await classifier.extract({ image, target: 'the fixture object' })
    assert.equal(extracted.status, 'extracted')
    if (extracted.status === 'extracted') {
      assert.equal(extracted.location.method, 'pixel-mask-proposals-v1')
      assert.deepEqual(extracted.region, { left: 0, top: 0, width: 64, height: 64 })
      assert.equal(extracted.segmentation.method, 'fixture-proposals')
      assert.deepEqual([...extracted.mask.data], new Array(64 * 64).fill(1))
    }
    assert.equal(port.proposed, 2)
    assert.equal(port.settled, 0, 'the classifier must not globally settle a caller-owned port')
  } finally {
    await classifier.dispose()
  }
  assert.equal(port.disposed, 0)
  assert.equal(typeof createMobileSamObjectProposals, 'function')
})

await test('classifier disposal joins cancelled proposal work and never disposes the external port', async () => {
  const began = deferred<ObjectProposalInput>()
  const physical = deferred<void>()
  const lateBatch = deferred<ObjectProposalBatch>()
  let decisionCalls = 0
  let callsAtPropose = -1
  const port = proposalPort(async (input) => {
    callsAtPropose = decisionCalls
    began.resolve(input)
    const batch = await lateBatch.promise
    // Model a caller-owned adapter whose propose promise only resolves after
    // its physical child has closed. The classifier must join this promise.
    await physical.promise
    return batch
  })
  const classifier = createClassifier({
    decision: fixtureDecision(() => decisionCalls++),
    objectProposals: port,
    concurrency: 1,
    maxQueue: 1,
  })
  const callerImage = await fixturePng()
  const controller = new AbortController()
  const operation = classifier.locate(input(callerImage, controller.signal))
  callerImage.fill(0)
  const proposalInput = await began.promise
  assert.equal(proposalInput.image.format, 'rgba8')
  assert.equal(proposalInput.image.width, 64)
  assert.equal(proposalInput.image.height, 64)
  // The proposal port receives its own canonical-pixel copy.
  const expectedPixel = [...proposalInput.image.data.subarray(0, 4)]
  proposalInput.image.data.fill(0)
  assert.deepEqual([...proposalInput.image.data.subarray(0, 4)], [0, 0, 0, 0])

  controller.abort()
  let disposed = false
  const dispose = classifier.dispose().then(() => {
    disposed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(disposed, false, 'dispose must wait for propose to settle physical work')
  assert.equal(port.disposed, 0)

  const blockedCall = classifier.locate(input(callerImage))
  await assert.rejects(blockedCall, { code: 'DISPOSED' })
  const data = new Uint8Array(Math.ceil((64 * 64) / 8))
  data.fill(0xff)
  lateBatch.resolve({
    proposals: [
      {
        id: 'C00',
        mask: { data, width: 64, height: 64, format: 'binary-lsb0' },
      },
    ],
    metadata: {
      method: 'late-fixture',
      backend: 'fixture',
      durationMs: 0,
      input: { width: 64, height: 64 },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(disposed, false, 'a late batch alone must not release physical ownership')
  physical.resolve()
  await assert.rejects(operation, { code: 'ABORTED' })
  await dispose
  assert.equal(disposed, true)
  assert.equal(port.settled, 0)
  assert.equal(port.disposed, 0)
  assert.equal(decisionCalls, callsAtPropose)
  assert.deepEqual(expectedPixel, [64, 80, 96, 255])
})

await test('a late cancelled proposal keeps the gate occupied until close, then the next call can run', async () => {
  const firstBatch = deferred<ObjectProposalBatch>()
  const firstPhysical = deferred<void>()
  let proposeCalls = 0
  let candidateQuestions = 0
  const port = proposalPort(async () => {
    proposeCalls++
    if (proposeCalls !== 1) return undefined
    const batch = await firstBatch.promise
    await firstPhysical.promise
    return batch
  })
  const classifier = createClassifier({
    decision: fixtureDecision((request) => {
      const selection = request.questions['selection']
      if (selection?.type === 'choice' && Object.hasOwn(selection.criteria, 'C00'))
        candidateQuestions++
    }),
    objectProposals: port,
    concurrency: 1,
    maxQueue: 1,
  })
  const image = await fixturePng()
  const controller = new AbortController()
  const cancelled = classifier.locate(input(image, controller.signal))
  while (proposeCalls === 0) await new Promise((resolve) => setImmediate(resolve))
  const next = classifier.locate(input(image))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(proposeCalls, 1, 'a queued request must not reuse the slot while propose is pending')

  controller.abort()
  const mask = new Uint8Array((64 * 64) / 8)
  mask.fill(0xff)
  firstBatch.resolve({
    proposals: [{ id: 'C00', mask: { data: mask, width: 64, height: 64, format: 'binary-lsb0' } }],
    metadata: {
      method: 'late-fixture',
      backend: 'fixture',
      durationMs: 0,
      input: { width: 64, height: 64 },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(proposeCalls, 1, 'a batch must not free the slot before the physical promise closes')
  firstPhysical.resolve()
  await assert.rejects(cancelled, { code: 'ABORTED' })
  const located = await next
  assert.equal(located.status, 'located')
  assert.equal(proposeCalls, 2)
  assert.equal(
    candidateQuestions,
    1,
    'the late cancelled result must trigger no model selection call',
  )
  await classifier.dispose()
  assert.equal(port.settled, 0)
  assert.equal(port.disposed, 0)
})

await test('one thousand pre-cancelled operations make no model/proposal calls or slot leaks', async () => {
  let modelCalls = 0
  const port = proposalPort()
  const classifier = createClassifier({
    decision: fixtureDecision(() => modelCalls++),
    objectProposals: port,
    concurrency: 1,
    maxQueue: 0,
  })
  const image = await fixturePng()
  try {
    for (let index = 0; index < 1000; index++) {
      const controller = new AbortController()
      controller.abort(new ClassifierError('ABORTED', `cancel ${index}`))
      await assert.rejects(classifier.locate(input(image, controller.signal)), { code: 'ABORTED' })
    }
    const success = await classifier.locate(input(image))
    assert.equal(success.status, 'located')
    assert.equal(modelCalls > 0, true)
    assert.equal(port.proposed, 1)
  } finally {
    await classifier.dispose()
  }
  assert.equal(port.disposed, 0)
})

await test('experimental text representation is not promoted by the proposal adapter', async () => {
  let calls = 0
  const port = proposalPort()
  const classifier = createClassifier({
    decision: fixtureDecision(() => calls++),
    objectProposals: port,
  })
  try {
    await assert.rejects(
      classifier.locate({
        ...input(await fixturePng()),
        representation: { type: 'experimental-text', profile: 'text-image-v1' },
      }),
      { code: 'UNSUPPORTED' },
    )
    assert.equal(calls, 0)
    assert.equal(port.proposed, 0)
  } finally {
    await classifier.dispose()
  }
  assert.equal(port.disposed, 0)
})
