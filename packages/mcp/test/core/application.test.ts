import assert from 'node:assert/strict'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import type { DecisionPort } from 'zorya-classifier'
import sharp from 'sharp'
import { z } from 'zod'

import type { McpConfigInput } from '../../src/config.js'
import type {
  ArtifactDescriptor,
  ArtifactPort,
  CredentialPort,
  ImagePayload,
  MediaPort,
  Principal,
} from '../../src/contracts.js'
import { createCoreApplication } from '../../src/core/application.js'
import { McpCoreError } from '../../src/errors.js'
import { startStdioServer } from '../../src/stdio/server.js'
import { createPrincipalScopedMcpServer } from '../../src/tools/mcp-server.js'
import { classifyToolInputSchema } from '../../src/tools/schemas.js'

const principalA: Principal = {
  ownerId: 'test-owner-a',
  transport: 'stdio',
}
const principalB: Principal = {
  ownerId: 'test-owner-b',
  transport: 'stdio',
}
const responseMetadata = {
  model: null,
  provider: null,
  requestId: null,
  durationMs: 0,
  costUsd: null,
  attempts: 1,
}

function firstChoicePort(): DecisionPort {
  return {
    decide: async (request, signal) => {
      signal.throwIfAborted()
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => {
          if (question.type === 'noul') return [id, { type: 'noul' as const, noul: 1 }]
          const keys = Object.keys(question.criteria)
          const choice = keys[0] ?? ''
          const probabilities = Object.fromEntries(
            keys.map((key, index) => [key, index === 0 ? 1 : 0]),
          )
          return [id, { type: 'choice' as const, choice, probabilities }]
        }),
      )
      return { answers, metadata: responseMetadata }
    },
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error('Deferred promise is not ready.')
      resolvePromise(value)
    },
  }
}

function testConfig(limits: Record<string, unknown> = {}): McpConfigInput {
  const config: McpConfigInput = {
    profiles: {
      injected: {
        id: 'injected',
        adapter: 'injected-decision',
        credentialMode: 'none',
      },
    },
    defaultProfileId: 'injected',
  }
  return Object.keys(limits).length === 0 ? config : { ...config, limits }
}

function createTestPorts(imageBytes: Uint8Array): {
  mediaPort: MediaPort
  artifactPort: ArtifactPort
  credentialPort: CredentialPort
  artifacts: Map<
    string,
    { ownerId: string; jobId: string; bytes: Uint8Array; descriptor: ArtifactDescriptor }
  >
} {
  const artifacts = new Map<
    string,
    { ownerId: string; jobId: string; bytes: Uint8Array; descriptor: ArtifactDescriptor }
  >()
  const mediaPort: MediaPort = {
    async loadImage(): Promise<ImagePayload> {
      return {
        bytes: Uint8Array.from(imageBytes),
        mediaType: 'image/png',
        width: 32,
        height: 32,
      }
    },
  }
  const artifactPort: ArtifactPort = {
    async put(input) {
      const id = crypto.randomUUID()
      const descriptor: ArtifactDescriptor = {
        id,
        role: input.role,
        mediaType: input.mediaType,
        byteLength: input.bytes.byteLength,
        expiresAt: input.expiresAt,
        ...(input.width === undefined ? {} : { width: input.width }),
        ...(input.height === undefined ? {} : { height: input.height }),
        ...(input.encoding === undefined ? {} : { encoding: input.encoding }),
      }
      artifacts.set(id, {
        ownerId: input.ownerId,
        jobId: input.jobId,
        bytes: Uint8Array.from(input.bytes),
        descriptor,
      })
      return descriptor
    },
    async read(input) {
      const artifact = artifacts.get(input.artifactId)
      if (artifact === undefined || artifact.ownerId !== input.ownerId) {
        throw new McpCoreError('NOT_FOUND', 'Artifact was not found.')
      }
      return { bytes: Uint8Array.from(artifact.bytes), mediaType: artifact.descriptor.mediaType }
    },
    async deleteJob(input) {
      for (const [id, artifact] of artifacts) {
        if (artifact.ownerId === input.ownerId && artifact.jobId === input.jobId)
          artifacts.delete(id)
      }
    },
    async deleteOwner(ownerId) {
      for (const [id, artifact] of artifacts) {
        if (artifact.ownerId === ownerId) artifacts.delete(id)
      }
    },
  }
  const credentialPort: CredentialPort = {
    async resolve() {
      throw new Error('Injected profiles must never resolve credentials.')
    },
  }
  return { mediaPort, artifactPort, credentialPort, artifacts }
}

async function waitForJob(
  app: ReturnType<typeof createCoreApplication>,
  principal: Principal,
  jobId: string,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let lastSnapshot = 'no job snapshot received'
  while (Date.now() < deadline) {
    const snapshot = await app.invoke({
      toolName: 'zorya_get_job',
      args: { jobId },
      principal,
      signal: new AbortController().signal,
    })
    const state = z.string().parse(snapshot['state'])
    const error = z.object({ code: z.string().max(64) }).safeParse(snapshot['error'])
    lastSnapshot = JSON.stringify({
      state,
      hasResult: Object.hasOwn(snapshot, 'result'),
      artifactCount: Array.isArray(snapshot['artifacts']) ? snapshot['artifacts'].length : 0,
      ...(error.success ? { errorCode: error.data.code } : {}),
    })
    if (state === 'succeeded' || state === 'failed' || state === 'cancelled') return snapshot
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(
    `Job did not reach a terminal state within ${timeoutMs}ms; last snapshot: ${lastSnapshot}`,
  )
}

function jobIdFrom(result: Record<string, unknown>): string {
  return z.string().uuid().parse(result['jobId'])
}

await test('injected DecisionPort classification uses no model fallback or credential lookup', async () => {
  const imageBytes = await sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer()
  const ports = createTestPorts(Uint8Array.from(imageBytes))
  const app = createCoreApplication({
    config: testConfig(),
    mediaPort: ports.mediaPort,
    artifactPort: ports.artifactPort,
    credentialPort: ports.credentialPort,
    injectedDecisionPorts: { injected: firstChoicePort() },
  })

  const submitted = await app.invoke({
    toolName: 'zorya_classify',
    args: {
      text: 'A short test sentence.',
      classes: [
        { id: 'label-a', description: 'Label A' },
        { id: 'label-b', description: 'Label B' },
      ],
    },
    principal: principalA,
    signal: new AbortController().signal,
  })
  assert.equal(submitted['state'], 'queued')
  const job = await waitForJob(app, principalA, jobIdFrom(submitted))
  assert.equal(job['state'], 'succeeded', JSON.stringify(job['error']))
  const result = job['result']
  assert.equal(typeof result, 'object')
  assert.equal(ports.artifacts.size, 0)
  await app.shutdown()
})

await test('default input-byte limits admit inline image classification and reject oversized queued input', async () => {
  const imageBytes = await sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 12, g: 22, b: 32, alpha: 1 } },
  })
    .png()
    .toBuffer()
  const png = Uint8Array.from(imageBytes)
  const ports = createTestPorts(png)
  const app = createCoreApplication({
    config: testConfig(),
    mediaPort: ports.mediaPort,
    artifactPort: ports.artifactPort,
    injectedDecisionPorts: { injected: firstChoicePort() },
  })
  const submitted = await app.invoke({
    toolName: 'zorya_classify',
    args: {
      image: { kind: 'inlineBase64', data: Buffer.from(png).toString('base64') },
      classes: [
        { id: 'label-a', description: 'Label A' },
        { id: 'label-b', description: 'Label B' },
      ],
    },
    principal: principalA,
    signal: new AbortController().signal,
  })
  assert.equal(submitted['state'], 'queued')
  const completed = await waitForJob(app, principalA, jobIdFrom(submitted))
  assert.equal(completed['state'], 'succeeded', JSON.stringify(completed['error']))
  await app.shutdown()

  const boundedApp = createCoreApplication({
    config: testConfig({ maxQueuedInputBytesPerOwner: 1_024 }),
    mediaPort: ports.mediaPort,
    artifactPort: ports.artifactPort,
    injectedDecisionPorts: { injected: firstChoicePort() },
  })
  await assert.rejects(
    boundedApp.invoke({
      toolName: 'zorya_classify',
      args: {
        text: 'x'.repeat(2_000),
        classes: [
          { id: 'label-a', description: 'Label A' },
          { id: 'label-b', description: 'Label B' },
        ],
      },
      principal: principalA,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof McpCoreError && error.code === 'CAPACITY_LIMIT',
  )
  await boundedApp.shutdown()
})

await test('maximum advertised inline Base64 input validates without regex stack growth', () => {
  const maximumData = `${'A'.repeat(22_369_620)}AA==`
  const input = {
    image: { kind: 'inlineBase64', data: maximumData },
    classes: [
      { id: 'label-a', description: 'Label A' },
      { id: 'label-b', description: 'Label B' },
    ],
  }
  assert.equal(maximumData.length, 22_369_624)
  assert.equal(classifyToolInputSchema.safeParse(input).success, true)
  assert.equal(
    classifyToolInputSchema.safeParse({
      ...input,
      image: { kind: 'inlineBase64', data: `${'A'.repeat(22_369_620)}A===` },
    }).success,
    false,
  )
  assert.equal(
    classifyToolInputSchema.safeParse({
      ...input,
      image: { kind: 'inlineBase64', data: 'AB==' },
    }).success,
    false,
  )
})

await test('job JSON resources obey the configured serialized-result byte limit', async () => {
  const ports = createTestPorts(new Uint8Array())
  const delegate = firstChoicePort()
  const decisionPort: DecisionPort = {
    async decide(request, signal) {
      const result = await delegate.decide(request, signal)
      return {
        ...result,
        metadata: { ...result.metadata, requestId: 'r'.repeat(700) },
      }
    },
  }
  const app = createCoreApplication({
    config: testConfig({ maxResultJsonBytes: 1_024 }),
    mediaPort: ports.mediaPort,
    artifactPort: ports.artifactPort,
    injectedDecisionPorts: { injected: decisionPort },
  })
  const submitted = await app.invoke({
    toolName: 'zorya_classify',
    args: {
      text: 'A short bounded-result test.',
      classes: [
        { id: 'label-a', description: 'Label A' },
        { id: 'label-b', description: 'Label B' },
      ],
    },
    principal: principalA,
    signal: new AbortController().signal,
  })
  const jobId = jobIdFrom(submitted)
  const deadline = Date.now() + 2_000
  let boundedResourceRejected = false
  while (Date.now() < deadline) {
    try {
      const snapshot = await app.invoke({
        toolName: 'zorya_get_job',
        args: { jobId },
        principal: principalA,
        signal: new AbortController().signal,
      })
      if (snapshot['state'] === 'failed') {
        assert.fail('The individual result exceeded the configured byte limit.')
      }
    } catch (error) {
      assert.ok(error instanceof McpCoreError && error.code === 'RESOURCE_LIMIT')
      await assert.rejects(
        app.readResource({
          uri: `zorya://jobs/${jobId}`,
          principal: principalA,
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 1_000,
        }),
        (resourceError: unknown) =>
          resourceError instanceof McpCoreError && resourceError.code === 'RESOURCE_LIMIT',
      )
      boundedResourceRejected = true
      break
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(boundedResourceRejected, true)
  await app.shutdown()
})

await test('HTTP capabilities report only explicitly composed remote and upload inputs', async () => {
  const ports = createTestPorts(new Uint8Array())
  const app = createCoreApplication({
    config: testConfig(),
    mediaPort: ports.mediaPort,
    artifactPort: ports.artifactPort,
    mediaCapabilities: { remote: true, uploads: true },
    injectedDecisionPorts: { injected: firstChoicePort() },
  })
  const principal: Principal = {
    ownerId: 'verified-http-owner',
    transport: 'http',
    identity: { issuer: 'https://issuer.example', subject: 'subject-1', scopes: [] },
  }
  const response = await app.invoke({
    toolName: 'zorya_capabilities',
    args: {},
    principal,
    signal: new AbortController().signal,
  })
  const transport = z.object({ active: z.string() }).parse(response['transport'])
  assert.equal(transport.active, 'http')
  const inputs = z
    .object({
      localPath: z.boolean(),
      url: z.boolean(),
      chatgptFile: z.boolean(),
      uploadedId: z.boolean(),
    })
    .parse(response['inputs'])
  assert.deepEqual(inputs, {
    localPath: false,
    url: true,
    chatgptFile: true,
    uploadedId: true,
  })
  await app.shutdown()
})

await test('text-only profiles report their model and disable spatial capabilities', async () => {
  const ports = createTestPorts(new Uint8Array())
  const app = createCoreApplication({
    config: {
      profiles: {
        localText: {
          id: 'localText',
          adapter: 'openai-compatible-text',
          model: 'operator-text-model',
          endpoint: 'http://127.0.0.1:8000/v1',
          credentialMode: 'none',
        },
      },
      defaultProfileId: 'localText',
    },
    mediaPort: ports.mediaPort,
    artifactPort: ports.artifactPort,
  })
  const response = await app.invoke({
    toolName: 'zorya_capabilities',
    args: {},
    principal: principalA,
    signal: new AbortController().signal,
  })
  const profiles = z
    .array(z.object({ id: z.string(), model: z.string() }))
    .parse(response['profiles'])
  assert.deepEqual(profiles, [{ id: 'localText', model: 'operator-text-model' }])
  const operations = z
    .object({ locateRegion: z.boolean(), locateWholeObject: z.boolean(), extract: z.boolean() })
    .parse(response['operations'])
  assert.deepEqual(operations, {
    locateRegion: false,
    locateWholeObject: false,
    extract: false,
  })
  await app.shutdown()
})

await test('job cancellation reaches the published DecisionPort and holds the slot through settlement', async () => {
  const ports = createTestPorts(new Uint8Array())
  const firstStarted = deferred<{
    request: Parameters<DecisionPort['decide']>[0]
    signal: AbortSignal
  }>()
  const releaseFirst = deferred<Awaited<ReturnType<DecisionPort['decide']>>>()
  let calls = 0
  const decisionPort: DecisionPort = {
    async decide(request, signal) {
      calls += 1
      if (calls === 1) {
        firstStarted.resolve({ request, signal })
        return releaseFirst.promise
      }
      return firstChoicePort().decide(request, signal)
    },
  }
  const app = createCoreApplication({
    config: testConfig(),
    mediaPort: ports.mediaPort,
    artifactPort: ports.artifactPort,
    credentialPort: ports.credentialPort,
    injectedDecisionPorts: { injected: decisionPort },
  })
  const args = {
    text: 'A short test sentence.',
    classes: [
      { id: 'label-a', description: 'Label A' },
      { id: 'label-b', description: 'Label B' },
    ],
  }
  const first = await app.invoke({
    toolName: 'zorya_classify',
    args,
    principal: principalA,
    signal: new AbortController().signal,
  })
  const firstJobId = jobIdFrom(first)
  const started = await firstStarted.promise
  const second = await app.invoke({
    toolName: 'zorya_classify',
    args,
    principal: principalB,
    signal: new AbortController().signal,
  })
  const secondJobId = jobIdFrom(second)
  assert.equal(second['state'], 'queued')

  const cancelled = await app.invoke({
    toolName: 'zorya_cancel_job',
    args: { jobId: firstJobId },
    principal: principalA,
    signal: new AbortController().signal,
  })
  assert.equal(cancelled['state'], 'cancelling')
  assert.equal(started.signal.aborted, true)
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  assert.equal(calls, 1)

  releaseFirst.resolve(
    await firstChoicePort().decide(started.request, new AbortController().signal),
  )
  await waitForJob(app, principalA, firstJobId)
  const secondJob = await waitForJob(app, principalB, secondJobId)
  assert.equal(secondJob['state'], 'succeeded')
  assert.equal(calls, 2)
  await app.shutdown()
})

await test('source artifacts and job resources are private to the server-derived principal', async () => {
  const imageBytes = await sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 80, g: 90, b: 100, alpha: 1 } },
  })
    .png()
    .toBuffer()
  const png = Uint8Array.from(imageBytes)
  const ports = createTestPorts(png)
  const app = createCoreApplication({
    config: testConfig(),
    mediaPort: ports.mediaPort,
    artifactPort: ports.artifactPort,
    credentialPort: ports.credentialPort,
    injectedDecisionPorts: { injected: firstChoicePort() },
  })

  try {
    const submitted = await app.invoke({
      toolName: 'zorya_locate',
      args: {
        image: { kind: 'inlineBase64', data: Buffer.from(png).toString('base64') },
        target: 'object',
        mode: 'region',
      },
      principal: principalA,
      signal: new AbortController().signal,
    })
    const jobId = jobIdFrom(submitted)
    const job = await waitForJob(app, principalA, jobId, 15_000)
    assert.equal(job['state'], 'succeeded')
    const artifacts = z
      .array(z.object({ id: z.string(), role: z.string() }))
      .parse(job['artifacts'])
    const source = artifacts.find((artifact) => artifact.role === 'source')
    assert.ok(source)

    const binary = await app.readResource({
      uri: `zorya://artifacts/${source.id}`,
      principal: principalA,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000,
    })
    assert.equal(binary.kind, 'binary')
    if (binary.kind !== 'binary') assert.fail('Expected binary artifact contents.')
    assert.deepEqual(binary.bytes, png)

    const jobDocument = await app.readResource({
      uri: `zorya://jobs/${jobId}`,
      principal: principalA,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000,
    })
    assert.equal(jobDocument.kind, 'json')
    await assert.rejects(
      app.readResource({
        uri: `zorya://jobs/${jobId}`,
        principal: principalB,
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 1_000,
      }),
      (error: unknown) => error instanceof McpCoreError && error.code === 'NOT_FOUND',
    )
    await assert.rejects(
      app.readResource({
        uri: `zorya://artifacts/${source.id}`,
        principal: principalB,
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 1_000,
      }),
      (error: unknown) => error instanceof McpCoreError && error.code === 'NOT_FOUND',
    )
  } finally {
    await app.shutdown()
  }
})

await test('principal-scoped MCP server registers six tools and private resources on the real SDK', async () => {
  const imageBytes = await sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
  })
    .png()
    .toBuffer()
  const ports = createTestPorts(Uint8Array.from(imageBytes))
  const app = createCoreApplication({
    config: testConfig(),
    mediaPort: ports.mediaPort,
    artifactPort: ports.artifactPort,
    credentialPort: ports.credentialPort,
    injectedDecisionPorts: { injected: firstChoicePort() },
  })
  assert.throws(() => startStdioServer(app, { maxBufferSize: 0 }))
  assert.throws(() => createPrincipalScopedMcpServer(app, principalA, { resourceTimeoutMs: 1 }))
  const server = createPrincipalScopedMcpServer(app, principalA)
  const client = new Client({ name: 'zorya-mcp-test', version: '0.1.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  const listed = await client.listTools()
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    'zorya_cancel_job',
    'zorya_capabilities',
    'zorya_classify',
    'zorya_extract',
    'zorya_get_job',
    'zorya_locate',
  ])
  const capabilities = await client.callTool({ name: 'zorya_capabilities', arguments: {} })
  assert.equal(capabilities.isError, undefined)
  const capabilityPayload = z.record(z.string(), z.json()).parse(capabilities.structuredContent)
  const transportCapabilities = z
    .object({ active: z.string(), supportedProtocols: z.array(z.string()) })
    .parse(capabilityPayload['transport'])
  assert.equal(transportCapabilities.active, 'stdio')
  assert.ok(transportCapabilities.supportedProtocols.includes('stdio:2026-07-28'))
  const inputCapabilities = z
    .object({
      inlineBase64: z.boolean(),
      localPath: z.boolean(),
      url: z.boolean(),
      chatgptFile: z.boolean(),
      uploadedId: z.boolean(),
    })
    .parse(capabilityPayload['inputs'])
  assert.deepEqual(inputCapabilities, {
    inlineBase64: true,
    localPath: false,
    url: false,
    chatgptFile: false,
    uploadedId: false,
  })
  const submitted = await client.callTool({
    name: 'zorya_classify',
    arguments: {
      text: 'A short protocol test.',
      classes: [
        { id: 'label-a', description: 'Label A' },
        { id: 'label-b', description: 'Label B' },
      ],
    },
  })
  assert.equal(submitted.isError, undefined)
  const submittedContent = z.record(z.string(), z.json()).parse(submitted.structuredContent)
  const jobId = z.string().uuid().parse(submittedContent['jobId'])
  const snapshot = await client.callTool({ name: 'zorya_get_job', arguments: { jobId } })
  assert.equal(snapshot.isError, undefined)
  await client.close()
  await server.close()
  await app.shutdown()
})
