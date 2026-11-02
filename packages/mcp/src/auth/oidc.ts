import { createHash } from 'node:crypto'
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose'
import { z } from 'zod'
import type { VerifiedIdentity } from '../contracts.js'
import { readJsonResponse, readResponseBytes } from './read-json.js'

const discoverySchema = z.object({
  issuer: z.string().url(),
  jwks_uri: z.string().url(),
})

export interface OidcResourceConfig {
  readonly issuer: string
  readonly audience: string
  readonly resourceUrl: string
  readonly resourceMetadataUrl: string
  readonly requiredScopes: readonly string[]
  readonly allowedAlgorithms?: readonly string[]
  readonly timeoutMs?: number
}

export interface AuthenticatedPrincipal {
  readonly ownerId: string
  readonly identity: VerifiedIdentity
  readonly authInfo: {
    readonly token: string
    readonly clientId: string
    readonly scopes: string[]
    readonly expiresAt?: number
    readonly resource: URL
    readonly resourceMetadataUrl: string
  }
}

export interface OidcAuthenticator {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | undefined>
  challenge(): Response
}

function ownerIdFor(issuer: string, subject: string): string {
  const encoded = JSON.stringify([issuer, subject])
  return createHash('sha256').update(encoded).digest('hex')
}

function scopesFrom(payload: JWTPayload): string[] {
  const value = payload['scope'] ?? payload['scp']
  if (typeof value === 'string') return value.split(/\s+/u).filter(Boolean)
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value
  return []
}

function boundedFetch(timeoutMs: number) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
    return fetch(input, { ...init, signal, redirect: 'manual' })
  }
}

export async function createOidcAuthenticator(
  config: OidcResourceConfig,
): Promise<OidcAuthenticator> {
  const issuer = config.issuer
  const issuerUrl = new URL(issuer)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(issuerUrl.hostname)
  if (
    (issuerUrl.protocol !== 'https:' && !(loopback && issuerUrl.protocol === 'http:')) ||
    issuerUrl.username ||
    issuerUrl.password ||
    issuerUrl.hash ||
    issuerUrl.search
  ) {
    throw new Error('OIDC issuer must use HTTPS except for explicit loopback development.')
  }
  const timeoutMs = config.timeoutMs ?? 5_000
  const algorithms = [...(config.allowedAlgorithms ?? ['RS256', 'ES256'])]
  const supportedAlgorithms = new Set(['RS256', 'ES256', 'PS256', 'EdDSA'])
  if (
    algorithms.length === 0 ||
    algorithms.some((algorithm) => !supportedAlgorithms.has(algorithm))
  ) {
    throw new Error('OIDC signature algorithm allowlist is invalid.')
  }
  const discoveryUrl = new URL(`${issuer.replace(/\/+$/u, '')}/.well-known/openid-configuration`)
  const response = await boundedFetch(timeoutMs)(discoveryUrl)
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error('OIDC discovery failed.')
  }
  const discovery = await readJsonResponse(response, discoverySchema, 64 * 1024)
  if (discovery.issuer !== issuer) throw new Error('OIDC issuer mismatch.')
  const jwksUrl = new URL(discovery.jwks_uri)
  if (jwksUrl.username || jwksUrl.password || jwksUrl.hash)
    throw new Error('OIDC JWKS URL is invalid.')
  if (
    jwksUrl.protocol !== 'https:' &&
    !(
      jwksUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(jwksUrl.hostname)
    )
  ) {
    throw new Error('OIDC JWKS endpoint must use HTTPS.')
  }
  const fetcher = boundedFetch(timeoutMs)
  const remoteJwks = createRemoteJWKSet(jwksUrl, {
    timeoutDuration: timeoutMs,
    cacheMaxAge: 10 * 60_000,
    cooldownDuration: 30_000,
    [customFetch]: async (url, init) => {
      const jwksResponse = await fetcher(url, init)
      if (!jwksResponse.ok) {
        await jwksResponse.body?.cancel()
        return new Response(null, {
          status: jwksResponse.status,
          statusText: jwksResponse.statusText,
          headers: jwksResponse.headers,
        })
      }
      const bytes = await readResponseBytes(jwksResponse, 512 * 1024)
      try {
        return new Response(Uint8Array.from(bytes), {
          status: jwksResponse.status,
          statusText: jwksResponse.statusText,
          headers: jwksResponse.headers,
        })
      } finally {
        bytes.fill(0)
      }
    },
  })
  const resource = new URL(config.resourceUrl)
  const resourceMetadata = new URL(config.resourceMetadataUrl)
  const resourceIsLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(resource.hostname)
  if (
    resource.username ||
    resource.password ||
    resource.hash ||
    (resource.protocol !== 'https:' && !(resourceIsLoopback && resource.protocol === 'http:')) ||
    resourceMetadata.username ||
    resourceMetadata.password ||
    resourceMetadata.hash ||
    (resourceMetadata.protocol !== 'https:' &&
      !(
        ['localhost', '127.0.0.1', '[::1]'].includes(resourceMetadata.hostname) &&
        resourceMetadata.protocol === 'http:'
      ))
  )
    throw new Error('MCP resource URL is invalid.')
  const resourceMetadataUrl = resourceMetadata.href

  return {
    async authenticate(request) {
      const header = request.headers.get('authorization')
      if (!header?.startsWith('Bearer ')) return undefined
      const token = header.slice('Bearer '.length)
      if (token.length === 0 || token.length > 16_384) return undefined
      try {
        const verified = await jwtVerify(token, remoteJwks, {
          issuer,
          audience: config.audience,
          algorithms,
          clockTolerance: 5,
        })
        const subject = verified.payload.sub
        if (
          typeof subject !== 'string' ||
          subject.length === 0 ||
          subject.length > 512 ||
          typeof verified.payload.exp !== 'number'
        )
          return undefined
        const scopes = scopesFrom(verified.payload)
        if (!config.requiredScopes.every((scope) => scopes.includes(scope))) return undefined
        const clientId =
          typeof verified.payload['client_id'] === 'string'
            ? verified.payload['client_id']
            : typeof verified.payload['azp'] === 'string'
              ? verified.payload['azp']
              : 'unknown-client'
        const identity = { issuer, subject, scopes }
        return {
          ownerId: ownerIdFor(issuer, subject),
          identity,
          authInfo: {
            token,
            clientId,
            scopes,
            ...(verified.payload.exp === undefined ? {} : { expiresAt: verified.payload.exp }),
            resource,
            resourceMetadataUrl,
          },
        }
      } catch {
        return undefined
      }
    },
    challenge() {
      return new Response(null, {
        status: 401,
        headers: {
          'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
          'Cache-Control': 'no-store',
        },
      })
    },
  }
}
