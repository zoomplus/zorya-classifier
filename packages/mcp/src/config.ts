import ipaddr from 'ipaddr.js'
import { z } from 'zod'

const adapterSchema = z.enum([
  'openrouter-vision',
  'openrouter-native',
  'openai-compatible-vision',
  'openai-compatible-text',
])

const profileBase = {
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  model: z.string().min(1).max(200).regex(/^\S+$/),
  provider: z.string().min(1).max(100).regex(/^\S+$/).optional(),
  providerName: z.string().min(1).max(100).optional(),
  responseModelIds: z.array(z.string().min(1).max(200)).max(32).optional(),
  endpoint: z.string().url().max(2048).optional(),
} as const

const serviceProfileSchema = z.strictObject({
  ...profileBase,
  adapter: adapterSchema,
  credentialMode: z.literal('service'),
  apiKeyEnv: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Z][A-Z0-9_]*$/),
})

const byokProfileSchema = z.strictObject({
  ...profileBase,
  adapter: adapterSchema,
  credentialMode: z.literal('byok'),
})

const keylessOpenAIProfileSchema = z.strictObject({
  ...profileBase,
  adapter: z.enum(['openai-compatible-vision', 'openai-compatible-text']),
  credentialMode: z.literal('none'),
})

const injectedDecisionProfileSchema = z.strictObject({
  id: profileBase.id,
  adapter: z.literal('injected-decision'),
  credentialMode: z.literal('none'),
})

const modelProfileSchema = z.union([
  serviceProfileSchema,
  byokProfileSchema,
  keylessOpenAIProfileSchema,
  injectedDecisionProfileSchema,
])

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost') return true
  try {
    const address = ipaddr.parse(normalized)
    if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) {
      return address.toIPv4Address().range() === 'loopback'
    }
    return address.range() === 'loopback'
  } catch {
    return false
  }
}

function validateProfileTransport(
  profile: z.output<typeof modelProfileSchema>,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (profile.adapter === 'injected-decision') return

  if (profile.adapter.startsWith('openrouter-') && profile.provider === undefined) {
    context.addIssue({
      code: 'custom',
      path: [...path, 'provider'],
      message: 'OpenRouter profiles require an explicit provider.',
    })
  }

  if (
    profile.adapter.startsWith('openai-compatible-') &&
    (profile.provider !== undefined || profile.providerName !== undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: [...path, profile.provider === undefined ? 'providerName' : 'provider'],
      message: 'The selected OpenAI-compatible adapter does not accept provider metadata.',
    })
  }

  if (!profile.adapter.startsWith('openai-compatible-')) {
    if (profile.endpoint !== undefined) {
      context.addIssue({
        code: 'custom',
        path: [...path, 'endpoint'],
        message: 'The selected adapter does not accept a custom endpoint.',
      })
    }
    return
  }

  if (profile.endpoint === undefined) {
    context.addIssue({
      code: 'custom',
      path: [...path, 'endpoint'],
      message: 'OpenAI-compatible profiles require an explicit endpoint.',
    })
    return
  }

  let endpoint: URL
  try {
    endpoint = new URL(profile.endpoint)
  } catch {
    context.addIssue({
      code: 'custom',
      path: [...path, 'endpoint'],
      message: 'Endpoint must be a valid URL.',
    })
    return
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    context.addIssue({
      code: 'custom',
      path: [...path, 'endpoint'],
      message: 'Endpoint URLs must not contain embedded credentials.',
    })
  }
  if (
    endpoint.protocol !== 'https:' &&
    !(endpoint.protocol === 'http:' && isLoopback(endpoint.hostname))
  ) {
    context.addIssue({
      code: 'custom',
      path: [...path, 'endpoint'],
      message: 'Generic endpoints must use HTTPS, except for explicit loopback HTTP endpoints.',
    })
  }
}

const profilesSchema = z.record(z.string(), modelProfileSchema).superRefine((profiles, context) => {
  for (const [key, profile] of Object.entries(profiles)) {
    if (profile.id !== key) {
      context.addIssue({
        code: 'custom',
        path: [key, 'id'],
        message: 'Profile id must match its map key.',
      })
    }
    validateProfileTransport(profile, context, [key])
  }
})

const limitsSchema = z.strictObject({
  maxImageBytes: z.number().int().min(1_024).max(16_777_216).default(16_777_216),
  maxImagePixels: z.number().int().min(1).max(16_777_216).default(16_777_216),
  maxQueuedJobs: z.number().int().min(1).max(10_000).default(16),
  maxQueuedJobsPerOwner: z.number().int().min(1).max(1_000).default(2),
  maxStoredJobs: z.number().int().min(1).max(100_000).default(256),
  maxStoredJobsPerOwner: z.number().int().min(1).max(10_000).default(32),
  maxQueuedInputBytes: z.number().int().min(1_024).max(1_073_741_824).default(67_108_864),
  maxQueuedInputBytesPerOwner: z.number().int().min(1_024).max(268_435_456).default(33_554_432),
  maxActiveJobs: z.number().int().min(1).max(1_000).default(1),
  maxActiveJobsPerOwner: z.number().int().min(1).max(100).default(1),
  jobTimeoutMs: z.number().int().min(100).max(120_000).default(120_000),
  jobTtlMs: z.number().int().min(1_000).max(86_400_000).default(3_600_000),
  artifactTtlMs: z.number().int().min(1_000).max(86_400_000).default(3_600_000),
  maxArtifactBytes: z.number().int().min(1_024).max(16_777_216).default(16_777_216),
  maxArtifactTotalBytes: z.number().int().min(1_024).max(4_294_967_296).default(268_435_456),
  maxArtifactTotalBytesPerOwner: z.number().int().min(1_024).max(1_073_741_824).default(33_554_432),
  maxResultJsonBytes: z.number().int().min(1_024).max(16_777_216).default(1_048_576),
})

const segmentationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('mobile-sam'),
    encoderPath: z.string().min(1).max(4_096),
    decoderPath: z.string().min(1).max(4_096),
    executionProvider: z.enum(['cpu', 'dml']).default('cpu'),
    deviceId: z.number().int().min(0).max(32).optional(),
    threads: z.number().int().min(1).max(8).default(1),
  }),
  z.strictObject({
    kind: z.literal('grabcut'),
    assetPath: z.string().min(1).max(4_096),
  }),
])

export const mcpConfigSchema = z
  .strictObject({
    profiles: profilesSchema,
    /** Required explicitly; profile order never selects a model. */
    defaultProfileId: z.string().min(1).max(64),
    limits: limitsSchema.default({
      maxImageBytes: 16_777_216,
      maxImagePixels: 16_777_216,
      maxQueuedJobs: 16,
      maxQueuedJobsPerOwner: 2,
      maxStoredJobs: 256,
      maxStoredJobsPerOwner: 32,
      maxQueuedInputBytes: 67_108_864,
      maxQueuedInputBytesPerOwner: 33_554_432,
      maxActiveJobs: 1,
      maxActiveJobsPerOwner: 1,
      jobTimeoutMs: 120_000,
      jobTtlMs: 3_600_000,
      artifactTtlMs: 3_600_000,
      maxArtifactBytes: 16_777_216,
      maxArtifactTotalBytes: 268_435_456,
      maxArtifactTotalBytesPerOwner: 33_554_432,
      maxResultJsonBytes: 1_048_576,
    }),
    stdio: z
      .strictObject({
        inputRoot: z.string().min(1).max(4_096).optional(),
      })
      .default({}),
    segmentation: segmentationSchema.optional(),
  })
  .superRefine((config, context) => {
    if (!Object.hasOwn(config.profiles, config.defaultProfileId)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultProfileId'],
        message: 'defaultProfileId must name an explicitly configured profile.',
      })
    }
    if (config.limits.maxActiveJobsPerOwner > config.limits.maxActiveJobs) {
      context.addIssue({
        code: 'custom',
        path: ['limits', 'maxActiveJobsPerOwner'],
        message: 'Per-owner active-job limit cannot exceed the global active-job limit.',
      })
    }
    if (config.limits.maxQueuedJobsPerOwner > config.limits.maxQueuedJobs) {
      context.addIssue({
        code: 'custom',
        path: ['limits', 'maxQueuedJobsPerOwner'],
        message: 'Per-owner queued-job limit cannot exceed the global queued-job limit.',
      })
    }
    if (config.limits.maxStoredJobsPerOwner > config.limits.maxStoredJobs) {
      context.addIssue({
        code: 'custom',
        path: ['limits', 'maxStoredJobsPerOwner'],
        message: 'Per-owner stored-job limit cannot exceed the global stored-job limit.',
      })
    }
    if (config.limits.maxQueuedInputBytesPerOwner > config.limits.maxQueuedInputBytes) {
      context.addIssue({
        code: 'custom',
        path: ['limits', 'maxQueuedInputBytesPerOwner'],
        message: 'Per-owner queued-byte limit cannot exceed the global queued-byte limit.',
      })
    }
    if (config.limits.maxArtifactTotalBytesPerOwner > config.limits.maxArtifactTotalBytes) {
      context.addIssue({
        code: 'custom',
        path: ['limits', 'maxArtifactTotalBytesPerOwner'],
        message: 'Per-owner artifact-byte limit cannot exceed the global artifact-byte limit.',
      })
    }
  })

export type McpConfigInput = z.input<typeof mcpConfigSchema>
export type McpConfig = Readonly<z.output<typeof mcpConfigSchema>>

export function parseMcpConfig(input: unknown): McpConfig {
  return mcpConfigSchema.parse(input)
}
