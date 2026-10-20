import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { createOpenAICompatibleText } from '../src/openai-compatible.js'
import { createOpenRouterText } from '../src/openrouter.js'
import type { DecisionRequest } from '../src/entities/contracts.js'

const request: DecisionRequest = {
  state: ['ASCII_LUMA_V1\nwidth=2 height=2\n..\n##'],
  questions: {
    selection: {
      type: 'choice',
      rankingSize: 1,
      instructions: 'Choose shape',
      criteria: { a: 'horizontal stripe', b: 'vertical stripe' },
    },
  },
}
await test('text-only adapter sends only encoded text with the existing strict rank protocol', async () => {
  let calls = 0
  const port = createOpenAICompatibleText({
    endpoint: 'http://127.0.0.1:9/v1/chat/completions',
    model: 'fixture/text',
    fetch: async (_url, init) => {
      calls++
      const body = z
        .object({
          messages: z.array(
            z.object({
              role: z.string(),
              content: z.union([
                z.string(),
                z.array(z.object({ type: z.literal('text'), text: z.string() }).strict()),
              ]),
            }),
          ),
        })
        .parse(JSON.parse(String(init?.body)))
      assert.equal(body.messages.length, 2)
      assert.ok(String(body.messages[0]?.content).includes('do not assume access to an image'))
      return new Response(
        JSON.stringify({
          model: 'fixture/text',
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify({ answers: { selection: { ranking: ['a'] } } }) },
            },
          ],
        }),
      )
    },
  })
  const result = await port.decide(request, new AbortController().signal)
  assert.equal(result.answers['selection']?.type, 'ranked-choice')
  assert.equal(result.metadata.costUsd, null)
  assert.equal(calls, 1)
  await assert.rejects(
    port.decide(
      {
        ...request,
        state: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,invalid', detail: 'high' },
          },
        ],
      },
      new AbortController().signal,
    ),
    { code: 'UNSUPPORTED' },
  )
  assert.equal(calls, 1)
})

await test('OpenRouter text wrapper preserves explicit route without fallback and rejects malformed answers', async () => {
  let calls = 0
  const port = createOpenRouterText({
    apiKey: 'fixture',
    model: 'fixture/text',
    provider: 'fixture',
    fetch: async (_url, init) => {
      calls++
      const body = z
        .object({
          provider: z.object({
            only: z.array(z.string()),
            allow_fallbacks: z.literal(false),
            require_parameters: z.literal(true),
          }),
        })
        .parse(JSON.parse(String(init?.body)))
      assert.deepEqual(body.provider.only, ['fixture'])
      return new Response(
        JSON.stringify({
          model: 'fixture/text',
          provider: 'fixture',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({ answers: { selection: { ranking: ['invented'] } } }),
              },
            },
          ],
        }),
      )
    },
  })
  await assert.rejects(port.decide(request, new AbortController().signal), {
    code: 'INVALID_RESPONSE',
  })
  assert.equal(calls, 1)
})
