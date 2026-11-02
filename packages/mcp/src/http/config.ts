import { z } from 'zod'

function parseEndpoint(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

const endpointSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = parseEndpoint(value)
    return (
      url !== undefined &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
  }, 'Endpoint must use HTTPS except for explicit loopback development endpoints.')

const originSchema = endpointSchema.refine((value) => {
  const url = parseEndpoint(value)
  return url !== undefined && url.pathname === '/' && !url.search && !url.hash
}, 'Allowed origins must contain only an origin.')

const routePathSchema = z
  .string()
  .regex(/^\/[a-zA-Z0-9/_-]*$/u)
  .max(128)
  .refine((value) => !value.includes('//') && value !== '/', 'HTTP route path is invalid.')

const hostNameSchema = z
  .string()
  .min(1)
  .max(253)
  .refine((value) => {
    const wildcard = value.startsWith('*.')
    const host = wildcard ? value.slice(2) : value
    try {
      const parsed = new URL(`http://${host}`)
      return (
        !parsed.username &&
        !parsed.password &&
        !parsed.port &&
        parsed.pathname === '/' &&
        !parsed.search &&
        !parsed.hash &&
        parsed.host.toLowerCase() === host.toLowerCase()
      )
    } catch {
      return false
    }
  }, 'Allowed hosts must be hostnames or bracketed IP addresses without ports or paths.')

export const httpConfigSchema = z
  .strictObject({
    bindHost: z.string().min(1).max(253),
    port: z.number().int().min(0).max(65_535),
    publicOrigin: originSchema,
    resourceUrl: endpointSchema.refine(
      (value) => !parseEndpoint(value)?.search,
      'Resource URL cannot contain a query string.',
    ),
    resourceMetadataUrl: endpointSchema.refine(
      (value) => !parseEndpoint(value)?.search,
      'Resource metadata URL cannot contain a query string.',
    ),
    issuer: endpointSchema.refine(
      (value) => !parseEndpoint(value)?.search,
      'OIDC issuer cannot contain a query string.',
    ),
    audience: z.string().min(1).max(512),
    requiredScopes: z.array(z.string().min(1).max(128)).max(32),
    allowedHosts: z.array(hostNameSchema).min(1).max(128),
    allowedOrigins: z.array(originSchema).max(128),
    mcpPath: routePathSchema.default('/mcp'),
    legacySsePath: routePathSchema.default('/sse'),
    legacyMessagesPath: routePathSchema.default('/messages'),
    loginPath: routePathSchema.default('/login'),
    loginCallbackPath: routePathSchema.default('/login/callback'),
    logoutPath: routePathSchema.default('/logout'),
    credentialPath: routePathSchema.default('/settings/provider-key'),
    settingsPath: routePathSchema.default('/settings'),
    credentialProfileIds: z.array(z.string().min(1).max(64)).max(128).default([]),
    openRouterConnectPath: routePathSchema.default('/settings/openrouter/connect'),
    openRouterCallbackPath: routePathSchema.default('/settings/openrouter/callback'),
    viewerPath: routePathSchema.default('/viewer/jobs'),
    artifactPath: routePathSchema.default('/artifacts'),
    uploadPath: routePathSchema.default('/uploads'),
    maxRequestBodyBytes: z.number().int().min(1_024).max(32_000_000).default(32_000_000),
    maxUploadBytes: z.number().int().min(1_024).max(16_777_216).default(16_777_216),
    maxConcurrentUploads: z.number().int().min(1).max(256).default(8),
    maxConcurrentBodyReads: z.number().int().min(1).max(256).default(8),
    requestTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
    headersTimeoutMs: z.number().int().min(1_000).max(60_000).default(10_000),
    maxViewerArtifactBytes: z.number().int().min(1_024).max(16_777_216).default(16_777_216),
    maxLegacySessions: z.number().int().min(1).max(10_000).default(256),
    legacySessionTtlMs: z.number().int().min(1_000).max(86_400_000).default(3_600_000),
  })
  .superRefine((config, context) => {
    const routes = [
      config.mcpPath,
      config.legacySsePath,
      config.legacyMessagesPath,
      config.loginPath,
      config.loginCallbackPath,
      config.logoutPath,
      config.credentialPath,
      config.settingsPath,
      config.openRouterConnectPath,
      config.openRouterCallbackPath,
      config.uploadPath,
      config.viewerPath,
      config.artifactPath,
    ]
    if (new Set(routes).size !== routes.length)
      context.addIssue({ code: 'custom', path: [], message: 'HTTP route paths must be unique.' })
    if (
      routes.some(
        (path) =>
          path.startsWith(`${config.viewerPath}/`) || path.startsWith(`${config.artifactPath}/`),
      )
    )
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'HTTP resource paths cannot shadow configured routes.',
      })
    if (config.headersTimeoutMs > config.requestTimeoutMs)
      context.addIssue({
        code: 'custom',
        path: ['headersTimeoutMs'],
        message: 'Header timeout cannot exceed the request timeout.',
      })
  })

export type HttpConfigInput = z.input<typeof httpConfigSchema>
export type HttpConfig = Readonly<z.output<typeof httpConfigSchema>>

export function parseHttpConfig(input: unknown): HttpConfig {
  return httpConfigSchema.parse(input)
}
