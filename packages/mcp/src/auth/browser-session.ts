import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'
import { z } from 'zod'
import type { AuthenticatedPrincipal, OidcAuthenticator } from './oidc.js'
import { readJsonResponse, readResponseBytes } from './read-json.js'

const discoverySchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
})
const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  id_token: z.string().min(1).max(16_384),
  token_type: z.string(),
  expires_in: z.number().positive().max(86_400).optional(),
})

export interface BrowserSessionConfig {
  readonly issuer: string
  readonly clientId: string
  readonly redirectUri: string
  readonly publicOrigin: string
  readonly resource: string
  readonly scopes: readonly string[]
  readonly allowInsecureLoopbackCookies?: boolean
  readonly stateTtlMs?: number
  readonly sessionTtlMs?: number
  readonly maxPendingStates?: number
  readonly maxSessions?: number
  readonly timeoutMs?: number
}

interface PendingLogin {
  readonly verifier: string
  readonly nonce: string
  readonly cookieBinding: string
  readonly createdAt: number
  readonly returnTo: string
}

interface BrowserSession {
  readonly principal: AuthenticatedPrincipal
  readonly csrfToken: string
  readonly expiresAt: number
}

export interface BrowserLoginService {
  begin(returnTo?: string): Response
  complete(request: Request): Promise<Response>
  authenticate(request: Request): AuthenticatedPrincipal | undefined
  requireCsrf(request: Request): boolean
  clear(request: Request): Response
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0 || part.slice(0, separator).trim() !== name) continue
    return part.slice(separator + 1).trim()
  }
  return undefined
}

function cookie(
  name: string,
  value: string,
  options: { readonly httpOnly: boolean; readonly secure: boolean; readonly maxAge: number },
): string {
  return `${name}=${value}; Path=/; SameSite=Lax; Max-Age=${options.maxAge};${options.httpOnly ? ' HttpOnly;' : ''}${options.secure ? ' Secure;' : ''}`
}

function safeReturnTo(raw: string | undefined, publicOrigin: URL): string {
  if (raw === undefined) return '/viewer'
  if (raw.length > 2_048 || !raw.startsWith('/') || raw.startsWith('//'))
    throw new Error('Return path is not allowed.')
  const parsed = new URL(raw, publicOrigin)
  if (parsed.origin !== publicOrigin.origin || parsed.username || parsed.password)
    throw new Error('Return path is not allowed.')
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

function sameSiteOrigin(request: Request, publicOrigin: URL): boolean {
  const origin = request.headers.get('origin')
  if (origin === null) return false
  try {
    const parsed = new URL(origin)
    return parsed.origin === origin && parsed.origin === publicOrigin.origin
  } catch {
    return false
  }
}

export async function createBrowserLoginService(
  config: BrowserSessionConfig,
  authenticator: OidcAuthenticator,
): Promise<BrowserLoginService> {
  const issuerIdentity = config.issuer
  const issuer = new URL(issuerIdentity)
  const publicOrigin = new URL(config.publicOrigin)
  const redirectUri = new URL(config.redirectUri)
  const secure = publicOrigin.protocol === 'https:'
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(publicOrigin.hostname)
  if (
    publicOrigin.pathname !== '/' ||
    publicOrigin.search ||
    publicOrigin.hash ||
    publicOrigin.username ||
    publicOrigin.password ||
    (!secure && !(loopback && config.allowInsecureLoopbackCookies === true))
  )
    throw new Error('Browser login requires a valid HTTPS origin and secure cookies.')
  if (
    redirectUri.origin !== publicOrigin.origin ||
    redirectUri.username ||
    redirectUri.password ||
    redirectUri.search ||
    redirectUri.hash ||
    issuer.username ||
    issuer.password ||
    issuer.hash ||
    issuer.search ||
    (issuer.protocol !== 'https:' && !(loopback && issuer.protocol === 'http:'))
  ) {
    throw new Error('Browser login issuer and callback configuration is invalid.')
  }
  const timeoutMs = config.timeoutMs ?? 5_000
  const stateTtlMs = config.stateTtlMs ?? 300_000
  const sessionTtlMs = config.sessionTtlMs ?? 3_600_000
  const maxPendingStates = config.maxPendingStates ?? 256
  const maxSessions = config.maxSessions ?? 2_048
  if (
    !config.clientId ||
    config.clientId.length > 256 ||
    !config.resource ||
    config.resource.length > 2_048 ||
    config.scopes.length > 64 ||
    config.scopes.some((scope) => !/^[a-zA-Z0-9:._/-]{1,128}$/u.test(scope)) ||
    !Number.isInteger(stateTtlMs) ||
    stateTtlMs < 1_000 ||
    stateTtlMs > 3_600_000 ||
    !Number.isInteger(sessionTtlMs) ||
    sessionTtlMs < 1_000 ||
    sessionTtlMs > 86_400_000 ||
    !Number.isInteger(maxPendingStates) ||
    maxPendingStates < 1 ||
    maxPendingStates > 10_000 ||
    !Number.isInteger(maxSessions) ||
    maxSessions < 1 ||
    maxSessions > 100_000 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60_000
  ) {
    throw new Error('Browser login limits are invalid.')
  }
  const controller = new AbortController()
  const discoveryResponse = await fetch(
    new URL(`${issuer.href.replace(/\/$/u, '')}/.well-known/openid-configuration`),
    {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
      redirect: 'manual',
    },
  )
  if (!discoveryResponse.ok) {
    await discoveryResponse.body?.cancel()
    throw new Error('OIDC discovery failed.')
  }
  const discovery = await readJsonResponse(discoveryResponse, discoverySchema, 64 * 1024)
  if (discovery.issuer !== issuerIdentity) throw new Error('OIDC issuer mismatch.')
  const authorizationEndpoint = new URL(discovery.authorization_endpoint)
  const tokenEndpoint = new URL(discovery.token_endpoint)
  const jwksUrl = new URL(discovery.jwks_uri)
  if (
    [authorizationEndpoint, tokenEndpoint, jwksUrl].some(
      (url) =>
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        (url.protocol !== 'https:' &&
          !(loopback && url.protocol === 'http:' && url.hostname === publicOrigin.hostname)),
    )
  ) {
    throw new Error('OIDC endpoints must use HTTPS.')
  }
  const jwks = createRemoteJWKSet(jwksUrl, {
    timeoutDuration: timeoutMs,
    cacheMaxAge: 600_000,
    cooldownDuration: 30_000,
    [customFetch]: async (url, init) => {
      const signal = init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)
      const response = await fetch(url, { ...init, signal, redirect: 'manual' })
      if (!response.ok) {
        await response.body?.cancel()
        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      const bytes = await readResponseBytes(response, 512 * 1024)
      try {
        return new Response(Uint8Array.from(bytes), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      } finally {
        bytes.fill(0)
      }
    },
  })
  const stateCookie = secure ? '__Host-zorya-login' : 'zorya-login'
  const sessionCookie = secure ? '__Host-zorya-session' : 'zorya-session'
  const csrfCookie = secure ? '__Host-zorya-csrf' : 'zorya-csrf'
  const pending = new Map<string, PendingLogin>()
  const sessions = new Map<string, BrowserSession>()

  const prune = (): void => {
    const now = Date.now()
    for (const [state, value] of pending)
      if (value.createdAt + stateTtlMs <= now) pending.delete(state)
    for (const [token, value] of sessions) if (value.expiresAt <= now) sessions.delete(token)
  }

  return {
    begin(returnTo) {
      prune()
      if (pending.size >= maxPendingStates)
        return new Response('Login capacity reached.', { status: 503 })
      let destination: string
      try {
        destination = safeReturnTo(returnTo, publicOrigin)
      } catch {
        return new Response('Return path is not allowed.', { status: 400 })
      }
      const state = base64url(randomBytes(32))
      const verifier = base64url(randomBytes(32))
      const nonce = base64url(randomBytes(32))
      const cookieBinding = base64url(randomBytes(32))
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      pending.set(state, {
        verifier,
        nonce,
        cookieBinding,
        createdAt: Date.now(),
        returnTo: destination,
      })
      const authorization = new URL(authorizationEndpoint)
      authorization.searchParams.set('client_id', config.clientId)
      authorization.searchParams.set('response_type', 'code')
      authorization.searchParams.set('redirect_uri', redirectUri.href)
      authorization.searchParams.set('scope', ['openid', ...config.scopes].join(' '))
      authorization.searchParams.set('state', state)
      authorization.searchParams.set('nonce', nonce)
      authorization.searchParams.set('code_challenge', challenge)
      authorization.searchParams.set('code_challenge_method', 'S256')
      authorization.searchParams.set('resource', config.resource)
      return new Response(null, {
        status: 302,
        headers: {
          location: authorization.href,
          'cache-control': 'no-store',
          'set-cookie': cookie(stateCookie, cookieBinding, {
            httpOnly: true,
            secure,
            maxAge: Math.floor(stateTtlMs / 1_000),
          }),
        },
      })
    },
    async complete(request) {
      prune()
      const callback = new URL(request.url)
      const state = callback.searchParams.get('state') ?? ''
      const code = callback.searchParams.get('code') ?? ''
      const pendingLogin = pending.get(state)
      if (
        !pendingLogin ||
        pendingLogin.createdAt + stateTtlMs <= Date.now() ||
        !secureEqual(cookieValue(request, stateCookie) ?? '', pendingLogin.cookieBinding) ||
        code.length < 1 ||
        code.length > 4_096
      ) {
        if (state) pending.delete(state)
        return new Response('Login could not be completed.', {
          status: 400,
          headers: { 'cache-control': 'no-store' },
        })
      }
      pending.delete(state)
      const tokenController = new AbortController()
      const tokenResponse = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri.href,
          client_id: config.clientId,
          code_verifier: pendingLogin.verifier,
        }),
        signal: AbortSignal.any([tokenController.signal, AbortSignal.timeout(timeoutMs)]),
        redirect: 'manual',
      })
      if (!tokenResponse.ok) {
        await tokenResponse.body?.cancel()
        return new Response('Login could not be completed.', {
          status: 401,
          headers: { 'cache-control': 'no-store' },
        })
      }
      const tokens = await readJsonResponse(tokenResponse, tokenResponseSchema, 64 * 1024)
      if (tokens.token_type.toLowerCase() !== 'bearer')
        return new Response('Login could not be completed.', {
          status: 401,
          headers: { 'cache-control': 'no-store' },
        })
      let idToken: Awaited<ReturnType<typeof jwtVerify>>
      try {
        idToken = await jwtVerify(tokens.id_token, jwks, {
          issuer: issuerIdentity,
          audience: config.clientId,
          algorithms: ['RS256', 'ES256'],
          clockTolerance: 5,
        })
      } catch {
        return new Response('Login could not be completed.', {
          status: 401,
          headers: { 'cache-control': 'no-store' },
        })
      }
      const subject = idToken.payload.sub
      const audiences = Array.isArray(idToken.payload.aud)
        ? idToken.payload.aud
        : [idToken.payload.aud]
      if (
        typeof subject !== 'string' ||
        subject.length === 0 ||
        subject.length > 512 ||
        typeof idToken.payload.exp !== 'number' ||
        typeof idToken.payload.iat !== 'number' ||
        idToken.payload.iat > Math.floor(Date.now() / 1_000) + 5 ||
        idToken.payload['nonce'] !== pendingLogin.nonce ||
        (audiences.length > 1 && idToken.payload['azp'] !== config.clientId) ||
        (idToken.payload['azp'] !== undefined && idToken.payload['azp'] !== config.clientId)
      ) {
        return new Response('Login could not be completed.', {
          status: 401,
          headers: { 'cache-control': 'no-store' },
        })
      }
      const principal = await authenticator.authenticate(
        new Request(config.resource, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }),
      )
      if (
        !principal ||
        principal.identity.subject !== subject ||
        principal.identity.issuer !== issuerIdentity
      ) {
        return new Response('Login could not be completed.', {
          status: 401,
          headers: { 'cache-control': 'no-store' },
        })
      }
      prune()
      if (sessions.size >= maxSessions)
        return new Response('Session capacity reached.', { status: 503 })
      const sessionId = base64url(randomBytes(32))
      const csrfToken = base64url(randomBytes(32))
      const accessExpiresAt =
        principal.authInfo.expiresAt === undefined
          ? Date.now() + sessionTtlMs
          : principal.authInfo.expiresAt * 1_000
      const expiresAt = Math.min(accessExpiresAt, Date.now() + sessionTtlMs)
      sessions.set(sessionId, { principal, csrfToken, expiresAt })
      return new Response(null, {
        status: 303,
        headers: [
          ['location', pendingLogin.returnTo],
          ['cache-control', 'no-store'],
          [
            'set-cookie',
            cookie(sessionCookie, sessionId, {
              httpOnly: true,
              secure,
              maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1_000)),
            }),
          ],
          [
            'set-cookie',
            cookie(csrfCookie, csrfToken, {
              httpOnly: false,
              secure,
              maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1_000)),
            }),
          ],
          ['set-cookie', cookie(stateCookie, '', { httpOnly: true, secure, maxAge: 0 })],
        ],
      })
    },
    authenticate(request) {
      prune()
      const sessionId = cookieValue(request, sessionCookie)
      return sessionId ? sessions.get(sessionId)?.principal : undefined
    },
    requireCsrf(request) {
      if (!sameSiteOrigin(request, publicOrigin)) return false
      const sessionId = cookieValue(request, sessionCookie)
      const csrfCookieValue = cookieValue(request, csrfCookie)
      const csrfHeader = request.headers.get('x-zorya-csrf')
      const session = sessionId ? sessions.get(sessionId) : undefined
      return (
        session !== undefined &&
        session.expiresAt > Date.now() &&
        csrfCookieValue !== undefined &&
        csrfHeader !== null &&
        secureEqual(session.csrfToken, csrfCookieValue) &&
        secureEqual(session.csrfToken, csrfHeader)
      )
    },
    clear(request) {
      const sessionId = cookieValue(request, sessionCookie)
      if (sessionId) sessions.delete(sessionId)
      return new Response(null, {
        status: 303,
        headers: [
          ['location', '/'],
          ['cache-control', 'no-store'],
          ['set-cookie', cookie(sessionCookie, '', { httpOnly: true, secure, maxAge: 0 })],
          ['set-cookie', cookie(csrfCookie, '', { httpOnly: false, secure, maxAge: 0 })],
        ],
      })
    },
  }
}
