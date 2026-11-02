import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as nodeRequest } from 'node:http'
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import sharp from 'sharp'
import test from 'node:test'
import type { AuthenticatedPrincipal } from '../../src/auth/oidc.js'
import { createHttpServer } from '../../src/http/server.js'
import { parseHttpConfig } from '../../src/http/config.js'

const authenticated: AuthenticatedPrincipal = {
  ownerId: 'owner-from-verified-principal',
  identity: { issuer: 'https://issuer.example.test', subject: 'subject-1', scopes: ['classify'] },
  authInfo: {
    token: 'example-controlled-access-token',
    clientId: 'shared-client',
    scopes: ['classify'],
    resource: new URL('https://mcp.example.test/mcp'),
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
  },
}

await test('pinned MCP SDK client performs authenticated modern streamable HTTP through Node adapter', async (context) => {
  const config = parseHttpConfig({
    bindHost: '127.0.0.1',
    port: 0,
    publicOrigin: 'http://127.0.0.1:39173',
    resourceUrl: 'https://mcp.example.test/mcp',
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    issuer: 'https://issuer.example.test',
    audience: 'https://mcp.example.test/mcp',
    requiredScopes: ['classify'],
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: ['http://127.0.0.1:39173'],
  })
  const server = createHttpServer({
    config,
    authenticator: {
      async authenticate(request) {
        return request.headers.get('authorization') === `Bearer ${authenticated.authInfo.token}`
          ? authenticated
          : undefined
      },
      challenge() {
        return new Response(null, {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
          },
        })
      },
    },
    createServerForPrincipal(principal) {
      assert.equal(principal.ownerId, authenticated.ownerId)
      if (principal.transport !== 'http')
        throw new Error('HTTP factory received a non-HTTP principal.')
      assert.equal(principal.identity.subject, authenticated.identity.subject)
      const mcp = new McpServer({ name: 'controlled-test-server', version: '1.0.0' })
      mcp.registerTool('owner_echo', { inputSchema: z.object({}) }, async () => ({
        content: [{ type: 'text' as const, text: principal.ownerId }],
      }))
      return mcp
    },
  })
  server.server.listen(0, '127.0.0.1')
  await once(server.server, 'listening')
  context.after(() => server.shutdown())
  const address = server.server.address()
  assert.ok(address && typeof address !== 'string')
  const client = new Client({ name: 'controlled-test-client', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    {
      requestInit: { headers: { authorization: `Bearer ${authenticated.authInfo.token}` } },
      onInsufficientScope: 'throw',
    },
  )
  context.after(async () => client.close())
  await client.connect(transport)
  const tools = await client.listTools()
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ['owner_echo'],
  )
  const called = await client.callTool({ name: 'owner_echo', arguments: {} })
  assert.deepEqual(called.content, [{ type: 'text', text: authenticated.ownerId }])
})

await test('HTTP host and origin checks reject untrusted requests before authentication', async (context) => {
  let authCalls = 0
  const config = parseHttpConfig({
    bindHost: '127.0.0.1',
    port: 0,
    publicOrigin: 'http://127.0.0.1:39173',
    resourceUrl: 'https://mcp.example.test/mcp',
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    issuer: 'https://issuer.example.test',
    audience: 'https://mcp.example.test/mcp',
    requiredScopes: ['classify'],
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: ['http://127.0.0.1:39173'],
  })
  const server = createHttpServer({
    config,
    authenticator: {
      async authenticate() {
        authCalls += 1
        return undefined
      },
      challenge() {
        return new Response(null, { status: 401 })
      },
    },
    createServerForPrincipal() {
      return new McpServer({ name: 'unreachable', version: '1.0.0' })
    },
  })
  server.server.listen(0, '127.0.0.1')
  await once(server.server, 'listening')
  context.after(() => server.shutdown())
  const address = server.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const hostRejected = await new Promise<number>((resolve, reject) => {
    const outgoing = nodeRequest(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: '/mcp',
        headers: { host: 'attacker.example.test' },
      },
      (incoming) => {
        incoming.resume()
        incoming.once('end', () => resolve(incoming.statusCode ?? 0))
      },
    )
    outgoing.once('error', reject)
    outgoing.end()
  })
  assert.equal(hostRejected, 403)
  const malformedHostRejected = await new Promise<number>((resolve, reject) => {
    const outgoing = nodeRequest(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: '/mcp',
        headers: { host: '127.0.0.1/private-path' },
      },
      (incoming) => {
        incoming.resume()
        incoming.once('end', () => resolve(incoming.statusCode ?? 0))
      },
    )
    outgoing.once('error', reject)
    outgoing.end()
  })
  assert.equal(malformedHostRejected, 403)
  const originRejected = await fetch(`${base}/mcp`, {
    headers: { origin: 'https://attacker.example.test' },
  })
  assert.equal(originRejected.status, 403)
  assert.equal(authCalls, 0)
})

await test('pinned legacy SSE client is authenticated on both stream creation and message POSTs', async (context) => {
  const config = parseHttpConfig({
    bindHost: '127.0.0.1',
    port: 0,
    publicOrigin: 'http://127.0.0.1:39173',
    resourceUrl: 'https://mcp.example.test/mcp',
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    issuer: 'https://issuer.example.test',
    audience: 'https://mcp.example.test/mcp',
    requiredScopes: ['classify'],
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: ['http://127.0.0.1:39173'],
  })
  const authCalls: string[] = []
  const server = createHttpServer({
    config,
    authenticator: {
      async authenticate(request) {
        const bearer = request.headers.get('authorization') ?? ''
        authCalls.push(bearer)
        return bearer === `Bearer ${authenticated.authInfo.token}` ? authenticated : undefined
      },
      challenge() {
        return new Response(null, { status: 401 })
      },
    },
    createServerForPrincipal(principal) {
      if (principal.transport !== 'http') throw new Error('Expected an HTTP principal.')
      const mcp = new McpServer({ name: 'controlled-legacy-server', version: '1.0.0' })
      mcp.registerTool('owner_echo', { inputSchema: z.object({}) }, async () => ({
        content: [{ type: 'text' as const, text: principal.ownerId }],
      }))
      return mcp
    },
  })
  server.server.listen(0, '127.0.0.1')
  await once(server.server, 'listening')
  context.after(() => server.shutdown())
  const address = server.server.address()
  assert.ok(address && typeof address !== 'string')
  const client = new Client({ name: 'controlled-legacy-client', version: '1.0.0' })
  const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${address.port}/sse`), {
    requestInit: { headers: { authorization: `Bearer ${authenticated.authInfo.token}` } },
  })
  context.after(async () => client.close())
  await client.connect(transport)
  const called = await client.callTool({ name: 'owner_echo', arguments: {} })
  assert.deepEqual(called.content, [{ type: 'text', text: authenticated.ownerId }])
  assert.ok(authCalls.length >= 2)
  assert.ok(authCalls.every((value) => value === `Bearer ${authenticated.authInfo.token}`))
  let shutdownTimer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      server.shutdown(),
      new Promise<never>((_resolve, reject) => {
        shutdownTimer = setTimeout(
          () => reject(new Error('HTTP shutdown did not close an open SSE client.')),
          2_000,
        )
      }),
    ])
  } finally {
    if (shutdownTimer) clearTimeout(shutdownTimer)
  }
  assert.equal(server.server.listening, false)
  await client.close()
})

await test('provider key form requires the browser session and same-origin CSRF token', async (context) => {
  const config = parseHttpConfig({
    bindHost: '127.0.0.1',
    port: 0,
    publicOrigin: 'http://127.0.0.1:39173',
    resourceUrl: 'https://mcp.example.test/mcp',
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    issuer: 'https://issuer.example.test',
    audience: 'https://mcp.example.test/mcp',
    requiredScopes: ['classify'],
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: ['http://127.0.0.1:39173'],
    credentialProfileIds: ['primary'],
  })
  const saved: Array<{ ownerId: string; profileId: string; apiKey: string }> = []
  const browserLogin = {
    begin() {
      return new Response(null, { status: 302 })
    },
    async complete() {
      return new Response(null, { status: 303 })
    },
    authenticate(request: Request) {
      return request.headers.get('cookie')?.includes('session=fake-session')
        ? authenticated
        : undefined
    },
    requireCsrf(request: Request) {
      return (
        request.headers.get('origin') === 'http://127.0.0.1:39173' &&
        request.headers.get('x-zorya-csrf') === 'fake-csrf'
      )
    },
    clear() {
      return new Response(null, { status: 303 })
    },
  }
  const server = createHttpServer({
    config,
    browserLogin,
    authenticator: {
      async authenticate() {
        return undefined
      },
      challenge() {
        return new Response(null, { status: 401 })
      },
    },
    async saveProviderCredential(value) {
      saved.push(value)
    },
    createServerForPrincipal() {
      return new McpServer({ name: 'unused', version: '1.0.0' })
    },
  })
  server.server.listen(0, '127.0.0.1')
  await once(server.server, 'listening')
  context.after(() => server.shutdown())
  const address = server.server.address()
  assert.ok(address && typeof address !== 'string')
  const target = `http://127.0.0.1:${address.port}/settings/provider-key`
  const rejected = await fetch(target, {
    method: 'POST',
    headers: {
      host: `127.0.0.1:${address.port}`,
      origin: 'https://attacker.example.test',
      cookie: 'session=fake-session',
      'x-zorya-csrf': 'fake-csrf',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ profileId: 'primary', apiKey: 'fake-form-key' }),
  })
  assert.equal(rejected.status, 403)
  assert.equal(saved.length, 0)
  const accepted = await fetch(target, {
    method: 'POST',
    headers: {
      host: `127.0.0.1:${address.port}`,
      origin: 'http://127.0.0.1:39173',
      cookie: 'session=fake-session',
      'x-zorya-csrf': 'fake-csrf',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ profileId: 'primary', apiKey: 'fake-form-key' }),
  })
  assert.equal(accepted.status, 204)
  assert.equal(await accepted.text(), '')
  assert.deepEqual(saved, [
    { ownerId: authenticated.ownerId, profileId: 'primary', apiKey: 'fake-form-key' },
  ])
})

await test('OpenRouter browser connection returns a readable authorization URL instead of an opaque redirect', async (context) => {
  const config = parseHttpConfig({
    bindHost: '127.0.0.1',
    port: 0,
    publicOrigin: 'http://127.0.0.1:39173',
    resourceUrl: 'https://mcp.example.test/mcp',
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    issuer: 'https://issuer.example.test',
    audience: 'https://mcp.example.test/mcp',
    requiredScopes: ['classify'],
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: ['http://127.0.0.1:39173'],
  })
  let startedFor = ''
  const browserLogin = {
    begin() {
      return new Response(null, { status: 302 })
    },
    async complete() {
      return new Response(null, { status: 303 })
    },
    authenticate(request: Request) {
      return request.headers.get('cookie') === 'zorya-session=example-session'
        ? authenticated
        : undefined
    },
    requireCsrf(request: Request) {
      return (
        request.headers.get('origin') === 'http://127.0.0.1:39173' &&
        request.headers.get('x-zorya-csrf') === 'example-csrf'
      )
    },
    clear() {
      return new Response(null, { status: 204 })
    },
  }
  const server = createHttpServer({
    config,
    browserLogin,
    openRouterPkce: {
      begin(ownerId) {
        startedFor = ownerId
        return new Response(null, {
          status: 302,
          headers: {
            location:
              'https://openrouter.ai/auth?callback_url=https%3A%2F%2Fmcp.example.test%2Fsettings%2Fopenrouter%2Fcallback&code_challenge=example-challenge&code_challenge_method=S256&state=example-state',
          },
        })
      },
      async complete() {
        return new Response(null, { status: 303 })
      },
    },
    authenticator: {
      async authenticate() {
        return undefined
      },
      challenge() {
        return new Response(null, { status: 401 })
      },
    },
    createServerForPrincipal() {
      return new McpServer({ name: 'unused', version: '1.0.0' })
    },
  })
  server.server.listen(0, '127.0.0.1')
  await once(server.server, 'listening')
  context.after(() => server.shutdown())
  const address = server.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const settings = await fetch(`${base}/settings`, {
    headers: { host: `127.0.0.1:${address.port}`, cookie: 'zorya-session=example-session' },
  })
  assert.equal(settings.status, 200)
  const html = await settings.text()
  assert.match(html, /const result=await response\.json\(\)/u)
  assert.doesNotMatch(html, /redirect:'manual'/u)
  assert.match(html, /window\.location\.assign\(authorization\.href\)/u)
  const response = await fetch(`${base}/settings/openrouter/connect`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      host: `127.0.0.1:${address.port}`,
      origin: 'http://127.0.0.1:39173',
      cookie: 'zorya-session=example-session',
      'x-zorya-csrf': 'example-csrf',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('location'), null)
  assert.equal(startedFor, authenticated.ownerId)
  const result = z.object({ authorizationUrl: z.string().url() }).parse(await response.json())
  const authorization = new URL(result.authorizationUrl)
  assert.equal(authorization.origin, 'https://openrouter.ai')
  assert.equal(authorization.pathname, '/auth')
  assert.equal(authorization.searchParams.get('state'), 'example-state')
  assert.equal(authorization.searchParams.get('code_challenge'), 'example-challenge')
})

await test('HTTP login callback preserves separate session, CSRF and state cookies and cookie-authenticated MCP POSTs require CSRF', async (context) => {
  const config = parseHttpConfig({
    bindHost: '127.0.0.1',
    port: 0,
    publicOrigin: 'http://127.0.0.1:39173',
    resourceUrl: 'https://mcp.example.test/mcp',
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    issuer: 'https://issuer.example.test',
    audience: 'https://mcp.example.test/mcp',
    requiredScopes: ['classify'],
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: ['http://127.0.0.1:39173'],
  })
  let constructed = 0
  const browserLogin = {
    begin() {
      return new Response(null, { status: 302 })
    },
    async complete() {
      const headers = new Headers({ location: '/viewer/jobs/job-1', 'cache-control': 'no-store' })
      headers.append('set-cookie', 'zorya-session=fake-session; HttpOnly; SameSite=Lax')
      headers.append('set-cookie', 'zorya-csrf=fake-csrf; SameSite=Lax')
      headers.append('set-cookie', 'zorya-login=; Max-Age=0; HttpOnly')
      return new Response(null, { status: 303, headers })
    },
    authenticate(request: Request) {
      return request.headers.get('cookie')?.includes('zorya-session=fake-session')
        ? authenticated
        : undefined
    },
    requireCsrf(request: Request) {
      return (
        request.headers.get('origin') === 'http://127.0.0.1:39173' &&
        request.headers.get('x-zorya-csrf') === 'fake-csrf'
      )
    },
    clear() {
      return new Response(null, { status: 204 })
    },
  }
  const server = createHttpServer({
    config,
    browserLogin,
    authenticator: {
      async authenticate() {
        return undefined
      },
      challenge() {
        return new Response(null, { status: 401 })
      },
    },
    createServerForPrincipal() {
      constructed += 1
      return new McpServer({ name: 'unused', version: '1.0.0' })
    },
  })
  server.server.listen(0, '127.0.0.1')
  await once(server.server, 'listening')
  context.after(() => server.shutdown())
  const address = server.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const callback = await fetch(`${base}/login/callback?code=fake-code&state=fake-state`, {
    redirect: 'manual',
  })
  assert.equal(callback.status, 303)
  const cookies = callback.headers.getSetCookie()
  assert.equal(cookies.length, 3)
  assert.ok(cookies.some((value) => value.startsWith('zorya-session=')))
  assert.ok(cookies.some((value) => value.startsWith('zorya-csrf=')))
  assert.ok(cookies.some((value) => value.startsWith('zorya-login=')))
  const rejected = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      cookie: 'zorya-session=fake-session; zorya-csrf=fake-csrf',
      origin: 'http://127.0.0.1:39173',
      'content-type': 'application/json',
    },
    body: '{}',
  })
  assert.equal(rejected.status, 403)
  assert.equal(constructed, 0)
})

await test('MCP request body limit rejects large payloads before constructing a server', async (context) => {
  const config = parseHttpConfig({
    bindHost: '127.0.0.1',
    port: 0,
    publicOrigin: 'http://127.0.0.1:39173',
    resourceUrl: 'https://mcp.example.test/mcp',
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    issuer: 'https://issuer.example.test',
    audience: 'https://mcp.example.test/mcp',
    requiredScopes: ['classify'],
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: ['http://127.0.0.1:39173'],
    maxRequestBodyBytes: 1_024,
  })
  let constructed = 0
  const server = createHttpServer({
    config,
    authenticator: {
      async authenticate() {
        return authenticated
      },
      challenge() {
        return new Response(null, { status: 401 })
      },
    },
    createServerForPrincipal() {
      constructed += 1
      return new McpServer({ name: 'unused', version: '1.0.0' })
    },
  })
  server.server.listen(0, '127.0.0.1')
  await once(server.server, 'listening')
  context.after(() => server.shutdown())
  const address = server.server.address()
  assert.ok(address && typeof address !== 'string')
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${authenticated.authInfo.token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { padding: 'x'.repeat(2_000) },
    }),
  })
  assert.equal(response.status, 413)
  assert.equal(constructed, 0)
})

await test('authenticated upload route validates image bytes and stores a private owner-bound upload ID', async (context) => {
  const config = parseHttpConfig({
    bindHost: '127.0.0.1',
    port: 0,
    publicOrigin: 'http://127.0.0.1:39173',
    resourceUrl: 'https://mcp.example.test/mcp',
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    issuer: 'https://issuer.example.test',
    audience: 'https://mcp.example.test/mcp',
    requiredScopes: ['classify'],
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: ['http://127.0.0.1:39173'],
    maxUploadBytes: 1_048_576,
  })
  const server = createHttpServer({
    config,
    authenticator: {
      async authenticate(request) {
        return request.headers.get('authorization') === `Bearer ${authenticated.authInfo.token}`
          ? authenticated
          : undefined
      },
      challenge() {
        return new Response(null, { status: 401 })
      },
    },
    createServerForPrincipal() {
      return new McpServer({ name: 'unused', version: '1.0.0' })
    },
  })
  server.server.listen(0, '127.0.0.1')
  await once(server.server, 'listening')
  context.after(() => server.shutdown())
  const address = server.server.address()
  assert.ok(address && typeof address !== 'string')
  const png = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#abcdef' } })
    .png()
    .toBuffer()
  const response = await fetch(`http://127.0.0.1:${address.port}/uploads`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${authenticated.authInfo.token}`,
      'content-type': 'image/png',
    },
    body: png,
  })
  assert.equal(response.status, 201)
  const receipt = z
    .object({
      id: z.string(),
      mediaType: z.string(),
      byteLength: z.number(),
      width: z.number(),
      height: z.number(),
      expiresAt: z.number(),
    })
    .parse(await response.json())
  assert.match(receipt.id, /^[a-f0-9]{32}$/u)
  assert.equal(receipt.mediaType, 'image/png')
  assert.equal(receipt.byteLength, png.byteLength)
  assert.deepEqual([receipt.width, receipt.height], [4, 3])
  const stored = await server.artifactStore.readUploaded({
    ownerId: authenticated.ownerId,
    id: receipt.id,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 1_000,
    maxBytes: 1_048_576,
  })
  assert.deepEqual(Buffer.from(stored.bytes), png)
  await assert.rejects(
    server.artifactStore.readUploaded({
      ownerId: 'another-owner',
      id: receipt.id,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000,
      maxBytes: 1_048_576,
    }),
    (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'NOT_FOUND',
  )
})

await test('global HTTP body-read capacity returns 503 while an earlier request body remains open', async (context) => {
  const config = parseHttpConfig({
    bindHost: '127.0.0.1',
    port: 0,
    publicOrigin: 'http://127.0.0.1:39173',
    resourceUrl: 'https://mcp.example.test/mcp',
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    issuer: 'https://issuer.example.test',
    audience: 'https://mcp.example.test/mcp',
    requiredScopes: ['classify'],
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: ['http://127.0.0.1:39173'],
    maxConcurrentBodyReads: 1,
    maxConcurrentUploads: 2,
    maxUploadBytes: 1_024,
  })
  const server = createHttpServer({
    config,
    authenticator: {
      async authenticate() {
        return authenticated
      },
      challenge() {
        return new Response(null, { status: 401 })
      },
    },
    createServerForPrincipal() {
      return new McpServer({ name: 'unused', version: '1.0.0' })
    },
  })
  server.server.listen(0, '127.0.0.1')
  await once(server.server, 'listening')
  context.after(() => server.shutdown())
  const address = server.server.address()
  assert.ok(address && typeof address !== 'string')
  const partial = nodeRequest({
    hostname: '127.0.0.1',
    port: address.port,
    path: '/uploads',
    method: 'POST',
    headers: {
      authorization: `Bearer ${authenticated.authInfo.token}`,
      'content-type': 'image/png',
      'content-length': '100',
    },
  })
  partial.on('error', () => undefined)
  partial.write(Buffer.from([1, 2, 3]))
  await new Promise((resolve) => setTimeout(resolve, 25))
  const rejected = await fetch(`http://127.0.0.1:${address.port}/uploads`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${authenticated.authInfo.token}`,
      'content-type': 'image/png',
    },
    body: Buffer.from([1, 2, 3]),
  })
  assert.equal(rejected.status, 503)
  partial.destroy()
})
