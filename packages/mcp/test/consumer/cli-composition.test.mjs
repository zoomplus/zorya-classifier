import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/server'
import test from 'node:test'
import { createCredentialVault } from '../../src/auth/credential-vault.ts'
import { createHttpServer } from '../../src/http/server.ts'
import { parseHttpConfig } from '../../src/http/config.ts'

const { assertHttpCompositionConfig, createCredentialManagementHandlers } = await import(
  '../../src/cli.ts'
)

await test('CLI credential handlers accept generic configured BYOK through the protected HTTP route', async () => {
  const ownerId = 'controlled-owner'
  const issuer = 'https://issuer.example.test'
  const subject = 'controlled-subject'
  const profile = {
    id: 'generic',
    adapter: 'openai-compatible-vision',
    credentialMode: 'byok',
    endpoint: 'https://provider.example.test/v1/chat/completions',
    model: 'fixture/generic-model',
  }
  const profiles = { generic: profile }
  const vault = await createCredentialVault({ mode: 'memory-only' })
  const handlers = createCredentialManagementHandlers(profiles, vault)
  const httpConfig = parseHttpConfig({
    bindHost: '127.0.0.1',
    port: 0,
    publicOrigin: 'https://mcp.example.test',
    resourceUrl: 'https://mcp.example.test/mcp',
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    issuer,
    audience: 'https://mcp.example.test/mcp',
    requiredScopes: ['mcp:invoke'],
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: ['https://mcp.example.test'],
    credentialProfileIds: ['generic'],
  })
  const authenticated = {
    ownerId,
    identity: { issuer, subject, scopes: ['mcp:invoke'] },
    authInfo: {
      token: 'controlled-access-token',
      clientId: 'controlled-client',
      scopes: ['mcp:invoke'],
      resource: new URL(httpConfig.resourceUrl),
      resourceMetadataUrl: httpConfig.resourceMetadataUrl,
    },
  }
  const browserLogin = {
    begin() {
      return new Response(null, { status: 302 })
    },
    async complete() {
      return new Response(null, { status: 303 })
    },
    authenticate(request) {
      return request.headers.get('cookie')?.includes('session=controlled')
        ? authenticated
        : undefined
    },
    requireCsrf(request) {
      return request.headers.get('x-zorya-csrf') === 'controlled'
    },
    clear() {
      return new Response(null, { status: 303 })
    },
  }
  const server = createHttpServer({
    config: httpConfig,
    browserLogin,
    authenticator: {
      async authenticate() {
        return undefined
      },
      challenge() {
        return new Response(null, { status: 401 })
      },
    },
    ...handlers,
    createServerForPrincipal() {
      return new McpServer({ name: 'controlled-credential-route', version: '0.1.0' })
    },
  })
  try {
    server.server.listen(0, '127.0.0.1')
    await once(server.server, 'listening')
    const address = server.server.address()
    assert.ok(address && typeof address !== 'string')
    const endpoint = `http://127.0.0.1:${address.port}${httpConfig.credentialPath}`
    const saved = await fetch(endpoint, {
      method: 'POST',
      headers: {
        cookie: 'session=controlled',
        'x-zorya-csrf': 'controlled',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ profileId: 'generic', apiKey: 'fixturekey' }),
    })
    assert.equal(saved.status, 204)
    const stored = await vault.resolve({
      profile,
      principal: { ownerId, identity: { issuer, subject }, transport: 'http' },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5_000,
    })
    assert.equal(stored?.apiKey, 'fixturekey')

    const removed = await fetch(endpoint, {
      method: 'DELETE',
      headers: {
        cookie: 'session=controlled',
        'x-zorya-csrf': 'controlled',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ profileId: 'generic' }),
    })
    assert.equal(removed.status, 204)
    await assert.rejects(
      vault.resolve({
        profile,
        principal: { ownerId, identity: { issuer, subject }, transport: 'http' },
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 5_000,
      }),
      (error) => error?.code === 'CREDENTIAL_UNAVAILABLE',
    )
  } finally {
    await server.shutdown()
    await vault.dispose()
  }
})

await test('CLI validates its served metadata URL and browser form origin before OIDC setup', () => {
  const base = {
    bindHost: '127.0.0.1',
    port: 0,
    publicOrigin: 'https://mcp.example.test',
    resourceUrl: 'https://mcp.example.test/mcp',
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    issuer: 'https://issuer.example.test',
    audience: 'https://mcp.example.test/mcp',
    requiredScopes: ['mcp:invoke'],
    allowedHosts: ['mcp.example.test'],
    allowedOrigins: ['https://mcp.example.test'],
  }
  assert.doesNotThrow(() => assertHttpCompositionConfig(parseHttpConfig(base), true))
  assert.throws(
    () =>
      assertHttpCompositionConfig(
        parseHttpConfig({
          ...base,
          resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource',
        }),
        true,
      ),
    /resourceMetadataUrl/u,
  )
  assert.throws(
    () =>
      assertHttpCompositionConfig(
        parseHttpConfig({ ...base, allowedOrigins: ['https://client.example.test'] }),
        true,
      ),
    /allowedOrigins/u,
  )
})

await test('CLI rejects generic BYOK configured for OpenRouter PKCE before contacting the issuer', async () => {
  let issuerRequests = 0
  const issuer = createServer((_request, response) => {
    issuerRequests++
    response.writeHead(404)
    response.end()
  })
  issuer.listen(0, '127.0.0.1')
  await once(issuer, 'listening')
  const address = issuer.address()
  assert.ok(address && typeof address !== 'string')
  const workRoot = await mkdtemp(join(tmpdir(), 'zorya-mcp-cli-config-'))
  const configPath = join(workRoot, 'runtime.json')
  const config = {
    transport: 'http',
    core: {
      profiles: {
        generic: {
          id: 'generic',
          adapter: 'openai-compatible-vision',
          credentialMode: 'byok',
          endpoint: 'https://provider.example.test/v1/chat/completions',
          model: 'fixture/generic-model',
        },
      },
      defaultProfileId: 'generic',
    },
    credentialVault: { mode: 'memory-only' },
    remoteImageHosts: [],
    browserLogin: { clientId: 'controlled-client', scopes: ['openid', 'profile'] },
    openRouterPkceProfileId: 'generic',
    http: {
      bindHost: '127.0.0.1',
      port: 0,
      publicOrigin: 'https://mcp.example.test',
      resourceUrl: 'https://mcp.example.test/mcp',
      resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
      issuer: `http://127.0.0.1:${address.port}/`,
      audience: 'https://mcp.example.test/mcp',
      requiredScopes: ['mcp:invoke'],
      allowedHosts: ['127.0.0.1'],
      allowedOrigins: ['https://mcp.example.test'],
      credentialProfileIds: ['generic'],
    },
  }
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { flag: 'wx', mode: 0o600 })
  const safeEnvironment = Object.fromEntries(
    ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  )
  safeEnvironment['ZORYA_MCP_CONFIG'] = configPath
  const cliPath = resolve('src/cli.ts')
  const child = spawn(process.execPath, ['--import', 'tsx', cliPath], {
    cwd: resolve('.'),
    env: safeEnvironment,
    stdio: ['ignore', 'ignore', 'pipe'],
    shell: false,
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const timeout = setTimeout(() => child.kill(), 10_000)
  try {
    const [code] = await once(child, 'close')
    assert.equal(code, 1)
    assert.equal(issuerRequests, 0, 'Invalid PKCE profile reached OIDC issuer discovery.')
    assert.match(stderr, /MCP server could not start/u)
  } finally {
    clearTimeout(timeout)
    await new Promise((resolveClose) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolveClose()
      child.once('close', resolveClose)
      child.kill()
    })
    await new Promise((resolveClose, rejectClose) =>
      issuer.close((error) => (error ? rejectClose(error) : resolveClose())),
    )
    await rm(workRoot, { recursive: true, force: true })
  }
})
