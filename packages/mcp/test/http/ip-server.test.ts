import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer as createNodeServer, request as nodeRequest } from 'node:http'
import { createConnection } from 'node:net'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'
import test from 'node:test'
import type { CoreApplication } from '../../src/contracts.js'
import { McpCoreError } from '../../src/errors.js'
import { parseMcpConfig } from '../../src/config.js'
import { createIpHttpServer } from '../../src/http/ip-server.js'
import { parseIpHttpConfig } from '../../src/http/ip-config.js'

const jobA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const owners = new Map<string, string>()

await test('IP access serves modern HTTP without auth and anonymous capability scopes jobs/artifacts', async (context) => {
  const port = await freePort()
  const host = `127.0.0.1:${port}`
  const config = parseIpHttpConfig({
    accessMode: 'ip',
    bindHost: '127.0.0.1',
    port,
    allowedCidrs: ['127.0.0.0/8'],
    trustedProxyCidrs: [],
    allowedHosts: [host],
    allowedOrigins: [],
    maxJobsPerSessionPerDay: 10,
    maxJobsPerDay: 100,
    requestTimeoutMs: 1_000,
  })
  const application: CoreApplication = {
    async invoke(input) {
      if (input.toolName === 'zorya_classify') {
        owners.set(jobA, input.principal.ownerId)
        return {
          jobId: jobA,
          state: 'queued',
          operation: 'classify',
          createdAt: Date.now(),
          deadlineAt: Date.now() + 60_000,
        }
      }
      if (input.toolName === 'zorya_get_job' || input.toolName === 'zorya_cancel_job') {
        const args = z.strictObject({ jobId: z.string() }).parse(input.args)
        if (owners.get(args.jobId) !== input.principal.ownerId)
          throw new McpCoreError('NOT_FOUND', 'Job was not found.')
        return {
          id: args.jobId,
          state: 'succeeded',
          operation: 'classify',
          createdAt: Date.now(),
          deadlineAt: Date.now() + 60_000,
          artifacts: [],
        }
      }
      if (input.toolName === 'zorya_capabilities')
        return {
          transport: { active: 'http', supportedProtocols: ['streamable-http:2026-07-28'] },
          inputs: {
            inlineBase64: true,
            localPath: true,
            url: false,
            chatgptFile: false,
            uploadedId: false,
          },
          profiles: [
            {
              id: 'luna',
              adapter: 'openrouter-vision',
              model: 'openai/gpt-6-luna',
              provider: 'openai',
            },
          ],
          operations: {
            classify: true,
            locateRegion: false,
            locateWholeObject: false,
            extract: false,
          },
          limits: {
            maxImageBytes: 1024,
            maxImagePixels: 1024,
            maxQueuedJobs: 2,
            maxQueuedJobsPerOwner: 1,
            maxStoredJobs: 4,
            maxStoredJobsPerOwner: 2,
            maxQueuedInputBytes: 1024,
            maxQueuedInputBytesPerOwner: 1024,
            maxActiveJobs: 1,
            maxActiveJobsPerOwner: 1,
            jobTimeoutMs: 1000,
            jobTtlMs: 1000,
            artifactTtlMs: 1000,
            maxArtifactBytes: 1024,
            maxArtifactTotalBytes: 1024,
            maxArtifactTotalBytesPerOwner: 1024,
            maxResultJsonBytes: 1024,
          },
        }
      return { error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false } }
    },
    async readResource(input) {
      if (owners.get(jobA) !== input.principal.ownerId) throw new Error('not found')
      return {
        kind: 'binary',
        mediaType: input.uri.endsWith('image-A') ? 'image/png' : 'application/octet-stream',
        bytes: new Uint8Array([1, 2, 3]),
      }
    },
    async shutdown() {},
  }
  const server = createIpHttpServer({ config, application, maxArtifactBytes: 1024 })
  server.server.listen(port, '127.0.0.1')
  await once(server.server, 'listening')
  context.after(() => server.shutdown())

  const wrongHost = await rawRequest(port, { Host: `attacker.test:${port}` })
  assert.equal(wrongHost.status, 403)
  assert.equal(wrongHost.headers['www-authenticate'], undefined)
  const duplicateHostStatus = await rawDuplicateHost(port)
  assert.ok(duplicateHostStatus >= 400)

  const spoofed = await rawRequest(port, { 'x-real-ip': '203.0.113.10' })
  assert.equal(spoofed.status, 403)
  const duplicateOrigin = await rawRequest(port, {
    Origin: ['https://one.test', 'https://two.test'],
  })
  assert.equal(duplicateOrigin.status, 403)
  const malformedOrigin = await rawRequest(port, { Origin: 'https://one.test/path' })
  assert.equal(malformedOrigin.status, 403)

  const initializeResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      Host: host,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'raw-noauth-check', version: '1.0.0' },
      },
    }),
  })
  const initializeBody = await initializeResponse.text()
  assert.equal(initializeResponse.status, 200, initializeBody)
  assert.equal(initializeResponse.headers.get('cache-control'), 'no-store')
  assert.equal(initializeResponse.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(initializeResponse.headers.get('www-authenticate'), null)

  const proxyPort = await freePort()
  const proxyServer = createIpHttpServer({
    config: parseIpHttpConfig({
      accessMode: 'ip',
      bindHost: '127.0.0.1',
      port: proxyPort,
      allowedCidrs: ['203.0.113.0/24'],
      trustedProxyCidrs: ['127.0.0.1/32'],
      allowedHosts: [`127.0.0.1:${proxyPort}`],
    }),
    application,
    maxArtifactBytes: 1024,
  })
  proxyServer.server.listen(proxyPort, '127.0.0.1')
  await once(proxyServer.server, 'listening')
  context.after(() => proxyServer.shutdown())
  const forwarded = await rawRequest(proxyPort, { 'x-real-ip': '203.0.113.8' })
  assert.notEqual(forwarded.status, 403)
  const duplicateRealIp = await rawRequest(proxyPort, {
    'x-real-ip': ['203.0.113.8', '203.0.113.9'],
  })
  assert.equal(duplicateRealIp.status, 403)
  const malformedRealIp = await rawRequest(proxyPort, { 'x-real-ip': 'not-an-ip' })
  assert.equal(malformedRealIp.status, 403)
  const alternateForwardingHeader = await rawRequest(proxyPort, {
    'x-real-ip': '203.0.113.8',
    'x-forwarded-for': '203.0.113.8',
  })
  assert.equal(alternateForwardingHeader.status, 403)

  const clientA = await connectClient(port)
  const clientB = await connectClient(port)
  context.after(async () => {
    await clientA.client.close()
    await clientB.client.close()
  })
  const listed = await clientA.client.listTools()
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    'zorya_cancel_job',
    'zorya_capabilities',
    'zorya_classify',
    'zorya_extract',
    'zorya_get_job',
    'zorya_locate',
    'zorya_open_session',
    'zorya_read_artifact',
  ])
  const classifyTool = listed.tools.find((tool) => tool.name === 'zorya_classify')
  assert.deepEqual(classifyTool?._meta?.['openai/fileParams'], ['image_file'])
  const openedA = await clientA.client.callTool({ name: 'zorya_open_session', arguments: {} })
  const openedB = await clientB.client.callTool({ name: 'zorya_open_session', arguments: {} })
  const tokenSchema = z.strictObject({ sessionToken: z.string(), expiresAt: z.number() })
  const tokenA = tokenSchema.parse(openedA.structuredContent).sessionToken
  const tokenB = tokenSchema.parse(openedB.structuredContent).sessionToken
  assert.notEqual(tokenA, tokenB)
  const caps = await clientA.client.callTool({
    name: 'zorya_capabilities',
    arguments: { sessionToken: tokenA },
  })
  assert.equal(
    z
      .object({ inputs: z.strictObject({ localPath: z.boolean() }).passthrough() })
      .passthrough()
      .parse(caps.structuredContent).inputs.localPath,
    false,
  )
  const created = await clientA.client.callTool({
    name: 'zorya_classify',
    arguments: {
      sessionToken: tokenA,
      text: 'test',
      classes: [
        { id: 'a', description: 'A' },
        { id: 'b', description: 'B' },
      ],
    },
  })
  assert.equal(
    z.object({ jobId: z.string() }).passthrough().parse(created.structuredContent).jobId,
    jobA,
  )
  const localPath = await clientA.client.callTool({
    name: 'zorya_classify',
    arguments: {
      sessionToken: tokenA,
      text: 'test',
      image: { kind: 'localPath', path: '/private/image.png' },
      classes: [
        { id: 'a', description: 'A' },
        { id: 'b', description: 'B' },
      ],
    },
  })
  assert.equal(localPath.isError, true)
  const denied = await clientB.client.callTool({
    name: 'zorya_get_job',
    arguments: { sessionToken: tokenB, jobId: jobA },
  })
  assert.equal(denied.isError, true)
  const cancelDenied = await clientB.client.callTool({
    name: 'zorya_cancel_job',
    arguments: { sessionToken: tokenB, jobId: jobA },
  })
  assert.equal(cancelDenied.isError, true)
  const noToken = await clientA.client.callTool({
    name: 'zorya_get_job',
    arguments: { jobId: jobA },
  })
  assert.equal(noToken.isError, true)
  const artifact = await clientA.client.callTool({
    name: 'zorya_read_artifact',
    arguments: { sessionToken: tokenA, artifactId: 'artifact-A' },
  })
  assert.equal(artifact.content[0]?.type, 'resource')
  const image = await clientA.client.callTool({
    name: 'zorya_read_artifact',
    arguments: { sessionToken: tokenA, artifactId: 'image-A' },
  })
  assert.equal(image.content[0]?.type, 'image')
  const artifactDenied = await clientB.client.callTool({
    name: 'zorya_read_artifact',
    arguments: { sessionToken: tokenB, artifactId: 'artifact-A' },
  })
  assert.equal(artifactDenied.isError, true)
  await assertIncompleteBodyIsClosed(port)
})

await test('IP configuration rejects malformed, wildcard, and mapped IPv4 CIDRs', () => {
  assert.throws(() =>
    parseIpHttpConfig({
      accessMode: 'ip',
      bindHost: '127.0.0.1',
      port: 0,
      allowedCidrs: ['0.0.0.0/0'],
      allowedHosts: ['example.test'],
    }),
  )
  assert.throws(() =>
    parseIpHttpConfig({
      accessMode: 'ip',
      bindHost: '127.0.0.1',
      port: 0,
      allowedCidrs: ['192.0.2.1'],
      allowedHosts: ['*.example.test'],
    }),
  )
  assert.throws(() =>
    parseIpHttpConfig({
      accessMode: 'ip',
      bindHost: '127.0.0.1',
      port: 0,
      allowedCidrs: ['127.1/32'],
      allowedHosts: ['example.test'],
    }),
  )
  const mapped = parseIpHttpConfig({
    accessMode: 'ip',
    bindHost: '127.0.0.1',
    port: 0,
    allowedCidrs: ['::ffff:127.0.0.1/128'],
    allowedHosts: ['example.test'],
  })
  assert.deepEqual(mapped.allowedCidrs, ['::ffff:127.0.0.1/128'])
  const ipv6Host = parseIpHttpConfig({
    accessMode: 'ip',
    bindHost: '::1',
    port: 0,
    allowedCidrs: ['::1/128'],
    allowedHosts: ['[::1]'],
  })
  assert.deepEqual(ipv6Host.allowedHosts, ['[::1]'])
})

await test('core startup configuration rejects a missing explicitly selected provider profile', () => {
  assert.throws(() => parseMcpConfig({ profiles: {}, defaultProfileId: 'missing' }))
})

async function freePort(): Promise<number> {
  const server = createNodeServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}

async function connectClient(port: number) {
  const client = new Client({ name: 'classifier-noauth-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
  return { client }
}

function rawRequest(
  port: number,
  headers: Record<string, string | string[]>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const request = nodeRequest(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers },
      (response) => {
        response.resume()
        response.once('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers }),
        )
      },
    )
    request.once('error', reject)
    request.end('{}')
  })
}

function rawDuplicateHost(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let response = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('Duplicate Host request did not finish promptly.'))
    }, 2_000)
    socket.once('connect', () => {
      socket.write(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      )
    })
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('latin1')
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.once('close', () => {
      clearTimeout(timer)
      const match = /^HTTP\/1\.1 ([0-9]{3})/u.exec(response)
      if (!match?.[1]) reject(new Error('Duplicate Host request returned no HTTP response.'))
      else resolve(Number(match[1]))
    })
  })
}

async function assertIncompleteBodyIsClosed(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = nodeRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${port}`,
          'Content-Type': 'application/json',
          'Content-Length': '100',
        },
      },
      (response) => response.resume(),
    )
    const timer = setTimeout(() => {
      request.destroy()
      reject(new Error('Partial HTTP body did not close within its timeout.'))
    }, 3_000)
    request.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    request.once('error', (error) => {
      clearTimeout(timer)
      if (request.destroyed || ('code' in error && error.code === 'ECONNRESET')) resolve()
      else reject(error)
    })
    request.write('{')
  })
}
