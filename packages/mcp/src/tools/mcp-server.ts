import {
  McpServer,
  ResourceTemplate,
  type CallToolResult,
  type ReadResourceResult,
} from '@modelcontextprotocol/server'
import { z } from 'zod'

import type {
  AnonymousSessionPort,
  CoreApplication,
  JsonObject,
  JsonValue,
  Principal,
  ResourcePayload,
} from '../contracts.js'
import { publicError, safeError } from '../errors.js'
import {
  cancelJobToolInputSchema,
  capabilitiesToolInputSchema,
  classifyToolInputSchema,
  extractToolInputSchema,
  getJobToolInputSchema,
  locateToolInputSchema,
} from './schemas.js'

const defaultResourceTimeoutMs = 30_000
const safeErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
})
const errorOutputSchema = z.strictObject({ error: safeErrorSchema })
const artifactDescriptorSchema = z.strictObject({
  id: z.string(),
  role: z.enum(['source', 'cutout', 'mask']),
  mediaType: z.string(),
  byteLength: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  encoding: z.string().optional(),
})
const jobSnapshotSchema = z.strictObject({
  id: z.string().uuid(),
  state: z.enum(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled']),
  operation: z.enum(['classify', 'locate', 'extract']),
  createdAt: z.number().int().positive(),
  deadlineAt: z.number().int().positive(),
  artifacts: z.array(artifactDescriptorSchema),
  result: z.json().optional(),
  error: safeErrorSchema.optional(),
})
const submissionSchema = z.strictObject({
  jobId: z.string().uuid(),
  state: z.literal('queued'),
  operation: z.enum(['classify', 'locate', 'extract']),
  createdAt: z.number().int().positive(),
  deadlineAt: z.number().int().positive(),
})
const profileCapabilitySchema = z.strictObject({
  id: z.string(),
  adapter: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
  providerName: z.string().optional(),
  responseModelIds: z.array(z.string()).optional(),
})
const capabilitiesSchema = z.strictObject({
  transport: z.strictObject({
    active: z.enum(['stdio', 'http']),
    supportedProtocols: z.array(
      z.enum([
        'stdio:2026-07-28',
        'stdio:2025-11-25',
        'streamable-http:2026-07-28',
        'streamable-http:2025-11-25',
        'legacy-sse:2025-11-25',
      ]),
    ),
  }),
  inputs: z.strictObject({
    inlineBase64: z.boolean(),
    localPath: z.boolean(),
    url: z.boolean(),
    chatgptFile: z.boolean(),
    uploadedId: z.boolean(),
  }),
  profiles: z.array(profileCapabilitySchema),
  operations: z.strictObject({
    classify: z.boolean(),
    locateRegion: z.boolean(),
    locateWholeObject: z.boolean(),
    extract: z.boolean(),
  }),
  limits: z.strictObject({
    maxImageBytes: z.number().int().positive(),
    maxImagePixels: z.number().int().positive(),
    maxQueuedJobs: z.number().int().positive(),
    maxQueuedJobsPerOwner: z.number().int().positive(),
    maxStoredJobs: z.number().int().positive(),
    maxStoredJobsPerOwner: z.number().int().positive(),
    maxQueuedInputBytes: z.number().int().positive(),
    maxQueuedInputBytesPerOwner: z.number().int().positive(),
    maxActiveJobs: z.number().int().positive(),
    maxActiveJobsPerOwner: z.number().int().positive(),
    jobTimeoutMs: z.number().int().positive(),
    jobTtlMs: z.number().int().positive(),
    artifactTtlMs: z.number().int().positive(),
    maxArtifactBytes: z.number().int().positive(),
    maxArtifactTotalBytes: z.number().int().positive(),
    maxArtifactTotalBytesPerOwner: z.number().int().positive(),
    maxResultJsonBytes: z.number().int().positive(),
  }),
})
const classifyOutputSchema = z.union([submissionSchema, errorOutputSchema])
const spatialOutputSchema = z.union([submissionSchema, errorOutputSchema])
const jobOutputSchema = z.union([jobSnapshotSchema, errorOutputSchema])
const capabilitiesOutputSchema = z.union([capabilitiesSchema, errorOutputSchema])
const anonymousSessionOutputSchema = z.strictObject({
  sessionToken: z.string().length(43),
  expiresAt: z.number().int().positive(),
})
const readArtifactOutputSchema = z.strictObject({
  artifactId: z.string().min(1).max(128),
  mediaType: z.string().min(1).max(128),
  byteLength: z.number().int().nonnegative(),
})
const principalScopedServerOptionsSchema = z.strictObject({
  resourceTimeoutMs: z.number().int().min(100).max(120_000).optional(),
})

export interface PrincipalScopedMcpServerOptions {
  readonly resourceTimeoutMs?: number
}

/** Build one request/session server around a caller-derived principal and shared application. */
export function createPrincipalScopedMcpServer(
  application: CoreApplication,
  principal: Principal,
  options: PrincipalScopedMcpServerOptions = {},
): McpServer {
  const parsedOptions = principalScopedServerOptionsSchema.parse(options)
  const server = new McpServer({ name: 'zorya-classifier-mcp', version: '0.2.0' })
  const resourceTimeoutMs = parsedOptions.resourceTimeoutMs ?? defaultResourceTimeoutMs

  server.registerTool(
    'zorya_classify',
    {
      title: 'Classify an input',
      description:
        'Classify supplied text, an image, or both using the explicitly selected profile.',
      inputSchema: classifyToolInputSchema,
      outputSchema: classifyOutputSchema,
      _meta: { 'openai/fileParams': ['image_file'] },
    },
    async (args, context) =>
      invokeTool(application, principal, 'zorya_classify', args, context.mcpReq.signal),
  )

  server.registerTool(
    'zorya_locate',
    {
      title: 'Locate a visible target',
      description:
        'Locate a target in an image. Region mode reports a coarse region; whole-object mode requires a configured caller-owned segmenter.',
      inputSchema: locateToolInputSchema,
      outputSchema: spatialOutputSchema,
      _meta: { 'openai/fileParams': ['image_file'] },
    },
    async (args, context) =>
      invokeTool(application, principal, 'zorya_locate', args, context.mcpReq.signal),
  )

  server.registerTool(
    'zorya_extract',
    {
      title: 'Extract a visible instance',
      description:
        'Extract a visible instance with the explicitly configured caller-owned segmenter and return private artifact references.',
      inputSchema: extractToolInputSchema,
      outputSchema: spatialOutputSchema,
      _meta: { 'openai/fileParams': ['image_file'] },
    },
    async (args, context) =>
      invokeTool(application, principal, 'zorya_extract', args, context.mcpReq.signal),
  )

  server.registerTool(
    'zorya_get_job',
    {
      title: 'Get a job',
      description: 'Read the current state and result of one of your jobs.',
      inputSchema: getJobToolInputSchema,
      outputSchema: jobOutputSchema,
    },
    async (args, context) =>
      invokeTool(application, principal, 'zorya_get_job', args, context.mcpReq.signal),
  )

  server.registerTool(
    'zorya_cancel_job',
    {
      title: 'Cancel a job',
      description:
        'Request cancellation of one of your jobs. Running work can remain cancelling until physical work settles; poll with zorya_get_job.',
      inputSchema: cancelJobToolInputSchema,
      outputSchema: jobOutputSchema,
    },
    async (args, context) =>
      invokeTool(application, principal, 'zorya_cancel_job', args, context.mcpReq.signal),
  )

  server.registerTool(
    'zorya_capabilities',
    {
      title: 'List capabilities',
      description:
        'Report the active transport, supported protocol revisions, accepted image sources, configured operations, profiles, and resource limits.',
      inputSchema: capabilitiesToolInputSchema,
      outputSchema: capabilitiesOutputSchema,
    },
    async (args, context) =>
      invokeTool(application, principal, 'zorya_capabilities', args, context.mcpReq.signal),
  )

  server.registerResource(
    'zorya-job',
    new ResourceTemplate('zorya://jobs/{jobId}', { list: undefined }),
    {
      title: 'Private job result',
      description: 'Owner-scoped job state, result metadata, and private artifact descriptors.',
      mimeType: 'application/json',
    },
    async (uri, _variables, context) => {
      try {
        const payload = await application.readResource({
          uri: uri.href,
          principal,
          signal: context.mcpReq.signal,
          deadlineAt: Date.now() + resourceTimeoutMs,
        })
        return resourceContents(uri.href, payload)
      } catch (error) {
        throw publicError(error)
      }
    },
  )

  server.registerResource(
    'zorya-artifact',
    new ResourceTemplate('zorya://artifacts/{artifactId}', { list: undefined }),
    {
      title: 'Private job artifact',
      description: 'Owner-scoped image, cutout, or packed mask bytes.',
      mimeType: 'application/octet-stream',
    },
    async (uri, _variables, context) => {
      try {
        const payload = await application.readResource({
          uri: uri.href,
          principal,
          signal: context.mcpReq.signal,
          deadlineAt: Date.now() + resourceTimeoutMs,
        })
        return resourceContents(uri.href, payload)
      } catch (error) {
        throw publicError(error)
      }
    },
  )

  return server
}

/** MCP-поверхность IP-режима: allowlist допускает сеть, а операции требуют capability-сессию. */
export function createAnonymousMcpServer(
  application: CoreApplication,
  sessions: AnonymousSessionPort,
  options: { readonly maxArtifactBytes: number },
): McpServer {
  const server = new McpServer(
    { name: 'zorya-classifier-mcp', version: '0.2.0' },
    {
      instructions:
        'Open zorya_open_session once. Keep its sessionToken private and reuse it in all six zorya_* tools, zorya_read_artifact, and job polling. The IP allowlist admits a network, not an individual identity. Use only configured server profiles; no model is selected implicitly.',
    },
  )
  server.registerTool(
    'zorya_open_session',
    {
      title: 'Open an anonymous session',
      description:
        'Create one short-lived private session, then reuse its sessionToken for every classification, job, and artifact call. The IP allowlist does not identify individual users.',
      inputSchema: z.strictObject({}),
      outputSchema: anonymousSessionOutputSchema,
    },
    async () => {
      try {
        const opened = sessions.open()
        return jsonToolResult(
          anonymousSessionOutputSchema.parse({
            sessionToken: opened.token,
            expiresAt: opened.expiresAt,
          }),
        )
      } catch (error) {
        return jsonToolResult(errorOutputSchema.parse({ error: safeError(error) }), true)
      }
    },
  )

  registerAnonymousOperation(
    server,
    application,
    sessions,
    'zorya_classify',
    classifyToolInputSchema.safeExtend({ sessionToken: z.string().min(1).max(128) }),
    classifyOutputSchema,
    'Classify supplied text or an image using an explicitly configured server profile. Open a session once and reuse its sessionToken.',
    true,
    true,
  )
  registerAnonymousOperation(
    server,
    application,
    sessions,
    'zorya_locate',
    locateToolInputSchema.safeExtend({ sessionToken: z.string().min(1).max(128) }),
    spatialOutputSchema,
    'Locate a visible target using an explicitly configured server profile. Open a session once and reuse its sessionToken.',
    true,
    true,
  )
  registerAnonymousOperation(
    server,
    application,
    sessions,
    'zorya_extract',
    extractToolInputSchema.safeExtend({ sessionToken: z.string().min(1).max(128) }),
    spatialOutputSchema,
    'Extract a visible instance using an explicitly configured server profile and segmenter. Open a session once and reuse its sessionToken.',
    true,
    true,
  )
  registerAnonymousOperation(
    server,
    application,
    sessions,
    'zorya_get_job',
    getJobToolInputSchema.extend({ sessionToken: z.string().min(1).max(128) }),
    jobOutputSchema,
    'Read a job created in this anonymous session. Open a session once and reuse its sessionToken.',
    false,
  )
  registerAnonymousOperation(
    server,
    application,
    sessions,
    'zorya_cancel_job',
    cancelJobToolInputSchema.extend({ sessionToken: z.string().min(1).max(128) }),
    jobOutputSchema,
    'Cancel a job created in this anonymous session. Open a session once and reuse its sessionToken.',
    false,
  )
  registerAnonymousOperation(
    server,
    application,
    sessions,
    'zorya_capabilities',
    capabilitiesToolInputSchema.extend({ sessionToken: z.string().min(1).max(128) }),
    capabilitiesOutputSchema,
    'List configured server profiles, operations, and limits. No model is selected implicitly. Open a session once and reuse its sessionToken.',
    false,
  )

  server.registerTool(
    'zorya_read_artifact',
    {
      title: 'Read a session artifact',
      description:
        'Read bounded image or packed-mask bytes for an artifact created in this anonymous session. Open a session once and reuse its sessionToken.',
      inputSchema: z.strictObject({
        sessionToken: z.string().min(1).max(128),
        artifactId: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9_-]+$/u),
      }),
      outputSchema: readArtifactOutputSchema,
    },
    async (args, context) => {
      try {
        const principal = sessions.resolve(args.sessionToken)
        const payload = await application.readResource({
          uri: `zorya://artifacts/${encodeURIComponent(args.artifactId)}`,
          principal,
          signal: context.mcpReq.signal,
          deadlineAt: Date.now() + defaultResourceTimeoutMs,
        })
        if (payload.kind !== 'binary' || payload.bytes.byteLength > options.maxArtifactBytes)
          throw new Error('Artifact is unavailable or exceeds the configured read limit.')
        const ownedBytes = Buffer.from(payload.bytes)
        let encoded: string
        try {
          encoded = ownedBytes.toString('base64')
        } finally {
          ownedBytes.fill(0)
          payload.bytes.fill(0)
        }
        const content = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(
          payload.mediaType,
        )
          ? [{ type: 'image' as const, data: encoded, mimeType: payload.mediaType }]
          : [
              {
                type: 'resource' as const,
                resource: {
                  uri: `zorya://artifacts/${encodeURIComponent(args.artifactId)}`,
                  mimeType: payload.mediaType,
                  blob: encoded,
                },
              },
            ]
        return {
          content,
          structuredContent: readArtifactOutputSchema.parse({
            artifactId: args.artifactId,
            mediaType: payload.mediaType,
            byteLength: payload.bytes.byteLength,
          }),
        }
      } catch (error) {
        return jsonToolResult(errorOutputSchema.parse({ error: safeError(error) }), true)
      }
    },
  )
  return server
}

function registerAnonymousOperation(
  server: McpServer,
  application: CoreApplication,
  sessions: AnonymousSessionPort,
  toolName:
    | 'zorya_classify'
    | 'zorya_locate'
    | 'zorya_extract'
    | 'zorya_get_job'
    | 'zorya_cancel_job'
    | 'zorya_capabilities',
  inputSchema: z.ZodObject,
  outputSchema: z.ZodType,
  description: string,
  countsAsJob: boolean,
  acceptsChatgptFile = false,
): void {
  server.registerTool(
    toolName,
    {
      title: toolName.replaceAll('_', ' '),
      description,
      inputSchema,
      outputSchema,
      ...(acceptsChatgptFile ? { _meta: { 'openai/fileParams': ['image_file'] } } : {}),
    },
    async (args, context) => {
      try {
        const parsed = inputSchema.parse(args)
        const sessionToken = parsed['sessionToken']
        if (typeof sessionToken !== 'string') throw new Error('An anonymous session is required.')
        const principal = sessions.resolve(sessionToken)
        const { sessionToken: _sessionToken, ...operationArgs } = parsed
        if (containsLocalPath(operationArgs))
          throw new Error('Local filesystem inputs are unavailable over HTTP.')
        if (countsAsJob) sessions.recordSubmission(sessionToken)
        const output = await application.invoke({
          toolName,
          args: operationArgs,
          principal,
          signal: context.mcpReq.signal,
        })
        if (toolName === 'zorya_capabilities' && isJsonRecord(output['inputs'])) {
          const transport = output['transport']
          const transportRecord = isJsonRecord(transport) ? transport : {}
          const protocols = transportRecord['supportedProtocols']
          const safeOutput = {
            ...output,
            transport: {
              ...transportRecord,
              supportedProtocols: Array.isArray(protocols)
                ? protocols.filter(
                    (protocol) =>
                      typeof protocol === 'string' && protocol.startsWith('streamable-http:'),
                  )
                : [],
            },
            inputs: { ...output['inputs'], localPath: false, uploadedId: false },
          }
          const validated = outputSchema.parse(safeOutput)
          return jsonToolResult(z.record(z.string(), z.json()).parse(validated))
        }
        const validated = outputSchema.parse(output)
        return jsonToolResult(z.record(z.string(), z.json()).parse(validated))
      } catch (error) {
        return jsonToolResult(errorOutputSchema.parse({ error: safeError(error) }), true)
      }
    },
  )
}

function isJsonRecord(value: unknown): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function containsLocalPath(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsLocalPath)
  const entries = Object.entries(value)
  if (
    entries.some(([key, item]) => key === 'kind' && (item === 'localPath' || item === 'uploadedId'))
  )
    return true
  return entries.some(([, item]) => containsLocalPath(item))
}

async function invokeTool(
  application: CoreApplication,
  principal: Principal,
  toolName:
    | 'zorya_classify'
    | 'zorya_locate'
    | 'zorya_extract'
    | 'zorya_get_job'
    | 'zorya_cancel_job'
    | 'zorya_capabilities',
  args: unknown,
  signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    const output = await application.invoke({ toolName, args, principal, signal })
    const validated = outputSchemaFor(toolName).parse(output)
    return jsonToolResult(z.record(z.string(), z.json()).parse(validated))
  } catch (error) {
    const issue = safeError(error)
    const validated = errorOutputSchema.parse({
      error: { code: issue.code, message: issue.message, retryable: issue.retryable },
    })
    const output = z.record(z.string(), z.json()).parse(validated)
    return jsonToolResult(output, true)
  }
}

function outputSchemaFor(toolName: string) {
  switch (toolName) {
    case 'zorya_classify':
      return classifyOutputSchema
    case 'zorya_locate':
    case 'zorya_extract':
      return spatialOutputSchema
    case 'zorya_get_job':
    case 'zorya_cancel_job':
      return jobOutputSchema
    case 'zorya_capabilities':
      return capabilitiesOutputSchema
    default:
      throw new Error('Unknown MCP tool.')
  }
}

function jsonToolResult(output: JsonObject, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: stringifyJson(output) }],
    structuredContent: output,
    ...(isError ? { isError: true } : {}),
  }
}

function resourceContents(uri: string, payload: ResourcePayload): ReadResourceResult {
  switch (payload.kind) {
    case 'json':
      return {
        contents: [{ uri, mimeType: payload.mediaType, text: stringifyJson(payload.value) }],
      }
    case 'text':
      return { contents: [{ uri, mimeType: payload.mediaType, text: payload.text }] }
    case 'binary':
      return {
        contents: [
          { uri, mimeType: payload.mediaType, blob: Buffer.from(payload.bytes).toString('base64') },
        ],
      }
  }
}

function stringifyJson(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('JSON encoding failed.')
  return encoded
}
