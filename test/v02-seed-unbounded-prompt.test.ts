import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DecisionPort, DecisionRequest } from '../src/entities/contracts.js'
import {
  seedUnboundedInstruction,
  seedUnboundedPromptId,
  withSeedUnboundedPrompt,
} from '../benchmarks/v02/seedunboundedprompt.js'

await test('seed-unbounded prompt changes only the whole-object boundary and instance instructions', async () => {
  assert.equal(seedUnboundedPromptId, 'seed-unbounded-v1')
  const imagePart = {
    type: 'image_url' as const,
    image_url: { url: 'private-image', detail: 'high' as const },
  }
  const request: DecisionRequest = {
    state: [
      'ORIGINAL',
      'SEED',
      'A matching fragment anywhere inside a cell counts; no center requirement.',
      imagePart,
    ],
    questions: {
      selection: { type: 'choice', instructions: 'selection question', criteria: { A: 'target' } },
      left: { type: 'choice', instructions: 'left question', criteria: { L: 'interval' } },
      right: { type: 'choice', instructions: 'right question', criteria: { R: 'interval' } },
      top: { type: 'choice', instructions: 'top question', criteria: { T: 'interval' } },
      bottom: { type: 'choice', instructions: 'bottom question', criteria: { B: 'interval' } },
      instance: { type: 'choice', instructions: 'instance question', criteria: { same: 'same' } },
    },
  }
  let observed: DecisionRequest | undefined
  const delegate: DecisionPort = {
    async decide(value) {
      observed = value
      return {
        answers: {},
        metadata: {
          model: null,
          provider: null,
          requestId: null,
          durationMs: 0,
          costUsd: null,
          attempts: 1,
        },
      }
    },
  }
  await withSeedUnboundedPrompt(delegate).decide(request, new AbortController().signal)
  assert.ok(observed)
  assert.equal(observed.state.at(-1), imagePart)
  for (const id of ['left', 'right', 'top', 'bottom', 'instance']) {
    const actual: DecisionRequest['questions'][string] | undefined = observed.questions[id]
    const original: DecisionRequest['questions'][string] | undefined = request.questions[id]
    assert.ok(actual?.type === 'choice' && original?.type === 'choice')
    assert.equal(actual.instructions.endsWith(seedUnboundedInstruction), true)
    assert.deepEqual(actual.criteria, original.criteria)
  }
  assert.deepEqual(observed.questions.selection, request.questions.selection)
  assert.equal(
    observed.state.some(
      (part) =>
        typeof part === 'string' &&
        part.includes('A matching fragment anywhere inside a cell counts; no center requirement.'),
    ),
    false,
  )
  assert.equal(
    observed.state.some(
      (part) => typeof part === 'string' && part.includes(seedUnboundedInstruction),
    ),
    true,
  )
  assert.equal(JSON.stringify(observed).includes('private-image'), true)
})

await test('seed-unbounded prompt preserves cancellation signal and does not mutate the input request', async () => {
  const request: DecisionRequest = {
    state: ['state'],
    questions: {
      instance: { type: 'choice', instructions: 'identity', criteria: { same: 'same' } },
    },
  }
  const original = structuredClone(request)
  const controller = new AbortController()
  let actualSignal: AbortSignal | undefined
  const delegate: DecisionPort = {
    async decide(_request, signal) {
      actualSignal = signal
      return {
        answers: {},
        metadata: {
          model: null,
          provider: null,
          requestId: null,
          durationMs: 0,
          costUsd: null,
          attempts: 1,
        },
      }
    },
  }
  await withSeedUnboundedPrompt(delegate).decide(request, controller.signal)
  assert.equal(actualSignal, controller.signal)
  assert.deepEqual(request, original)
})
