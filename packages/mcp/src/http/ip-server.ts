import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { toWebRequest } from '@modelcontextprotocol/node'
import type { CoreApplication } from '../contracts.js'
import { AnonymousSessionStore } from '../auth/anonymous-sessions.js'
import { createAnonymousMcpServer } from '../tools/mcp-server.js'
import type { IpHttpConfig } from './ip-config.js'
import { IpAccessPolicy } from './ip-access.js'

export interface IpHttpServerDependencies {
  readonly config: IpHttpConfig
  readonly application: CoreApplication
  readonly maxArtifactBytes: number
}

export interface RunningIpHttpServer {
  readonly server: Server
  shutdown(): Promise<void>
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

async function writeMcpResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  const headers = new Headers(response.headers)
  headers.set('cache-control', 'no-store')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
  await writeWebResponse(
    new Response(response.body, { status: response.status, headers }),
    outgoing,
  )
}

async function writeWebResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (!response.body) {
    outgoing.end()
    return
  }
  await pipeline(Readable.fromWeb(response.body), outgoing)
}

function readSingleHeader(request: IncomingMessage, name: string): string | undefined {
  let value: string | undefined
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== name) continue
    if (value !== undefined) return undefined
    value = request.rawHeaders[index + 1]
  }
  return value
}

function peerKey(value: string): string {
  return value
}

/** HTTP-сервер по IP allowlist без OAuth routes, viewer и Bearer challenge. */
export function createIpHttpServer(dependencies: IpHttpServerDependencies): RunningIpHttpServer {
  const { config, application } = dependencies
  const access = new IpAccessPolicy(config)
  const sessions = new AnonymousSessionStore({
    maxSessions: config.maxSessions,
    ttlMs: config.sessionTtlMs,
    maxJobsPerSessionPerDay: config.maxJobsPerSessionPerDay,
    maxJobsGloballyPerDay: config.maxJobsPerDay,
  })
  const mcpHandler = createMcpHandler(
    () =>
      createAnonymousMcpServer(application, sessions, {
        maxArtifactBytes: dependencies.maxArtifactBytes,
      }),
    {
      legacy: 'stateless',
      maxRequestBodySize: config.maxRequestBodyBytes,
      keepAliveMs: 15_000,
      onerror: () => undefined,
    },
  )
  const rates = new Map<string, { minute: number; count: number }>()
  let draining = false
  const activeRoutes = new Set<Promise<void>>()
  let shutdownPromise: Promise<void> | undefined

  const server = createServer((request, response) => {
    const route = (async () => {
      if (draining) {
        safeResponse(response, 503, 'HTTP server is shutting down.')
        request.resume()
        return
      }
      const clientAddress = access.clientAddress(request)
      if (!access.authorize(request) || !clientAddress) {
        safeResponse(response, 403, 'Request is not allowed.')
        request.resume()
        return
      }
      const nowMinute = Math.floor(Date.now() / 60_000)
      const key = peerKey(clientAddress)
      if (rates.size >= 10_000 && !rates.has(key)) {
        for (const [entry, value] of rates) if (value.minute < nowMinute) rates.delete(entry)
      }
      if (rates.size >= 10_000 && !rates.has(key)) {
        safeResponse(response, 503, 'Request rate capacity is unavailable.')
        request.resume()
        return
      }
      let rate = rates.get(key)
      if (!rate || rate.minute !== nowMinute) {
        rate = { minute: nowMinute, count: 0 }
        rates.set(key, rate)
      }
      rate.count += 1
      if (rate.count > config.maxRequestsPerMinute) {
        safeResponse(response, 429, 'Request rate limit exceeded.')
        request.resume()
        return
      }
      let parsedUrl: URL
      try {
        parsedUrl = new URL(
          request.url ?? '/',
          `http://${readSingleHeader(request, 'host') ?? 'invalid'}`,
        )
      } catch {
        safeResponse(response, 400, 'Request could not be processed.')
        request.resume()
        return
      }
      if (parsedUrl.pathname !== config.mcpPath) {
        safeResponse(response, 404, 'Route not found.')
        request.resume()
        return
      }
      if (parsedUrl.search || !['GET', 'POST', 'DELETE'].includes(request.method ?? '')) {
        safeResponse(
          response,
          parsedUrl.search ? 400 : 405,
          parsedUrl.search ? 'Query parameters are not accepted.' : 'Method not allowed.',
        )
        request.resume()
        return
      }
      const lengthHeader = readSingleHeader(request, 'content-length')
      const length = lengthHeader === undefined ? undefined : Number(lengthHeader)
      if (
        length !== undefined &&
        (!Number.isSafeInteger(length) || length < 0 || length > config.maxRequestBodyBytes)
      ) {
        safeResponse(response, 413, 'Request body exceeds the configured limit.')
        request.resume()
        return
      }
      const active = activeRoutes.size
      if (active >= config.maxConcurrentRequests) {
        safeResponse(response, 503, 'Request capacity is unavailable.')
        request.resume()
        return
      }
      const controller = new AbortController()
      const timeout = setTimeout(() => {
        controller.abort()
        request.destroy()
      }, config.requestTimeoutMs)
      timeout.unref()
      const abortRequest = (): void => controller.abort()
      const abortResponse = (): void => {
        if (!response.writableEnded) controller.abort()
      }
      request.once('aborted', abortRequest)
      response.once('close', abortResponse)
      try {
        const webRequest = await toWebRequest(
          {
            method: request.method ?? 'GET',
            url: request.url ?? '/',
            headers: request.headers,
            async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
              for await (const chunk of request) {
                if (typeof chunk === 'string') yield Buffer.from(chunk)
                else if (Buffer.isBuffer(chunk)) yield chunk
                else if (chunk instanceof Uint8Array) yield chunk
                else throw new Error('Request body contains an invalid chunk.')
              }
            },
          },
          undefined,
          { maxRequestBodySize: config.maxRequestBodyBytes, signal: controller.signal },
        )
        const webResponse = await mcpHandler.fetch(webRequest)
        await writeMcpResponse(webResponse, response)
      } catch {
        safeResponse(
          response,
          controller.signal.aborted ? 408 : 400,
          'Request could not be processed.',
        )
      } finally {
        clearTimeout(timeout)
        request.removeListener('aborted', abortRequest)
        response.removeListener('close', abortResponse)
        if (!request.complete && !request.destroyed) {
          if (!response.headersSent && !response.destroyed)
            response.setHeader('connection', 'close')
          request.destroy()
        }
        if (!request.complete && !request.closed) {
          await new Promise<void>((resolve) => request.once('close', resolve))
        }
      }
    })()
    activeRoutes.add(route)
    void route.then(
      () => activeRoutes.delete(route),
      () => {
        activeRoutes.delete(route)
        safeResponse(response, 400, 'Request could not be processed.')
      },
    )
  })
  server.headersTimeout = Math.min(10_000, config.requestTimeoutMs)
  server.requestTimeout = config.requestTimeoutMs
  server.maxHeadersCount = 100

  return {
    server,
    shutdown() {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = (async () => {
        draining = true
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
        const handlerClosed = mcpHandler.close()
        server.closeAllConnections()
        sessions.close()
        const settled = await Promise.allSettled([handlerClosed, closed, ...activeRoutes])
        const failures = settled
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason)
        if (failures.length > 0)
          throw new AggregateError(failures, 'IP MCP shutdown was incomplete.')
      })()
      return shutdownPromise
    },
  }
}
