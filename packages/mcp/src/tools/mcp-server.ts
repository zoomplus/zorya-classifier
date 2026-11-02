import {
  McpServer,
  ResourceTemplate,
  type CallToolResult,
  type ReadResourceResult,
} from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { CoreApplication, JsonObject, Principal, ResourcePayload } from '../contracts.js'
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
  const server = new McpServer({ name: 'zorya-classifier-mcp', version: '0.1.0' })
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
