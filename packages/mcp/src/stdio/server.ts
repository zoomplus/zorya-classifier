import { randomUUID } from 'node:crypto'

import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

import type { CoreApplication, Principal } from '../contracts.js'
import { createPrincipalScopedMcpServer } from '../tools/mcp-server.js'

export interface StdioServerOptions {
  readonly ownerId?: string
  readonly legacy?: 'serve' | 'reject'
  readonly maxBufferSize?: number
  readonly resourceTimeoutMs?: number
}

export interface ManagedStdioHandle {
  close(): Promise<void>
}

const stdioServerOptionsSchema = z.strictObject({
  ownerId: z.string().min(1).max(512).optional(),
  legacy: z.enum(['serve', 'reject']).optional(),
  maxBufferSize: z
    .number()
    .int()
    .min(1_024)
    .max(64 * 1024 * 1024)
    .optional(),
  resourceTimeoutMs: z.number().int().min(100).max(120_000).optional(),
})

/** Start the SDK-owned stdio connection for one server process and its owner scope. */
export function startStdioServer(
  application: CoreApplication,
  options: StdioServerOptions = {},
): ManagedStdioHandle {
  const parsedOptions = stdioServerOptionsSchema.parse(options)
  const principal: Principal = {
    ownerId: parsedOptions.ownerId ?? randomUUID(),
    transport: 'stdio',
  }
  const sdkOptions = {
    ...(parsedOptions.legacy === undefined ? {} : { legacy: parsedOptions.legacy }),
    transport: new StdioServerTransport(undefined, undefined, {
      maxBufferSize: parsedOptions.maxBufferSize ?? 32 * 1024 * 1024,
    }),
    onerror: () => process.stderr.write('MCP stdio transport error.\n'),
  }
  const sdkHandle: StdioServerHandle = serveStdio(
    () =>
      createPrincipalScopedMcpServer(application, principal, {
        ...(parsedOptions.resourceTimeoutMs === undefined
          ? {}
          : { resourceTimeoutMs: parsedOptions.resourceTimeoutMs }),
      }),
    sdkOptions,
  )

  let closePromise: Promise<void> | undefined
  const onSignal = (): void => {
    void close().catch(() => {
      process.exitCode = 1
      process.stderr.write('MCP stdio shutdown failed.\n')
    })
  }
  const removeListeners = (): void => {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    process.stdin.off('end', onSignal)
  }
  const close = (): Promise<void> => {
    if (closePromise === undefined) {
      removeListeners()
      closePromise = closeOwnedResources(application, sdkHandle).catch((error: unknown) => {
        process.exitCode = 1
        throw error
      })
    }
    return closePromise
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  process.stdin.once('end', onSignal)

  return {
    close: async () => {
      await close()
    },
  }
}

async function closeOwnedResources(
  application: CoreApplication,
  sdkHandle: StdioServerHandle,
): Promise<void> {
  let firstError: unknown
  try {
    await sdkHandle.close()
  } catch (error) {
    firstError = error
  }
  try {
    await application.shutdown()
  } catch (error) {
    firstError ??= error
  }
  if (firstError !== undefined) throw firstError
}
