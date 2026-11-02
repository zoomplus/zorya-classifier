import assert from 'node:assert/strict'
import test from 'node:test'

import { mcpConfigSchema, parseMcpConfig } from '../../src/config.js'

function baseConfig(overrides: Record<string, unknown> = {}): unknown {
  return {
    profiles: {
      vision: {
        id: 'vision',
        adapter: 'openrouter-vision',
        model: 'caller-selected-model',
        provider: 'caller-selected-provider',
        credentialMode: 'service',
        apiKeyEnv: 'MODEL_API_KEY',
      },
    },
    defaultProfileId: 'vision',
    ...overrides,
  }
}

test('configuration requires a matching explicitly selected profile', () => {
  assert.throws(() => parseMcpConfig({ profiles: { vision: { id: 'vision' } } }))
  assert.throws(() => parseMcpConfig(baseConfig({ defaultProfileId: 'missing' })))
  assert.equal(
    mcpConfigSchema.safeParse({ profiles: {}, defaultProfileId: 'toString' }).success,
    false,
  )
  assert.equal(parseMcpConfig(baseConfig()).defaultProfileId, 'vision')
})

test('programmatic DecisionPort profiles need no fabricated model or credential', () => {
  const injected = parseMcpConfig({
    profiles: {
      localDecision: {
        id: 'localDecision',
        adapter: 'injected-decision',
        credentialMode: 'none',
      },
    },
    defaultProfileId: 'localDecision',
  })
  const keylessGeneric = parseMcpConfig({
    profiles: {
      localServer: {
        id: 'localServer',
        adapter: 'openai-compatible-vision',
        model: 'local-model',
        endpoint: 'http://127.0.0.1:8000/v1',
        credentialMode: 'none',
      },
    },
    defaultProfileId: 'localServer',
  })

  assert.equal(injected.profiles['localDecision']?.adapter, 'injected-decision')
  assert.equal(keylessGeneric.profiles['localServer']?.credentialMode, 'none')
  assert.equal(
    mcpConfigSchema.safeParse({
      profiles: {
        remote: {
          id: 'remote',
          adapter: 'openrouter-vision',
          model: 'model-id',
          provider: 'provider-id',
          credentialMode: 'none',
        },
      },
      defaultProfileId: 'remote',
    }).success,
    false,
  )
})

test('OpenRouter profiles require an explicit provider and reject custom endpoints', () => {
  const noProvider = baseConfig({
    profiles: {
      vision: {
        id: 'vision',
        adapter: 'openrouter-vision',
        model: 'caller-selected-model',
        credentialMode: 'service',
        apiKeyEnv: 'MODEL_API_KEY',
      },
    },
  })
  assert.equal(mcpConfigSchema.safeParse(noProvider).success, false)

  const customEndpoint = baseConfig({
    profiles: {
      vision: {
        id: 'vision',
        adapter: 'openrouter-vision',
        model: 'caller-selected-model',
        provider: 'caller-selected-provider',
        endpoint: 'https://model.example/v1',
        credentialMode: 'service',
        apiKeyEnv: 'MODEL_API_KEY',
      },
    },
  })
  assert.equal(mcpConfigSchema.safeParse(customEndpoint).success, false)
})

test('generic adapters require an explicit credential-free HTTPS endpoint or loopback HTTP', () => {
  const generic = (endpoint?: string): unknown =>
    baseConfig({
      profiles: {
        vision: {
          id: 'vision',
          adapter: 'openai-compatible-vision',
          model: 'caller-selected-model',
          ...(endpoint === undefined ? {} : { endpoint }),
          credentialMode: 'byok',
        },
      },
    })

  assert.equal(mcpConfigSchema.safeParse(generic()).success, false)
  assert.equal(
    mcpConfigSchema.safeParse(generic('https://user:pass@model.example/v1')).success,
    false,
  )
  assert.equal(mcpConfigSchema.safeParse(generic('http://model.example/v1')).success, false)
  assert.equal(mcpConfigSchema.safeParse(generic('https://model.example/v1')).success, true)
  assert.equal(mcpConfigSchema.safeParse(generic('http://127.0.0.1:8000/v1')).success, true)
  assert.equal(mcpConfigSchema.safeParse(generic('http://[::1]:8000/v1')).success, true)
  assert.equal(mcpConfigSchema.safeParse(generic('not a url')).success, false)
})

test('profile identifiers stay machine-safe and display metadata preserves aliases', () => {
  const spacedIdentifier = baseConfig({
    profiles: {
      vision: {
        id: 'vision',
        adapter: 'openrouter-vision',
        model: 'model with spaces',
        provider: 'provider-id',
        credentialMode: 'service',
        apiKeyEnv: 'MODEL_API_KEY',
      },
    },
  })
  assert.equal(mcpConfigSchema.safeParse(spacedIdentifier).success, false)

  const config = parseMcpConfig({
    profiles: {
      vision: {
        id: 'vision',
        adapter: 'openrouter-vision',
        model: 'provider/model-id',
        provider: 'provider-id',
        providerName: 'Provider Display Name',
        responseModelIds: ['provider/model-id:free'],
        credentialMode: 'service',
        apiKeyEnv: 'MODEL_API_KEY',
      },
    },
    defaultProfileId: 'vision',
  })
  const profile = config.profiles['vision']
  assert.equal(profile?.adapter, 'openrouter-vision')
  if (profile?.adapter === 'openrouter-vision') {
    assert.equal(profile.providerName, 'Provider Display Name')
    assert.deepEqual(profile.responseModelIds, ['provider/model-id:free'])
  }
})

test('image caps cannot exceed the published classifier byte and pixel bounds', () => {
  const maxBytes = mcpConfigSchema.safeParse(baseConfig({ limits: { maxImageBytes: 16_777_217 } }))
  const maxPixels = mcpConfigSchema.safeParse(
    baseConfig({ limits: { maxImagePixels: 16_777_217 } }),
  )
  assert.equal(maxBytes.success, false)
  assert.equal(maxPixels.success, false)

  const parsed = parseMcpConfig(baseConfig())
  assert.equal(parsed.limits.maxImageBytes, 16_777_216)
  assert.equal(parsed.limits.maxImagePixels, 16_777_216)
  assert.equal(parsed.limits.maxActiveJobs, 1)
  assert.equal(parsed.limits.maxActiveJobsPerOwner, 1)
})

test('native segmentation requires explicit caller-owned asset paths and bounded threads', () => {
  const missingAssets = mcpConfigSchema.safeParse(
    baseConfig({ segmentation: { kind: 'mobile-sam' } }),
  )
  const invalidThreads = mcpConfigSchema.safeParse(
    baseConfig({
      segmentation: {
        kind: 'mobile-sam',
        encoderPath: '/models/encoder.onnx',
        decoderPath: '/models/decoder.onnx',
        threads: 65,
      },
    }),
  )
  const validNative = mcpConfigSchema.safeParse(
    baseConfig({
      segmentation: {
        kind: 'mobile-sam',
        encoderPath: '/models/encoder.onnx',
        decoderPath: '/models/decoder.onnx',
        executionProvider: 'cpu',
        threads: 2,
      },
    }),
  )

  assert.equal(missingAssets.success, false)
  assert.equal(invalidThreads.success, false)
  assert.equal(validNative.success, true)
})
