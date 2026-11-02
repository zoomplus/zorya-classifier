import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { z } from 'zod'
import { createOpenRouterPkceService } from '../../src/auth/openrouter-pkce.js'

const exchangeSchema = z.object({
  code: z.string().optional(),
  code_verifier: z.string().optional(),
  code_challenge_method: z.string().optional(),
})

let expectedChallenge = ''

await test('OpenRouter BYOK PKCE is bound to the verified application owner and stores the key privately', async () => {
  let exchanges = 0
  const saved: Array<{ ownerId: string; profileId: string; apiKey: string }> = []
  const service = createOpenRouterPkceService(
    {
      callbackUrl: 'https://mcp.example.test/settings/openrouter/callback',
      publicOrigin: 'https://mcp.example.test',
      profileId: 'openrouter-primary',
      fetch: async (input, init) => {
        exchanges += 1
        assert.equal(String(input), 'https://openrouter.ai/api/v1/auth/keys')
        assert.equal(init?.method, 'POST')
        assert.equal(new Headers(init?.headers).has('authorization'), false)
        const raw: unknown = JSON.parse(String(init?.body))
        const body = exchangeSchema.parse(raw)
        assert.equal(body.code, 'fake-one-time-code')
        assert.equal(body.code_challenge_method, 'S256')
        assert.equal(
          createHash('sha256')
            .update(body.code_verifier ?? '')
            .digest('base64url'),
          expectedChallenge,
        )
        return Response.json({ key: 'example-openrouter-api-key', user_id: 'fake-provider-user' })
      },
    },
    async (entry) => {
      saved.push(entry)
    },
  )
  const start = service.begin('verified-owner-a')
  const authorization = new URL(start.headers.get('location') ?? '')
  assert.equal(authorization.origin, 'https://openrouter.ai')
  assert.equal(authorization.pathname, '/auth')
  assert.equal(
    authorization.searchParams.get('callback_url'),
    'https://mcp.example.test/settings/openrouter/callback',
  )
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(authorization.searchParams.get('code_challenge'))
  const state = authorization.searchParams.get('state') ?? ''
  expectedChallenge = authorization.searchParams.get('code_challenge') ?? ''
  const callbackUrl = `https://mcp.example.test/settings/openrouter/callback?code=fake-one-time-code&state=${encodeURIComponent(state)}`
  const wrongOwner = await service.complete({
    ownerId: 'verified-owner-b',
    request: new Request(callbackUrl),
  })
  assert.equal(wrongOwner.status, 400)
  assert.equal(exchanges, 0)
  const completed = await service.complete({
    ownerId: 'verified-owner-a',
    request: new Request(callbackUrl),
  })
  assert.equal(completed.status, 400)
  assert.equal(exchanges, 0)
})

await test('OpenRouter PKCE successful callback stores an owner-bound fake key and never returns it', async () => {
  let expectedChallenge = ''
  let saved: { ownerId: string; profileId: string; apiKey: string } | undefined
  const service = createOpenRouterPkceService(
    {
      callbackUrl: 'https://mcp.example.test/settings/openrouter/callback',
      publicOrigin: 'https://mcp.example.test',
      profileId: 'openrouter-primary',
      fetch: async (_input, init) => {
        const raw: unknown = JSON.parse(String(init?.body))
        const body = exchangeSchema.parse(raw)
        assert.equal(
          createHash('sha256')
            .update(body.code_verifier ?? '')
            .digest('base64url'),
          expectedChallenge,
        )
        return Response.json({ key: 'example-openrouter-api-key', user_id: 'fake-provider-user' })
      },
    },
    async (entry) => {
      saved = entry
    },
  )
  const start = service.begin('verified-owner-a')
  const authorization = new URL(start.headers.get('location') ?? '')
  expectedChallenge = authorization.searchParams.get('code_challenge') ?? ''
  const state = authorization.searchParams.get('state') ?? ''
  const callbackUrl = `https://mcp.example.test/settings/openrouter/callback?code=fake-one-time-code&state=${encodeURIComponent(state)}`
  const response = await service.complete({
    ownerId: 'verified-owner-a',
    request: new Request(callbackUrl),
  })
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/settings')
  assert.doesNotMatch(await response.text(), /example-openrouter-api-key/u)
  assert.deepEqual(saved, {
    ownerId: 'verified-owner-a',
    profileId: 'openrouter-primary',
    apiKey: 'example-openrouter-api-key',
  })
  assert.equal(
    (await service.complete({ ownerId: 'verified-owner-a', request: new Request(callbackUrl) }))
      .status,
    400,
  )
})
