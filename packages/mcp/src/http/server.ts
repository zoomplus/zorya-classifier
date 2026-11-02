import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createMcpHandler, type AuthInfo, type McpServer } from '@modelcontextprotocol/server'
import { toWebRequest } from '@modelcontextprotocol/node'
import { SSEServerTransport } from '@modelcontextprotocol/server-legacy/sse'
import { z } from 'zod'
import type { Principal } from '../contracts.js'
import { McpCoreError } from '../errors.js'
import {
  createPrivateArtifactStore,
  type PrivateArtifactStore,
} from '../media/private-artifact-store.js'
import { inspectImageBytes } from '../media/remote-image.js'
import type { AuthenticatedPrincipal, OidcAuthenticator } from '../auth/oidc.js'
import type { BrowserLoginService } from '../auth/browser-session.js'
import type { OpenRouterPkceService } from '../auth/openrouter-pkce.js'
import type { HttpConfig } from './config.js'
import {
  renderViewerDocument,
  viewerDocumentOwnedBy,
  type ViewerArtifactReader,
  type ViewerDocumentReader,
} from '../viewer/document.js'
import { renderSettingsPage } from '../viewer/settings.js'

export interface HttpServerDependencies {
  readonly config: HttpConfig
  readonly authenticator: OidcAuthenticator
  readonly browserLogin?: BrowserLoginService
  readonly readViewerDocument?: ViewerDocumentReader
  readonly readViewerArtifact?: ViewerArtifactReader
  readonly saveProviderCredential?: (input: {
    readonly ownerId: string
    readonly profileId: string
    readonly apiKey: string
  }) => Promise<void>
  readonly removeProviderCredential?: (input: {
    readonly ownerId: string
    readonly profileId: string
  }) => Promise<void>
  readonly openRouterPkce?: OpenRouterPkceService
  readonly artifactStore?: PrivateArtifactStore
  readonly createServerForPrincipal: (principal: Principal) => McpServer
}

interface LegacySession {
  readonly ownerId: string
  readonly transport: SSEServerTransport
  readonly server: McpServer
  readonly expiresAt: number
}

function safeResponse(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent || response.destroyed) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  })
  response.end(JSON.stringify({ error: message }))
}

function createBodyReadGate(maxConcurrent: number) {
  let active = 0
  return {
    acquire(request: IncomingMessage, response: ServerResponse): (() => Promise<void>) | undefined {
      if (active >= maxConcurrent) {
        response.setHeader('connection', 'close')
        safeResponse(response, 503, 'Request body capacity is unavailable.')
        request.resume()
        return undefined
      }
      active += 1
      let released = false
      return async () => {
        if (released) return
        released = true
        if (!request.complete) {
          const closed = request.closed
            ? Promise.resolve()
            : new Promise<void>((resolve) => request.once('close', resolve))
          request.resume()
          await closed
        }
        active -= 1
      }
    },
  }
}

function noStoreResponse(
  status: number,
  body: string | Uint8Array,
  mediaType: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': mediaType,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      ...extra,
    },
  })
}

function hostAllowed(hostHeader: string | undefined, allowedHosts: readonly string[]): boolean {
  if (!hostHeader) return false
  let hostname: string
  try {
    const parsed = new URL(`http://${hostHeader}`)
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.host.toLowerCase() !== hostHeader.toLowerCase()
    )
      return false
    hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  } catch {
    return false
  }
  return allowedHosts.some((configured) => {
    const allowed = configured
      .toLowerCase()
      .replace(/^\*\./u, '')
      .replace(/^\[|\]$/gu, '')
    return hostname === allowed || (configured.startsWith('*.') && hostname.endsWith(`.${allowed}`))
  })
}

function originAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (origin === undefined) return true
  try {
    const parsed = new URL(origin)
    return (
      parsed.origin === origin &&
      allowedOrigins.some((allowed) => new URL(allowed).origin === parsed.origin)
    )
  } catch {
    return false
  }
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }
  return headers
}

function authInfoFor(value: AuthenticatedPrincipal): AuthInfo {
  return {
    ...value.authInfo,
    extra: {
      ownerId: value.ownerId,
      issuer: value.identity.issuer,
      subject: value.identity.subject,
    },
  }
}

function principalFromAuthInfo(authInfo: AuthInfo | undefined): Principal | undefined {
  const extra = authInfo?.extra
  if (!extra) return undefined
  const ownerId = extra['ownerId']
  const issuer = extra['issuer']
  const subject = extra['subject']
  if (typeof ownerId !== 'string' || typeof issuer !== 'string' || typeof subject !== 'string')
    return undefined
  return {
    ownerId,
    transport: 'http',
    identity: { issuer, subject, scopes: [...(authInfo?.scopes ?? [])] },
  }
}

async function writeWebResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = Object.fromEntries(response.headers.entries())
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) headers['set-cookie'] = cookies
  outgoing.writeHead(response.status, headers)
  if (!response.body) {
    outgoing.end()
    return
  }
  await pipeline(Readable.fromWeb(response.body), outgoing)
}

async function readBoundedJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    let bytes: Buffer
    if (Buffer.isBuffer(chunk)) bytes = Buffer.from(chunk)
    else if (typeof chunk === 'string') bytes = Buffer.from(chunk)
    else if (chunk instanceof Uint8Array) bytes = Buffer.from(chunk)
    else throw new Error('Request body contains an invalid chunk.')
    size += bytes.byteLength
    if (size > maxBytes) {
      request.resume()
      bytes.fill(0)
      for (const chunkBytes of chunks) chunkBytes.fill(0)
      throw new RangeError('request_body_too_large')
    }
    chunks.push(bytes)
  }
  const raw = Buffer.concat(chunks, size)
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    return parsed
  } finally {
    raw.fill(0)
    for (const chunk of chunks) chunk.fill(0)
  }
}

async function readBoundedBytes(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    let bytes: Buffer
    if (Buffer.isBuffer(chunk)) bytes = chunk
    else if (typeof chunk === 'string') bytes = Buffer.from(chunk)
    else if (chunk instanceof Uint8Array) bytes = Buffer.from(chunk)
    else throw new Error('Request body contains an invalid chunk.')
    size += bytes.byteLength
    if (size > maxBytes) {
      request.resume()
      bytes.fill(0)
      for (const chunkBytes of chunks) chunkBytes.fill(0)
      throw new RangeError('request_body_too_large')
    }
    chunks.push(bytes)
  }
  const body = Buffer.concat(chunks, size)
  for (const chunk of chunks) chunk.fill(0)
  return body
}

function metadataResponse(config: HttpConfig): Response {
  const payload = {
    resource: new URL(config.resourceUrl).href,
    authorization_servers: [new URL(config.issuer).href],
    bearer_methods_supported: ['header'],
    scopes_supported: [...config.requiredScopes],
  }
  return Response.json(payload, {
    headers: {
      'cache-control': 'public, max-age=300',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
    },
  })
}

function metadataPath(config: HttpConfig): string {
  const resourcePath = new URL(config.resourceUrl).pathname.replace(/^\//u, '')
  return resourcePath.length === 0
    ? '/.well-known/oauth-protected-resource'
    : `/.well-known/oauth-protected-resource/${resourcePath}`
}

function mcpErrorResponse(error: unknown, outgoing: ServerResponse): void {
  if (
    (error instanceof RangeError && error.message === 'request_body_too_large') ||
    (typeof error === 'object' && error !== null && 'status' in error && error.status === 413)
  ) {
    safeResponse(outgoing, 413, 'Request body exceeds the configured limit.')
    return
  }
  if (error instanceof McpCoreError) {
    const status =
      error.code === 'CAPACITY_LIMIT'
        ? 503
        : error.code === 'NOT_FOUND'
          ? 404
          : error.code === 'FORBIDDEN'
            ? 403
            : error.code === 'TIMEOUT'
              ? 408
              : error.code === 'RESOURCE_LIMIT'
                ? 413
                : 400
    safeResponse(outgoing, status, error.message)
    return
  }
  safeResponse(outgoing, 400, 'Request could not be processed.')
}

export interface RunningHttpServer {
  readonly server: Server
  readonly address: ReturnType<Server['address']>
  readonly artifactStore: PrivateArtifactStore
  shutdown(): Promise<void>
}

/** Creates the authenticated HTTP transport; the caller owns the shared application lifecycle. */
export function createHttpServer(dependencies: HttpServerDependencies): RunningHttpServer {
  const { config, authenticator, createServerForPrincipal } = dependencies
  const artifactStore =
    dependencies.artifactStore ??
    createPrivateArtifactStore({ maxArtifactBytes: config.maxUploadBytes })
  const ownsArtifactStore = dependencies.artifactStore === undefined
  let activeUploads = 0
  const bodyReadGate = createBodyReadGate(config.maxConcurrentBodyReads)
  const modernHandler = createMcpHandler(
    (context) => {
      const principal = principalFromAuthInfo(context.authInfo)
      if (!principal) throw new Error('authenticated_principal_required')
      return createServerForPrincipal(principal)
    },
    {
      legacy: 'stateless',
      maxRequestBodySize: config.maxRequestBodyBytes,
      keepAliveMs: 15_000,
      maxSubscriptions: config.maxLegacySessions,
      onerror: () => undefined,
    },
  )
  const legacySessions = new Map<string, LegacySession>()
  const sessionClosePromises = new WeakMap<McpServer, Promise<void>>()
  const pendingSessionClosures = new Set<Promise<void>>()
  const pendingSessionServerCloses = new Set<McpServer>()
  let sessionCleanupFailed = false
  const closeSessionServer = (mcpServer: McpServer): Promise<void> => {
    const existing = sessionClosePromises.get(mcpServer)
    if (existing) return existing
    const closing = mcpServer.close()
    const tracked = closing.then(
      () => {
        pendingSessionClosures.delete(tracked)
      },
      () => {
        pendingSessionClosures.delete(tracked)
        sessionCleanupFailed = true
      },
    )
    sessionClosePromises.set(mcpServer, tracked)
    pendingSessionClosures.add(tracked)
    return tracked
  }
  const scheduleSessionServerClose = (mcpServer: McpServer): void => {
    pendingSessionServerCloses.add(mcpServer)
    queueMicrotask(() => {
      pendingSessionServerCloses.delete(mcpServer)
      pendingSessionClosures.add(closeSessionServer(mcpServer))
    })
  }
  const expireLegacySessions = async (): Promise<void> => {
    const now = Date.now()
    const failures: unknown[] = []
    for (const [id, session] of legacySessions) {
      if (session.expiresAt > now) continue
      legacySessions.delete(id)
      try {
        await session.transport.close()
      } catch (error) {
        failures.push(error)
      }
      try {
        await closeSessionServer(session.server)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new Error('Expired MCP sessions could not be closed cleanly.')
  }
  const sessionExpiryTimer = setInterval(
    () => {
      void expireLegacySessions().catch(() => {
        sessionCleanupFailed = true
      })
    },
    Math.min(10_000, config.legacySessionTtlMs),
  )
  sessionExpiryTimer.unref()

  let draining = false
  const activeRoutes = new Set<Promise<void>>()
  let shutdownPromise: Promise<void> | undefined
  const server = createServer((request, response) => {
    if (draining) {
      response.setHeader('connection', 'close')
      safeResponse(response, 503, 'HTTP server is shutting down.')
      request.resume()
      return
    }
    const route = (async () => {
      const parsedUrl = new URL(request.url ?? '/', config.publicOrigin)
      if (!hostAllowed(request.headers.host, config.allowedHosts)) {
        safeResponse(response, 403, 'Host is not allowed.')
        return
      }
      if (!originAllowed(request.headers.origin, config.allowedOrigins)) {
        safeResponse(response, 403, 'Origin is not allowed.')
        return
      }
      if (request.method === 'GET' && parsedUrl.pathname === metadataPath(config)) {
        await writeWebResponse(metadataResponse(config), response)
        return
      }
      const authRequest = new Request(
        new URL(parsedUrl.pathname + parsedUrl.search, config.publicOrigin),
        {
          method: 'GET',
          headers: requestHeaders(request),
        },
      )
      if (request.method === 'GET' && parsedUrl.pathname === config.loginPath) {
        if (!dependencies.browserLogin) {
          safeResponse(response, 404, 'Browser login is not configured.')
          return
        }
        await writeWebResponse(
          dependencies.browserLogin.begin(parsedUrl.searchParams.get('returnTo') ?? undefined),
          response,
        )
        return
      }
      if (request.method === 'GET' && parsedUrl.pathname === config.loginCallbackPath) {
        if (!dependencies.browserLogin) {
          safeResponse(response, 404, 'Browser login is not configured.')
          return
        }
        const callbackRequest = new Request(
          new URL(parsedUrl.pathname + parsedUrl.search, config.publicOrigin),
          { headers: requestHeaders(request) },
        )
        await writeWebResponse(await dependencies.browserLogin.complete(callbackRequest), response)
        return
      }
      if (request.method === 'POST' && parsedUrl.pathname === config.logoutPath) {
        if (!dependencies.browserLogin || !dependencies.browserLogin.requireCsrf(authRequest)) {
          safeResponse(response, 403, 'Browser request could not be verified.')
          return
        }
        await writeWebResponse(dependencies.browserLogin.clear(authRequest), response)
        return
      }
      if (request.method === 'POST' && parsedUrl.pathname === config.uploadPath) {
        const contentType = request.headers['content-type']
        const uploadMediaType =
          typeof contentType === 'string'
            ? contentType.split(';', 1)[0]?.trim().toLowerCase()
            : undefined
        if (
          !uploadMediaType ||
          !['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'].includes(
            uploadMediaType,
          )
        ) {
          safeResponse(response, 415, 'Image upload media type is not supported.')
          return
        }
        const browserPrincipal = dependencies.browserLogin?.authenticate(authRequest)
        const bearerPrincipal = request.headers.authorization?.startsWith('Bearer ')
          ? await authenticator.authenticate(authRequest)
          : undefined
        const authenticatedUpload = bearerPrincipal ?? browserPrincipal
        if (!authenticatedUpload) {
          await writeWebResponse(authenticator.challenge(), response)
          return
        }
        if (
          browserPrincipal &&
          !bearerPrincipal &&
          !dependencies.browserLogin?.requireCsrf(authRequest)
        ) {
          safeResponse(response, 403, 'Browser request could not be verified.')
          return
        }
        const contentLength = Number(request.headers['content-length'])
        if (Number.isFinite(contentLength) && contentLength > config.maxUploadBytes) {
          safeResponse(response, 413, 'Image upload exceeds the configured limit.')
          request.resume()
          return
        }
        const releaseBodyRead = bodyReadGate.acquire(request, response)
        if (!releaseBodyRead) return
        if (activeUploads >= config.maxConcurrentUploads) {
          safeResponse(response, 503, 'Image upload capacity is unavailable.')
          await releaseBodyRead()
          return
        }
        activeUploads += 1
        const uploadController = new AbortController()
        const abortUpload = (): void => uploadController.abort()
        request.once('aborted', abortUpload)
        try {
          const body = await readBoundedBytes(request, config.maxUploadBytes)
          let checked: Awaited<ReturnType<typeof inspectImageBytes>>
          try {
            checked = await inspectImageBytes(body, contentType, 16_777_216)
          } finally {
            body.fill(0)
          }
          if (uploadController.signal.aborted)
            throw new McpCoreError('CANCELLED', 'Image upload was cancelled.', true)
          try {
            const descriptor = await artifactStore.putUpload({
              ownerId: authenticatedUpload.ownerId,
              bytes: checked.bytes,
              mediaType: checked.mediaType,
              signal: uploadController.signal,
              deadlineAt: Date.now() + config.requestTimeoutMs,
            })
            const responseBody = JSON.stringify({
              id: descriptor.id,
              mediaType: descriptor.mediaType,
              byteLength: descriptor.byteLength,
              width: checked.width,
              height: checked.height,
              expiresAt: descriptor.expiresAt,
            })
            response.writeHead(201, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
              'content-length': Buffer.byteLength(responseBody),
            })
            response.end(responseBody)
          } finally {
            checked.bytes.fill(0)
          }
        } finally {
          request.removeListener('aborted', abortUpload)
          activeUploads -= 1
          await releaseBodyRead()
        }
        return
      }
      if (request.method === 'POST' && parsedUrl.pathname === config.openRouterConnectPath) {
        const browserPrincipal = dependencies.browserLogin?.authenticate(authRequest)
        if (!browserPrincipal || !dependencies.browserLogin?.requireCsrf(authRequest)) {
          safeResponse(response, 403, 'Browser request could not be verified.')
          return
        }
        if (!dependencies.openRouterPkce) {
          safeResponse(response, 404, 'OpenRouter connection is not configured.')
          return
        }
        const begin = dependencies.openRouterPkce.begin(browserPrincipal.ownerId)
        const location = begin.headers.get('location')
        if (begin.status !== 302 || !location) {
          await begin.body?.cancel()
          safeResponse(
            response,
            begin.status === 503 ? 503 : 502,
            'OpenRouter connection could not be started.',
          )
          return
        }
        let authorizationUrl: URL
        try {
          authorizationUrl = new URL(location)
        } catch {
          safeResponse(response, 502, 'OpenRouter connection could not be started.')
          return
        }
        if (
          authorizationUrl.origin !== 'https://openrouter.ai' ||
          authorizationUrl.pathname !== '/auth' ||
          authorizationUrl.username ||
          authorizationUrl.password ||
          authorizationUrl.hash
        ) {
          safeResponse(response, 502, 'OpenRouter connection could not be started.')
          return
        }
        await writeWebResponse(
          Response.json(
            { authorizationUrl: authorizationUrl.href },
            {
              headers: {
                'cache-control': 'no-store',
                'referrer-policy': 'no-referrer',
                'x-content-type-options': 'nosniff',
              },
            },
          ),
          response,
        )
        return
      }
      if (request.method === 'GET' && parsedUrl.pathname === config.openRouterCallbackPath) {
        const browserPrincipal = dependencies.browserLogin?.authenticate(authRequest)
        if (!browserPrincipal || !dependencies.openRouterPkce) {
          safeResponse(response, 401, 'Authentication is required.')
          return
        }
        const callbackRequest = new Request(
          new URL(parsedUrl.pathname + parsedUrl.search, config.publicOrigin),
          { headers: requestHeaders(request) },
        )
        await writeWebResponse(
          await dependencies.openRouterPkce.complete({
            ownerId: browserPrincipal.ownerId,
            request: callbackRequest,
          }),
          response,
        )
        return
      }
      if (
        (request.method === 'POST' || request.method === 'DELETE') &&
        parsedUrl.pathname === config.credentialPath
      ) {
        if (!dependencies.browserLogin || !dependencies.browserLogin.requireCsrf(authRequest)) {
          safeResponse(response, 403, 'Browser request could not be verified.')
          return
        }
        const credentialOwner = dependencies.browserLogin.authenticate(authRequest)?.ownerId
        if (!credentialOwner) {
          safeResponse(response, 401, 'Authentication is required.')
          return
        }
        const contentType = request.headers['content-type']
        if (
          typeof contentType !== 'string' ||
          !/^application\/json(?:\s*;|$)/iu.test(contentType)
        ) {
          safeResponse(response, 415, 'Provider credential request must use JSON.')
          return
        }
        const releaseBodyRead = bodyReadGate.acquire(request, response)
        if (!releaseBodyRead) return
        try {
          const body = await readBoundedJson(request, 16 * 1024)
          if (request.method === 'POST') {
            const parsed = z
              .strictObject({
                profileId: z.string().min(1).max(64),
                apiKey: z.string().min(1).max(8_192),
              })
              .safeParse(body)
            if (!parsed.success || !config.credentialProfileIds.includes(parsed.data.profileId)) {
              safeResponse(response, 400, 'Provider credential request is invalid.')
              return
            }
            if (!dependencies.saveProviderCredential) {
              safeResponse(response, 404, 'Provider credential storage is not configured.')
              return
            }
            await dependencies.saveProviderCredential({
              ownerId: credentialOwner,
              profileId: parsed.data.profileId,
              apiKey: parsed.data.apiKey,
            })
          } else {
            const parsed = z.strictObject({ profileId: z.string().min(1).max(64) }).safeParse(body)
            if (!parsed.success || !config.credentialProfileIds.includes(parsed.data.profileId)) {
              safeResponse(response, 400, 'Provider credential request is invalid.')
              return
            }
            if (!dependencies.removeProviderCredential) {
              safeResponse(response, 404, 'Provider credential storage is not configured.')
              return
            }
            await dependencies.removeProviderCredential({
              ownerId: credentialOwner,
              profileId: parsed.data.profileId,
            })
          }
          response.writeHead(204, { 'cache-control': 'no-store', 'content-length': '0' })
          response.end()
        } finally {
          await releaseBodyRead()
        }
        return
      }
      if (
        parsedUrl.pathname !== config.mcpPath &&
        parsedUrl.pathname !== config.legacySsePath &&
        parsedUrl.pathname !== config.legacyMessagesPath
      ) {
        const isViewer =
          parsedUrl.pathname.startsWith(`${config.viewerPath}/`) ||
          parsedUrl.pathname.startsWith(`${config.artifactPath}/`)
        if (!isViewer && parsedUrl.pathname !== config.settingsPath) {
          safeResponse(response, 404, 'Route not found.')
          return
        }
      }
      const bearer = request.headers.authorization?.startsWith('Bearer ')
        ? await authenticator.authenticate(authRequest)
        : undefined
      const browserPrincipal = dependencies.browserLogin?.authenticate(authRequest)
      const authenticated = bearer ?? browserPrincipal
      if (!authenticated) {
        if (request.headers.authorization?.startsWith('Bearer '))
          await writeWebResponse(authenticator.challenge(), response)
        else await writeWebResponse(authenticator.challenge(), response)
        return
      }
      if (
        !bearer &&
        browserPrincipal &&
        (request.method === 'POST' || request.method === 'DELETE') &&
        (parsedUrl.pathname === config.mcpPath ||
          parsedUrl.pathname === config.legacyMessagesPath) &&
        !dependencies.browserLogin?.requireCsrf(authRequest)
      ) {
        safeResponse(response, 403, 'Browser request could not be verified.')
        return
      }
      const principal: Principal = {
        ownerId: authenticated.ownerId,
        transport: 'http',
        identity: authenticated.identity,
      }

      if (parsedUrl.pathname === config.settingsPath && request.method === 'GET') {
        await writeWebResponse(
          renderSettingsPage(config, dependencies.openRouterPkce !== undefined),
          response,
        )
        return
      }

      if (parsedUrl.pathname.startsWith(`${config.viewerPath}/`) && request.method === 'GET') {
        if (!dependencies.readViewerDocument) {
          safeResponse(response, 404, 'Viewer is not configured.')
          return
        }
        const jobId = decodeURIComponent(parsedUrl.pathname.slice(config.viewerPath.length + 1))
        if (!/^[a-zA-Z0-9._-]{1,256}$/u.test(jobId)) {
          safeResponse(response, 404, 'Viewer document not found.')
          return
        }
        const controller = new AbortController()
        const abortViewer = (): void => controller.abort()
        request.once('aborted', abortViewer)
        try {
          const document = await dependencies.readViewerDocument({
            principal,
            jobId,
            signal: controller.signal,
            deadlineAt: Date.now() + 30_000,
          })
          if (!document || !viewerDocumentOwnedBy(document, principal)) {
            await writeWebResponse(
              noStoreResponse(404, 'Viewer document not found.', 'text/plain; charset=utf-8'),
              response,
            )
            return
          }
          await writeWebResponse(renderViewerDocument(document, config.artifactPath), response)
        } finally {
          request.removeListener('aborted', abortViewer)
        }
        return
      }

      if (parsedUrl.pathname.startsWith(`${config.artifactPath}/`) && request.method === 'GET') {
        const artifactId = decodeURIComponent(
          parsedUrl.pathname.slice(config.artifactPath.length + 1),
        )
        if (!/^[a-zA-Z0-9_-]{1,256}$/u.test(artifactId)) {
          safeResponse(response, 404, 'Artifact not found.')
          return
        }
        const controller = new AbortController()
        const abortArtifact = (): void => controller.abort()
        request.once('aborted', abortArtifact)
        try {
          const artifact = dependencies.readViewerArtifact
            ? await dependencies.readViewerArtifact({
                principal,
                artifactId,
                signal: controller.signal,
                deadlineAt: Date.now() + 30_000,
                maxBytes: config.maxViewerArtifactBytes,
              })
            : await artifactStore.read({
                ownerId: principal.ownerId,
                artifactId,
                signal: controller.signal,
                deadlineAt: Date.now() + 30_000,
                maxBytes: config.maxViewerArtifactBytes,
              })
          if (!artifact) {
            await writeWebResponse(
              noStoreResponse(404, 'Artifact not found.', 'text/plain; charset=utf-8'),
              response,
            )
            return
          }
          try {
            if (
              artifact.bytes.byteLength > config.maxViewerArtifactBytes ||
              !['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'].includes(
                artifact.mediaType,
              )
            ) {
              await writeWebResponse(
                noStoreResponse(404, 'Artifact not found.', 'text/plain; charset=utf-8'),
                response,
              )
              return
            }
            await writeWebResponse(
              noStoreResponse(200, Uint8Array.from(artifact.bytes), artifact.mediaType, {
                'content-disposition': 'inline',
              }),
              response,
            )
          } finally {
            artifact.bytes.fill(0)
          }
        } finally {
          request.removeListener('aborted', abortArtifact)
        }
        return
      }

      if (parsedUrl.pathname === config.legacySsePath && request.method === 'GET') {
        await expireLegacySessions()
        if (legacySessions.size >= config.maxLegacySessions) {
          safeResponse(response, 503, 'Legacy session capacity reached.')
          return
        }
        const mcpServer = createServerForPrincipal(principal)
        const transport = new SSEServerTransport(config.legacyMessagesPath, response)
        const session: LegacySession = {
          ownerId: principal.ownerId,
          transport,
          server: mcpServer,
          expiresAt: Date.now() + config.legacySessionTtlMs,
        }
        legacySessions.set(transport.sessionId, session)
        transport.onclose = () => {
          legacySessions.delete(transport.sessionId)
          scheduleSessionServerClose(mcpServer)
        }
        response.once('close', () => {
          legacySessions.delete(transport.sessionId)
          scheduleSessionServerClose(mcpServer)
        })
        await mcpServer.connect(transport)
        return
      }

      if (parsedUrl.pathname === config.legacyMessagesPath && request.method === 'POST') {
        const sessionId = parsedUrl.searchParams.get('sessionId')
        const session = sessionId ? legacySessions.get(sessionId) : undefined
        if (!session || session.expiresAt <= Date.now() || session.ownerId !== principal.ownerId) {
          safeResponse(response, 404, 'Legacy session not found.')
          return
        }
        const releaseBodyRead = bodyReadGate.acquire(request, response)
        if (!releaseBodyRead) return
        try {
          const body = await readBoundedJson(request, config.maxRequestBodyBytes)
          await session.transport.handlePostMessage(request, response, body)
        } finally {
          await releaseBodyRead()
        }
        return
      }

      if (parsedUrl.pathname === config.mcpPath) {
        if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'DELETE') {
          safeResponse(response, 405, 'Method not allowed.')
          return
        }
        const controller = new AbortController()
        const abortRequest = (): void => controller.abort()
        const abortResponse = (): void => {
          if (!response.writableEnded) controller.abort()
        }
        const mayContainBody =
          request.method === 'POST' ||
          request.method === 'DELETE' ||
          request.headers['content-length'] !== undefined ||
          request.headers['transfer-encoding'] !== undefined
        const releaseBodyRead = mayContainBody ? bodyReadGate.acquire(request, response) : undefined
        if (mayContainBody && !releaseBodyRead) return
        request.once('aborted', abortRequest)
        response.once('close', abortResponse)
        try {
          const requestForSdk = await toWebRequest(
            {
              method: request.method ?? 'GET',
              url: request.url ?? '/',
              headers: request.headers,
              async *[Symbol.asyncIterator]() {
                for await (const chunk of request) yield chunk
              },
            },
            undefined,
            { maxRequestBodySize: config.maxRequestBodyBytes, signal: controller.signal },
          )
          const responseFromSdk = await modernHandler.fetch(requestForSdk, {
            authInfo: authInfoFor(authenticated),
          })
          await writeWebResponse(responseFromSdk, response)
        } finally {
          request.removeListener('aborted', abortRequest)
          response.removeListener('close', abortResponse)
          if (releaseBodyRead) await releaseBodyRead()
        }
        return
      }
      safeResponse(response, 405, 'Method not allowed.')
    })()
    const tracked = route.catch((error: unknown) => {
      mcpErrorResponse(error, response)
    })
    activeRoutes.add(tracked)
    void tracked.then(
      () => {
        activeRoutes.delete(tracked)
      },
      () => {
        activeRoutes.delete(tracked)
        sessionCleanupFailed = true
      },
    )
  })
  server.requestTimeout = config.requestTimeoutMs
  server.headersTimeout = config.headersTimeoutMs
  server.keepAliveTimeout = 5_000

  return {
    server,
    get address() {
      return server.address()
    },
    artifactStore,
    shutdown() {
      if (shutdownPromise) return shutdownPromise
      draining = true
      clearInterval(sessionExpiryTimer)
      shutdownPromise = (async () => {
        const cleanupErrors: unknown[] = []
        const serverClosed = server.listening
          ? new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            )
          : Promise.resolve()
        const serverClosedObserved = serverClosed.then(
          () => undefined,
          (error: unknown) => {
            cleanupErrors.push(error)
          },
        )
        try {
          await modernHandler.close()
        } catch (error) {
          cleanupErrors.push(error)
        }
        for (const session of [...legacySessions.values()]) {
          legacySessions.delete(session.transport.sessionId)
          try {
            await session.transport.close()
          } catch (error) {
            cleanupErrors.push(error)
          }
          try {
            await closeSessionServer(session.server)
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
        while (pendingSessionServerCloses.size > 0) {
          const pending = [...pendingSessionServerCloses]
          pendingSessionServerCloses.clear()
          const closed = await Promise.allSettled(
            pending.map((mcpServer) => closeSessionServer(mcpServer)),
          )
          for (const result of closed)
            if (result.status === 'rejected') cleanupErrors.push(result.reason)
        }
        const outstanding = await Promise.allSettled([...pendingSessionClosures])
        for (const result of outstanding)
          if (result.status === 'rejected') cleanupErrors.push(result.reason)
        legacySessions.clear()
        while (activeRoutes.size > 0) await Promise.allSettled([...activeRoutes])
        server.closeAllConnections()
        await serverClosedObserved
        await Promise.resolve()
        while (pendingSessionServerCloses.size > 0) {
          const pending = [...pendingSessionServerCloses]
          pendingSessionServerCloses.clear()
          const closed = await Promise.allSettled(
            pending.map((mcpServer) => closeSessionServer(mcpServer)),
          )
          for (const result of closed)
            if (result.status === 'rejected') cleanupErrors.push(result.reason)
        }
        const remainingClosures = await Promise.allSettled([...pendingSessionClosures])
        for (const result of remainingClosures)
          if (result.status === 'rejected') cleanupErrors.push(result.reason)
        if (ownsArtifactStore) {
          try {
            await artifactStore.dispose()
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
        if (sessionCleanupFailed || cleanupErrors.length > 0)
          throw new Error('HTTP server shutdown did not complete cleanly.')
      })()
      return shutdownPromise
    },
  }
}
