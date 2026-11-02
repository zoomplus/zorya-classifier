import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { readJsonResponse } from './read-json.js'

const exchangeResponseSchema = z.object({
  key: z.string().min(1).max(8_192),
  user_id: z.string().min(1).max(256).nullable().optional(),
})

export interface OpenRouterPkceConfig {
  readonly callbackUrl: string
  readonly profileId: string
  readonly publicOrigin: string
  readonly stateTtlMs?: number
  readonly maxPendingStates?: number
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
}

interface PendingConnection {
  readonly ownerId: string
  readonly verifier: string
  readonly expiresAt: number
}

export interface OpenRouterPkceService {
  begin(ownerId: string): Response
  complete(input: { readonly ownerId: string; readonly request: Request }): Promise<Response>
}

function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

function same(left: string, right: string): boolean {
  const first = Buffer.from(left)
  const second = Buffer.from(right)
  return first.byteLength === second.byteLength && timingSafeEqual(first, second)
}

export function createOpenRouterPkceService(
  config: OpenRouterPkceConfig,
  saveCredential: (input: {
    readonly ownerId: string
    readonly profileId: string
    readonly apiKey: string
  }) => Promise<void>,
): OpenRouterPkceService {
  const callback = new URL(config.callbackUrl)
  const publicOrigin = new URL(config.publicOrigin)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)
  const stateTtlMs = config.stateTtlMs ?? 600_000
  const maxPendingStates = config.maxPendingStates ?? 512
  const timeoutMs = config.timeoutMs ?? 10_000
  if (
    publicOrigin.pathname !== '/' ||
    publicOrigin.search ||
    publicOrigin.hash ||
    publicOrigin.username ||
    publicOrigin.password ||
    callback.origin !== publicOrigin.origin ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    (callback.protocol !== 'https:' && !(loopback && callback.protocol === 'http:')) ||
    !Number.isInteger(stateTtlMs) ||
    stateTtlMs < 1_000 ||
    stateTtlMs > 3_600_000 ||
    !Number.isInteger(maxPendingStates) ||
    maxPendingStates < 1 ||
    maxPendingStates > 10_000 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60_000
  ) {
    throw new Error(
      'OpenRouter callback must be a fixed HTTPS URL on the configured application origin.',
    )
  }
  const requestFetch = config.fetch ?? fetch
  const pending = new Map<string, PendingConnection>()

  return {
    begin(ownerId) {
      if (ownerId.length < 1 || ownerId.length > 256)
        return new Response('Authentication is required.', { status: 401 })
      const now = Date.now()
      for (const [state, value] of pending) if (value.expiresAt <= now) pending.delete(state)
      if (pending.size >= maxPendingStates)
        return new Response('Connection capacity reached.', { status: 503 })
      const state = randomToken()
      const verifier = randomToken()
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      pending.set(state, { ownerId, verifier, expiresAt: now + stateTtlMs })
      const authorization = new URL('https://openrouter.ai/auth')
      authorization.searchParams.set('callback_url', callback.href)
      authorization.searchParams.set('code_challenge', challenge)
      authorization.searchParams.set('code_challenge_method', 'S256')
      authorization.searchParams.set('state', state)
      return new Response(null, {
        status: 302,
        headers: {
          location: authorization.href,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        },
      })
    },
    async complete({ ownerId, request }) {
      const url = new URL(request.url)
      const state = url.searchParams.get('state') ?? ''
      const code = url.searchParams.get('code') ?? ''
      const value = pending.get(state)
      if (
        !value ||
        value.expiresAt <= Date.now() ||
        !same(value.ownerId, ownerId) ||
        code.length < 1 ||
        code.length > 4_096
      ) {
        if (state) pending.delete(state)
        return new Response('OpenRouter connection could not be completed.', {
          status: 400,
          headers: { 'cache-control': 'no-store' },
        })
      }
      pending.delete(state)
      try {
        const response = await requestFetch('https://openrouter.ai/api/v1/auth/keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            code,
            code_verifier: value.verifier,
            code_challenge_method: 'S256',
          }),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        })
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error('OpenRouter key exchange failed.')
        }
        const data = await readJsonResponse(response, exchangeResponseSchema, 16 * 1024)
        await saveCredential({ ownerId, profileId: config.profileId, apiKey: data.key })
        return new Response(null, {
          status: 303,
          headers: {
            location: '/settings',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          },
        })
      } catch {
        return new Response('OpenRouter connection could not be completed.', {
          status: 502,
          headers: { 'cache-control': 'no-store' },
        })
      }
    },
  }
}
