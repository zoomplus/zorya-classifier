import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { join, resolve, sep, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const consumerRoot = process.env['MCP_CONSUMER_ROOT']
const packageEntry = process.env['MCP_PACKAGE_ENTRY']
const libraryEntry = process.env['MCP_LIBRARY_ENTRY']
const cliEntry = process.env['MCP_CLI_ENTRY']
const enabled =
  consumerRoot !== undefined &&
  packageEntry !== undefined &&
  libraryEntry !== undefined &&
  cliEntry !== undefined
const childEnvironment = Object.fromEntries(
  ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
)
const expectedTools = [
  'zorya_cancel_job',
  'zorya_capabilities',
  'zorya_classify',
  'zorya_extract',
  'zorya_get_job',
  'zorya_locate',
]

test(
  'installed archive import starts no network, child process, timer, or listener work',
  { skip: !enabled },
  () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./import-probe.mjs', import.meta.url)), packageEntry, cliEntry],
      { encoding: 'utf8', timeout: 10_000, shell: false, windowsHide: true },
    )
    assert.equal(result.status, 0, 'Import probe failed without exposing captured output.')
    assert.equal(result.stdout, 'import-inert\n')
    assert.equal(result.stderr, '')
  },
)

test(
  'installed archive serves all six tools over modern and legacy stdio SDK clients',
  { skip: !enabled, timeout: 90_000 },
  async () => {
    for (const versionNegotiation of [{ mode: { pin: '2026-07-28' } }, { mode: 'legacy' }]) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./stdio-fixture.mjs', import.meta.url)),
          packageEntry,
          libraryEntry,
        ],
        cwd: consumerRoot,
        env: childEnvironment,
        stderr: 'pipe',
        maxBufferSize: 32 * 1024 * 1024,
      })
      const client = new Client(
        { name: 'mcp-installed-consumer-smoke', version: '0.1.0' },
        { versionNegotiation },
      )
      try {
        await client.connect(transport)
        await exerciseSixTools(client, 'stdio')
        await exercisePhysicalCancellation(client)
      } finally {
        await client.close()
      }
    }
  },
)

test(
  'installed archive shares jobs across modern and legacy Streamable HTTP, legacy SSE, and isolates owners',
  { skip: !enabled, timeout: 90_000 },
  async () => {
    const api = await import(pathToFileURL(packageEntry).href)
    const library = await import(pathToFileURL(libraryEntry).href)
    const runtime = await createFixtureRuntime(api, library)
    const principals = new Map([
      ['token-owner-a', principal('owner-a', 'subject-a')],
      ['token-owner-b', principal('owner-b', 'subject-b')],
    ])
    const httpConfig = api.parseHttpConfig({
      bindHost: '127.0.0.1',
      port: 0,
      publicOrigin: 'http://127.0.0.1',
      resourceUrl: 'https://mcp.example.test/mcp',
      resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
      issuer: 'https://issuer.example.test',
      audience: 'https://mcp.example.test/mcp',
      requiredScopes: ['mcp:invoke'],
      allowedHosts: ['127.0.0.1'],
      allowedOrigins: [],
    })
    const server = api.createHttpServer({
      config: httpConfig,
      artifactStore: runtime.artifactStore,
      authenticator: {
        async authenticate(request) {
          const token = request.headers.get('authorization')?.replace(/^Bearer /u, '')
          return token === undefined ? undefined : principals.get(token)
        },
        challenge() {
          return new Response(null, { status: 401 })
        },
      },
      createServerForPrincipal(principalValue) {
        return api.createPrincipalScopedMcpServer(runtime.application, principalValue)
      },
    })
    server.server.listen(0, '127.0.0.1')
    await once(server.server, 'listening')
    const address = server.server.address()
    assert.ok(address && typeof address !== 'string')
    const endpoint = `http://127.0.0.1:${address.port}`
    const modern = await connectHttpClient(endpoint, 'token-owner-a', 'http-modern')
    const legacyStreamable = await connectHttpClient(
      endpoint,
      'token-owner-a',
      'http-streamable-legacy',
    )
    const legacySse = await connectHttpClient(endpoint, 'token-owner-a', 'http-sse-legacy')
    const otherOwner = await connectHttpClient(endpoint, 'token-owner-b', 'modern')
    try {
      const created = await exerciseSixTools(modern.client, 'http-modern')
      const streamableShared = await tool(legacyStreamable.client, 'zorya_get_job', {
        jobId: created.classification.jobId,
      })
      assert.equal(streamableShared.id, created.classification.jobId)
      assert.equal(streamableShared.state, 'succeeded')
      const sseShared = await tool(legacySse.client, 'zorya_get_job', {
        jobId: created.classification.jobId,
      })
      assert.equal(sseShared.id, created.classification.jobId)
      assert.equal(sseShared.state, 'succeeded')

      const sourceArtifact = created.extraction.artifacts.find(
        (artifact) => artifact.role === 'source',
      )
      assert.ok(sourceArtifact, 'Extraction should expose the owner-scoped source artifact.')
      const ownArtifact = await legacyStreamable.client.readResource({
        uri: `zorya://artifacts/${sourceArtifact.id}`,
      })
      assert.equal(ownArtifact.contents[0]?.mimeType, sourceArtifact.mediaType)
      await assert.rejects(
        otherOwner.client.readResource({ uri: `zorya://artifacts/${sourceArtifact.id}` }),
      )

      const deniedJob = await otherOwner.client.callTool({
        name: 'zorya_get_job',
        arguments: { jobId: created.classification.jobId },
      })
      assert.equal(deniedJob.isError, true)
      assert.equal(JSON.stringify(deniedJob).includes('owner-a'), false)

      await exerciseSixTools(legacyStreamable.client, 'http-streamable-legacy')
      await exerciseSixTools(legacySse.client, 'http-sse-legacy')
      await exercisePhysicalCancellation(modern.client, runtime)
      await exercisePhysicalCancellation(legacyStreamable.client, runtime)
      await exercisePhysicalCancellation(legacySse.client, runtime)
    } finally {
      const closeResults = await Promise.allSettled([
        modern.client.close(),
        legacyStreamable.client.close(),
        legacySse.client.close(),
        otherOwner.client.close(),
      ])
      await server.shutdown()
      await runtime.close()
      assert.equal(
        closeResults.filter((result) => result.status === 'rejected').length,
        0,
        'An installed SDK client did not close cleanly.',
      )
    }
  },
)

test(
  'published adapter factory preserves route semantics and typed failures with controlled fetches',
  { skip: !enabled, timeout: 30_000 },
  async () => {
    const api = await import(pathToFileURL(packageEntry).href)
    const originalFetch = globalThis.fetch
    const calls = []
    const diagnostics = []
    const sharpEntry = await packageExport(consumerRoot, 'sharp')
    const { default: sharp } = await import(pathToFileURL(sharpEntry).href)
    try {
      globalThis.fetch = async (input, init) => {
        const url = String(input)
        const body = JSON.parse(String(init?.body))
        calls.push({ url, init })
        if (typeof body.model !== 'string') diagnostics.push('request model was absent')
        if (url === 'https://openrouter.ai/api/alpha/decisions') {
          if (
            JSON.stringify(body.provider) !==
            JSON.stringify({
              only: ['fixture'],
              allow_fallbacks: false,
            })
          )
            diagnostics.push(
              `native provider routing was not pinned: ${JSON.stringify(body.provider)}`,
            )
          if (JSON.stringify(body).includes('sort'))
            diagnostics.push('native request contains forbidden sorting')
          try {
            await assertPreparedImageParts(body.state, sharp)
          } catch (error) {
            diagnostics.push(
              error instanceof Error ? error.message : 'native image validation failed',
            )
          }
          return new Response(
            JSON.stringify({
              id: 'controlled-native-response',
              model: body.model,
              provider: 'fixture',
              answers: {
                selection: {
                  type: 'choice',
                  choice: 'second',
                  probabilities: { first: 0.17, second: 0.83 },
                },
              },
              usage: { cost: 0 },
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        }
        if (url !== 'https://provider.example.test/v1/chat/completions')
          diagnostics.push(`unexpected controlled adapter URL: ${url}`)
        const userMessage = body.messages?.find((message) => message.role === 'user')
        if (!userMessage || !Array.isArray(userMessage.content)) {
          diagnostics.push('vision chat message did not contain content parts')
        } else {
          try {
            await assertPreparedImageParts(userMessage.content, sharp)
          } catch (error) {
            diagnostics.push(
              error instanceof Error ? error.message : 'vision image validation failed',
            )
          }
        }
        return new Response(
          JSON.stringify({
            model: body.model,
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({ answers: { selection: { ranking: ['second'] } } }),
                },
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      }

      const ordinary = await runPublishedProfile(api, {
        id: 'ordinary',
        adapter: 'openai-compatible-vision',
        credentialMode: 'none',
        endpoint: 'https://provider.example.test/v1/chat/completions',
        model: 'fixture/ordinary-vision',
      })
      assert.equal(ordinary.choice, 'second')
      assert.deepEqual(ordinary.ranking, ['second'])
      assert.equal(ordinary.probabilities, null)
      assert.equal(ordinary.nativeChoice, null)

      const native = await runPublishedProfile(
        api,
        {
          id: 'native',
          adapter: 'openrouter-native',
          credentialMode: 'byok',
          model: 'fixture/native',
          provider: 'fixture',
        },
        'controlled-fixture-key',
      )
      assert.equal(native.choice, 'second')
      assert.equal(native.nativeChoice, 'second')
      assert.deepEqual(native.probabilities, { first: 0.17, second: 0.83 })
      assert.deepEqual(diagnostics, [])
      assert.equal(calls.length, 2)
      assert.ok(calls.every((call) => call.init?.redirect === 'error'))

      globalThis.fetch = async () => {
        throw new Error('controlled transport failure')
      }
      await assert.rejects(
        runPublishedProfile(api, {
          id: 'failure',
          adapter: 'openai-compatible-vision',
          credentialMode: 'none',
          endpoint: 'https://provider.example.test/v1/chat/completions',
          model: 'fixture/failure',
        }),
        (error) => error?.code === 'PROVIDER',
      )
      assert.equal(calls.length, 2, 'Transport refusal must not fall back to another provider.')
    } finally {
      globalThis.fetch = originalFetch
    }
  },
)

test(
  'missing caller-owned segmentation asset is a typed setup failure with no download attempt',
  { skip: !enabled, timeout: 10_000 },
  async () => {
    const api = await import(pathToFileURL(packageEntry).href)
    const config = api.parseMcpConfig({
      profiles: {
        fixture: { id: 'fixture', adapter: 'injected-decision', credentialMode: 'none' },
      },
      defaultProfileId: 'fixture',
      segmentation: {
        kind: 'grabcut',
        assetPath: join(tmpdir(), `missing-zorya-opencv-${Date.now()}.js`),
      },
    })
    const originalFetch = globalThis.fetch
    let attemptedDownloads = 0
    globalThis.fetch = async () => {
      attemptedDownloads++
      throw new Error('Unexpected asset download attempt.')
    }
    try {
      const factory = new api.PublishedClassifierFactory(config)
      await assert.rejects(
        factory.create({
          profile: config.profiles.fixture,
          decisionPort: {
            async decide() {
              throw new Error('DecisionPort must not run during asset validation.')
            },
          },
          principal: principal('asset-owner', 'asset-subject'),
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 5_000,
        }),
        (error) => error?.code === 'UNSUPPORTED',
      )
      assert.equal(attemptedDownloads, 0)
    } finally {
      globalThis.fetch = originalFetch
    }
  },
)

async function runPublishedProfile(api, profile, apiKey) {
  const config = api.parseMcpConfig({
    profiles: { [profile.id]: profile },
    defaultProfileId: profile.id,
  })
  const factory = new api.PublishedClassifierFactory(config)
  const input = {
    profile: config.profiles[profile.id],
    principal: principal('adapter-owner', 'adapter-subject'),
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
  }
  const lease =
    apiKey === undefined ? await factory.create(input) : await factory.create({ ...input, apiKey })
  try {
    const response = await lease.classifier.classify({
      input: { text: 'offline controlled provider adapter fixture', image: await fixturePng() },
      classes: [
        { id: 'first', description: 'First class fixture' },
        { id: 'second', description: 'Second class fixture' },
      ],
    })
    return response
  } finally {
    await lease.dispose({ signal: new AbortController().signal, deadlineAt: Date.now() + 5_000 })
  }
}

async function assertPreparedImageParts(state, sharp) {
  assert.ok(Array.isArray(state), 'Vision request state is not an array.')
  const images = state.filter((part) => part?.type === 'image_url')
  assert.equal(images.length, 1, 'Vision request must include exactly one prepared image part.')
  const url = images[0]?.image_url?.url
  assert.equal(typeof url, 'string')
  assert.match(url, /^data:image\/png;base64,/u)
  const bytes = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
  const metadata = await sharp(bytes).metadata()
  assert.ok(metadata.width >= 280 && metadata.width <= 1568)
  assert.ok(metadata.height >= 280 && metadata.height <= 1568)
}

async function createFixtureRuntime(api, library) {
  const artifactStore = api.createPrivateArtifactStore({
    maxGlobalBytes: 16 * 1024 * 1024,
    maxOwnerBytes: 8 * 1024 * 1024,
    maxArtifactBytes: 4 * 1024 * 1024,
    maxArtifacts: 128,
    maxArtifactsPerOwner: 64,
    ttlMs: 60_000,
  })
  const controls = createDecisionControls()
  const segmenter = createSegmenter()
  const classifierFactory = {
    async create(input) {
      if (!('decisionPort' in input))
        throw new Error('Offline runtime expected an injected DecisionPort.')
      const classifier = library.createClassifier({
        decision: input.decisionPort,
        segmentation: segmenter,
      })
      return {
        classifier,
        segmenter,
        async dispose() {
          await classifier.dispose()
        },
      }
    },
  }
  const application = api.createCoreApplication({
    config: fixtureConfig(),
    artifactPort: artifactStore,
    mediaPort: api.createMediaPort({ remote: { trustedHosts: [] }, maxPixels: 1024 }),
    classifierFactory,
    injectedDecisionPorts: { fixture: controls.port },
    mediaCapabilities: { remote: false, uploads: false },
  })
  return {
    application,
    artifactStore,
    ...controls,
    async close() {
      await application.shutdown()
      await segmenter.settle()
      await segmenter.dispose()
      await artifactStore.dispose()
    },
  }
}

function fixtureConfig() {
  return {
    profiles: { fixture: { id: 'fixture', adapter: 'injected-decision', credentialMode: 'none' } },
    defaultProfileId: 'fixture',
    // Core requires declared segmentation support; the injected fixture port never opens this marker path.
    segmentation: { kind: 'grabcut', assetPath: 'offline-fixture-asset-not-opened.xml' },
    limits: {
      maxImageBytes: 1_048_576,
      maxImagePixels: 1024,
      maxQueuedJobs: 16,
      maxQueuedJobsPerOwner: 8,
      maxStoredJobs: 64,
      maxStoredJobsPerOwner: 32,
      maxQueuedInputBytes: 8 * 1024 * 1024,
      maxQueuedInputBytesPerOwner: 4 * 1024 * 1024,
      maxActiveJobs: 1,
      maxActiveJobsPerOwner: 1,
      jobTimeoutMs: 30_000,
      jobTtlMs: 60_000,
      artifactTtlMs: 60_000,
      maxArtifactBytes: 4 * 1024 * 1024,
      maxArtifactTotalBytes: 16 * 1024 * 1024,
      maxArtifactTotalBytesPerOwner: 8 * 1024 * 1024,
      maxResultJsonBytes: 1_048_576,
    },
  }
}

function createDecisionControls() {
  let armed
  const port = {
    async decide(request) {
      if (armed !== undefined) {
        const gate = armed
        armed = undefined
        gate.markEntered()
        await gate.blocked
      }
      const answers = {}
      for (const [key, question] of Object.entries(request.questions)) {
        if (question.type === 'choice') {
          const ids = Object.keys(question.criteria)
          const choice = ids[0]
          if (choice === undefined) throw new Error('Offline choice criteria are empty.')
          answers[key] = {
            type: 'choice',
            choice,
            probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
          }
        } else answers[key] = { type: 'noul', noul: 0.95 }
      }
      return {
        answers,
        metadata: {
          model: null,
          provider: null,
          requestId: 'controlled-offline-decision',
          durationMs: 0,
          costUsd: null,
          attempts: 1,
        },
      }
    },
  }
  return {
    port,
    arm() {
      let enteredResolve
      let releaseResolve
      const entered = new Promise((resolve) => {
        enteredResolve = resolve
      })
      const blocked = new Promise((resolve) => {
        releaseResolve = resolve
      })
      const gate = { blocked, markEntered: enteredResolve, release: releaseResolve }
      armed = gate
      return { entered, release: gate.release }
    },
  }
}

function createSegmenter() {
  let disposed = false
  return {
    async segment(input) {
      if (disposed) throw new Error('Offline fixture segmenter was disposed before its runtime.')
      const { width, height } = input.image
      const data = new Uint8Array(width * height)
      for (let offset = 2; offset <= 6; offset++) {
        data[2 * width + offset] = 1
        data[offset * width + 2] = 1
      }
      return {
        status: 'segmented',
        mask: {
          data,
          width,
          height,
          format: 'binary-u8',
        },
        metadata: {
          method: 'consumer-fixture',
          backend: 'offline',
          durationMs: 0,
          input: { width, height },
        },
      }
    },
    async settle() {},
    async dispose() {
      disposed = true
    },
  }
}

async function exerciseSixTools(client, label) {
  const listed = await client.listTools()
  assert.deepEqual(listed.tools.map((entry) => entry.name).sort(), expectedTools)
  const capabilities = await tool(client, 'zorya_capabilities', {})
  assert.ok(capabilities.limits)

  const classification = await tool(client, 'zorya_classify', {
    text: `${label} offline class fixture`,
    classes: [
      { id: 'first', description: 'First fixture class' },
      { id: 'second', description: 'Second fixture class' },
    ],
  })
  assert.equal(classification.state, 'queued')
  const completedClassification = await waitForJob(client, classification.jobId, 'succeeded')
  assert.equal(completedClassification.result.result.choice, 'first')

  const png = await fixturePng()
  const image = { kind: 'inlineBase64', data: png.toString('base64'), mediaType: 'image/png' }
  const localization = await tool(client, 'zorya_locate', { image, target: 'fixture object' })
  const completedLocalization = await waitForJob(client, localization.jobId, 'succeeded')
  assert.equal(completedLocalization.operation, 'locate')

  const extraction = await tool(client, 'zorya_extract', { image, target: 'fixture object' })
  const completedExtraction = await waitForJob(client, extraction.jobId, 'succeeded')
  assert.equal(completedExtraction.operation, 'extract')
  const extracted = completedExtraction.result.result
  assert.equal(extracted.status, 'extracted')
  assert.deepEqual(extracted.region, { left: 2, top: 2, width: 5, height: 5 })
  assert.deepEqual(extracted.offset, { x: 2, y: 2 })
  const maskArtifact = completedExtraction.artifacts.find((artifact) => artifact.role === 'mask')
  const cutoutArtifact = completedExtraction.artifacts.find(
    (artifact) => artifact.role === 'cutout',
  )
  assert.ok(maskArtifact && cutoutArtifact)
  assert.deepEqual(
    { width: maskArtifact.width, height: maskArtifact.height, encoding: maskArtifact.encoding },
    { width: 5, height: 5, encoding: 'binary-lsb0' },
  )
  assert.deepEqual(
    {
      width: cutoutArtifact.width,
      height: cutoutArtifact.height,
      mediaType: cutoutArtifact.mediaType,
    },
    { width: 5, height: 5, mediaType: 'image/png' },
  )
  const packedMaskResource = await client.readResource({
    uri: `zorya://artifacts/${maskArtifact.id}`,
  })
  const packedMaskBlob = packedMaskResource.contents[0]?.blob
  assert.equal(typeof packedMaskBlob, 'string')
  assert.deepEqual([...Buffer.from(packedMaskBlob, 'base64')], [63, 132, 16, 0])
  const cutoutResource = await client.readResource({
    uri: `zorya://artifacts/${cutoutArtifact.id}`,
  })
  const cutoutBlob = cutoutResource.contents[0]?.blob
  assert.equal(typeof cutoutBlob, 'string')
  const sharpEntry = await packageExport(consumerRoot, 'sharp')
  const { default: sharp } = await import(pathToFileURL(sharpEntry).href)
  const cutoutPixels = await sharp(Buffer.from(cutoutBlob, 'base64'))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  assert.deepEqual(
    { width: cutoutPixels.info.width, height: cutoutPixels.info.height },
    { width: 5, height: 5 },
  )
  assert.deepEqual([...cutoutPixels.data.subarray(0, 4)], [6, 10, 4, 255])
  assert.equal(cutoutPixels.data[(2 * 5 + 2) * 4 + 3], 0)

  const readBack = await tool(client, 'zorya_get_job', { jobId: classification.jobId })
  assert.equal(readBack.id, classification.jobId)
  assert.equal(readBack.state, 'succeeded')
  const cancelTerminal = await tool(client, 'zorya_cancel_job', { jobId: classification.jobId })
  assert.equal(cancelTerminal.id, classification.jobId)
  return { classification, extraction: completedExtraction }
}

async function exercisePhysicalCancellation(client, runtime) {
  const gate = runtime?.arm()
  const active = await tool(client, 'zorya_classify', {
    text:
      runtime === undefined
        ? 'consumer-hold one physical operation for cancellation semantics'
        : 'hold one physical operation for cancellation semantics',
    classes: [
      { id: 'first', description: 'First' },
      { id: 'second', description: 'Second' },
    ],
  })
  if (gate !== undefined) await withTimeout(gate.entered, 10_000)
  else await new Promise((resolveDelay) => setTimeout(resolveDelay, 40))
  const cancellation = await tool(client, 'zorya_cancel_job', { jobId: active.jobId })
  assert.equal(cancellation.state, 'cancelling')
  const queued = await tool(client, 'zorya_classify', {
    text: 'queued until physical work settles',
    classes: [
      { id: 'first', description: 'First' },
      { id: 'second', description: 'Second' },
    ],
  })
  assert.equal(queued.state, 'queued')
  gate?.release()
  await waitForJob(client, active.jobId, 'cancelled')
  await waitForJob(client, queued.jobId, 'succeeded')
}

async function tool(client, name, args) {
  const response = await client.callTool({ name, arguments: args })
  assert.notEqual(response.isError, true, `${name} returned an MCP tool error.`)
  assert.ok(response.structuredContent, `${name} did not return structured content.`)
  return response.structuredContent
}

async function waitForJob(client, jobId, expectedState) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const job = await tool(client, 'zorya_get_job', { jobId })
    if (job.state === expectedState) return job
    if (['failed', 'cancelled', 'succeeded'].includes(job.state) && job.state !== expectedState) {
      throw new Error(`Job reached unexpected terminal state: ${job.state}.`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Job did not reach its expected terminal state.')
}

async function connectHttpClient(baseUrl, bearer, protocol) {
  const legacy = protocol !== 'http-modern' && protocol !== 'modern'
  const client = new Client(
    { name: `mcp-http-${protocol}-consumer-smoke`, version: '0.1.0' },
    {
      versionNegotiation: { mode: legacy ? 'legacy' : { pin: '2026-07-28' } },
    },
  )
  const isSse = protocol === 'http-sse-legacy'
  const endpoint = isSse ? new URL('/sse', baseUrl) : new URL('/mcp', baseUrl)
  const options = { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }
  const transport = isSse
    ? new SSEClientTransport(endpoint, options)
    : new StreamableHTTPClientTransport(endpoint, options)
  await client.connect(transport)
  return { client, transport }
}

function principal(ownerId, subject) {
  return {
    ownerId,
    transport: 'http',
    identity: { issuer: 'https://issuer.example.test', subject, scopes: ['mcp:invoke'] },
    authInfo: {
      token: `controlled-token-${ownerId}`,
      clientId: 'offline-sdk-client',
      scopes: ['mcp:invoke'],
      resource: new URL('https://mcp.example.test/mcp'),
      resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    },
  }
}

async function fixturePng() {
  const sharpEntry = await packageExport(consumerRoot, 'sharp')
  const { default: sharp } = await import(pathToFileURL(sharpEntry).href)
  const width = 32
  const height = 32
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      pixels[index] = x * 3
      pixels[index + 1] = y * 5
      pixels[index + 2] = x + y
      pixels[index + 3] = 255
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
}

async function packageExport(root, name) {
  const packageDirectory = resolve(root, 'node_modules', name)
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
  const target = manifest.exports?.['.']?.import ?? manifest.module ?? manifest.main
  assert.equal(typeof target, 'string', `${name} does not expose an import entry.`)
  const entry = resolve(packageDirectory, target)
  const suffix = relative(packageDirectory, entry)
  assert.ok(
    suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix),
    `${name} entry escapes its installed package.`,
  )
  return entry
}

async function withTimeout(promise, ms) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for controlled physical work.')),
          ms,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
