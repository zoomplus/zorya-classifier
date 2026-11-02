#!/usr/bin/env node

import { constants } from 'node:fs'
import { realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'
import { z } from 'zod'

import { parseMcpConfig } from './config.js'
import type { CredentialModelProfile, ModelProfile } from './contracts.js'
import { createCoreApplication } from './core/application.js'
import { createBrowserLoginService } from './auth/browser-session.js'
import { createCredentialVault, type CredentialVault } from './auth/credential-vault.js'
import { createOidcAuthenticator } from './auth/oidc.js'
import { createOpenRouterPkceService } from './auth/openrouter-pkce.js'
import { parseHttpConfig } from './http/config.js'
import type { HttpConfig } from './http/config.js'
import { createHttpServer } from './http/server.js'
import { createEnvironmentCredentialPort } from './library/environment-credentials.js'
import { createMediaPort } from './media/loader.js'
import {
  createPrivateArtifactStore,
  type PrivateArtifactStore,
} from './media/private-artifact-store.js'
import { createPrincipalScopedMcpServer } from './tools/mcp-server.js'
import { createCoreViewerAccess } from './viewer/core-access.js'
import { startStdioServer, type ManagedStdioHandle } from './stdio/server.js'

const MAX_CONFIG_BYTES = 1_048_576

const vaultConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('memory-only') }),
  z.strictObject({
    mode: z.literal('encrypted-file'),
    filePath: z.string().min(1).max(4_096),
    keyEnv: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Z][A-Z0-9_]*$/u),
  }),
])

const cliConfigSchema = z.strictObject({
  transport: z.enum(['stdio', 'http']),
  core: z.unknown(),
  remoteImageHosts: z.array(z.string().min(1).max(253)).max(128).default([]),
  credentialVault: vaultConfigSchema,
  stdio: z
    .strictObject({
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
    .default({}),
  http: z.unknown().optional(),
  browserLogin: z
    .strictObject({
      clientId: z.string().min(1).max(256),
      scopes: z.array(z.string().min(1).max(128)).max(64),
      allowInsecureLoopbackCookies: z.boolean().optional(),
    })
    .optional(),
  openRouterPkceProfileId: z.string().min(1).max(64).optional(),
})

type CliConfig = z.output<typeof cliConfigSchema>

async function readConfigFile(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_CONFIG_BYTES)) {
      throw new Error('Configuration file is not a bounded regular file.')
    }
    const chunks: Buffer[] = []
    const buffer = Buffer.alloc(64 * 1024)
    let total = 0
    while (total <= MAX_CONFIG_BYTES) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, MAX_CONFIG_BYTES + 1 - total),
        total,
      )
      if (bytesRead === 0) break
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      total += bytesRead
    }
    if (total > MAX_CONFIG_BYTES) throw new Error('Configuration file exceeds its size limit.')
    const bytes = Buffer.concat(chunks, total)
    try {
      const after = await handle.stat({ bigint: true })
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        BigInt(bytes.byteLength) !== after.size
      ) {
        throw new Error('Configuration file changed while it was being read.')
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    } finally {
      bytes.fill(0)
    }
  } finally {
    await handle.close()
  }
}

function parseCliConfig(value: unknown): CliConfig {
  const config = cliConfigSchema.parse(value)
  if ((config.transport === 'http') !== (config.http !== undefined)) {
    throw new Error('HTTP configuration must be provided only for the HTTP transport.')
  }
  if (
    config.transport === 'stdio' &&
    (config.browserLogin !== undefined || config.openRouterPkceProfileId !== undefined)
  ) {
    throw new Error('Browser login and OpenRouter connection require the HTTP transport.')
  }
  return config
}

export function assertHttpCompositionConfig(
  config: HttpConfig,
  browserLoginEnabled: boolean,
): void {
  const resourcePath = new URL(config.resourceUrl).pathname.replace(/^\//u, '')
  const expectedMetadataPath =
    resourcePath.length === 0
      ? '/.well-known/oauth-protected-resource'
      : `/.well-known/oauth-protected-resource/${resourcePath}`
  const expectedMetadataUrl = new URL(expectedMetadataPath, config.publicOrigin).href
  if (new URL(config.resourceMetadataUrl).href !== expectedMetadataUrl) {
    throw new Error('resourceMetadataUrl must match the protected-resource metadata route.')
  }
  const ownOrigin = new URL(config.publicOrigin).origin
  if (
    browserLoginEnabled &&
    !config.allowedOrigins.some((origin) => new URL(origin).origin === ownOrigin)
  ) {
    throw new Error('browserLogin requires publicOrigin in the allowedOrigins list.')
  }
}

function decodeVaultKey(
  environment: Readonly<Record<string, string | undefined>>,
  config: CliConfig['credentialVault'],
): Uint8Array | undefined {
  if (config.mode === 'memory-only') return undefined
  const encoded = environment[config.keyEnv]
  if (
    encoded === undefined ||
    encoded.length !== 44 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  ) {
    throw new Error('Encrypted credential vault key environment variable is missing or invalid.')
  }
  const key = Buffer.from(encoded, 'base64')
  if (key.byteLength !== 32 || key.toString('base64') !== encoded) {
    key.fill(0)
    throw new Error('Encrypted credential vault key must be canonical base64 for exactly 32 bytes.')
  }
  return key
}

function createCredentialRouter(
  environment: Readonly<Record<string, string | undefined>>,
  vault: CredentialVault,
) {
  const service = createEnvironmentCredentialPort(environment)
  return {
    async resolve(input: Parameters<typeof service.resolve>[0]) {
      if (input.profile.credentialMode === 'service') return service.resolve(input)
      return vault.resolve(input)
    },
  }
}

function assertCliProfilesSupported(profiles: Readonly<Record<string, ModelProfile>>): void {
  if (Object.values(profiles).some((profile) => profile.adapter === 'injected-decision')) {
    throw new Error(
      'Injected DecisionPort profiles require the programmatic API; the CLI accepts explicitly configured network profiles.',
    )
  }
}

function configuredByokProfile(
  profiles: Readonly<Record<string, ModelProfile>>,
  profileId: string,
): CredentialModelProfile {
  const profile = profiles[profileId]
  if (
    profile === undefined ||
    !isCredentialModelProfile(profile) ||
    profile.credentialMode !== 'byok'
  ) {
    throw new Error('Credential management must reference an explicitly configured BYOK profile.')
  }
  return profile
}

function openRouterByokProfile(
  profiles: Readonly<Record<string, ModelProfile>>,
  profileId: string,
): CredentialModelProfile {
  const profile = configuredByokProfile(profiles, profileId)
  if (!profile.adapter.startsWith('openrouter-')) {
    throw new Error('OpenRouter PKCE requires an OpenRouter adapter profile.')
  }
  return profile
}

export function createCredentialManagementHandlers(
  profiles: Readonly<Record<string, ModelProfile>>,
  vault: CredentialVault,
) {
  return {
    async saveProviderCredential(input: { ownerId: string; profileId: string; apiKey: string }) {
      configuredByokProfile(profiles, input.profileId)
      await vault.save(input)
    },
    async removeProviderCredential(input: { ownerId: string; profileId: string }) {
      configuredByokProfile(profiles, input.profileId)
      await vault.remove(input)
    },
  }
}

function isCredentialModelProfile(profile: ModelProfile): profile is CredentialModelProfile {
  return profile.adapter !== 'injected-decision' && profile.credentialMode !== 'none'
}

async function start(): Promise<void> {
  const configPath = process.env['ZORYA_MCP_CONFIG']
  if (configPath === undefined || configPath.length === 0) {
    throw new Error('Set ZORYA_MCP_CONFIG to the path of the server JSON configuration file.')
  }

  const rawConfig = await readConfigFile(resolve(configPath))
  const cliConfig = parseCliConfig(rawConfig)
  const coreConfig = parseMcpConfig(cliConfig.core)
  assertCliProfilesSupported(coreConfig.profiles)

  let artifactStore: PrivateArtifactStore | undefined
  let credentialVault: CredentialVault | undefined
  let application: ReturnType<typeof createCoreApplication> | undefined
  let stdio: ManagedStdioHandle | undefined
  let http: ReturnType<typeof createHttpServer> | undefined
  let shutdownPromise: Promise<void> | undefined
  let shutdownListenersInstalled = false

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = (async () => {
      const failures: unknown[] = []
      for (const dispose of [
        async () => {
          if (http !== undefined) await http.shutdown()
        },
        async () => {
          if (stdio !== undefined) await stdio.close()
        },
        async () => {
          if (stdio === undefined && application !== undefined) await application.shutdown()
        },
        async () => {
          if (artifactStore !== undefined) await artifactStore.dispose()
        },
        async () => {
          if (credentialVault !== undefined) await credentialVault.dispose()
        },
      ]) {
        try {
          await dispose()
        } catch (error) {
          failures.push(error)
        }
      }
      if (shutdownListenersInstalled) {
        process.off('SIGINT', onSignal)
        process.off('SIGTERM', onSignal)
        process.stdin.off('end', onSignal)
        shutdownListenersInstalled = false
      }
      if (failures.length > 0) throw new AggregateError(failures, 'MCP shutdown was incomplete.')
    })()
    return shutdownPromise
  }
  const onSignal = (): void => {
    void shutdown().catch(() => {
      process.exitCode = 1
      process.stderr.write('MCP shutdown did not complete cleanly.\n')
    })
  }

  try {
    const limits = coreConfig.limits
    const sharedArtifactStore = createPrivateArtifactStore({
      maxGlobalBytes: limits.maxArtifactTotalBytes,
      maxOwnerBytes: limits.maxArtifactTotalBytesPerOwner,
      maxArtifactBytes: limits.maxArtifactBytes,
      maxArtifacts: Math.min(limits.maxStoredJobs * 3 + 10_000, 100_000),
      maxArtifactsPerOwner: Math.min(limits.maxStoredJobsPerOwner * 3 + 100, 10_000),
      ttlMs: limits.artifactTtlMs,
    })
    artifactStore = sharedArtifactStore

    const vaultKey = decodeVaultKey(process.env, cliConfig.credentialVault)
    let createdVault: CredentialVault | undefined
    try {
      const vaultConfiguration =
        cliConfig.credentialVault.mode === 'memory-only'
          ? { mode: 'memory-only' as const }
          : vaultKey === undefined
            ? undefined
            : {
                mode: 'encrypted-file' as const,
                filePath: resolve(cliConfig.credentialVault.filePath),
                encryptionKey: vaultKey,
              }
      if (vaultConfiguration === undefined)
        throw new Error('Encrypted credential vault key is unavailable.')
      createdVault = await createCredentialVault(vaultConfiguration)
      credentialVault = createdVault
    } finally {
      vaultKey?.fill(0)
    }
    if (createdVault === undefined) throw new Error('Credential vault could not be initialized.')
    const vault = createdVault

    const mediaPort = createMediaPort({
      remote: {
        trustedHosts: cliConfig.remoteImageHosts,
        maxPixels: limits.maxImagePixels,
      },
      ...(coreConfig.stdio.inputRoot === undefined
        ? {}
        : { stdioInputRoot: resolve(coreConfig.stdio.inputRoot) }),
      readUploaded: (input) => sharedArtifactStore.readUploaded(input),
      maxPixels: limits.maxImagePixels,
    })
    const coreApplication = createCoreApplication({
      config: coreConfig,
      mediaPort,
      artifactPort: sharedArtifactStore,
      credentialPort: createCredentialRouter(process.env, vault),
      mediaCapabilities: {
        remote: cliConfig.remoteImageHosts.length > 0,
        uploads: cliConfig.transport === 'http',
      },
    })
    application = coreApplication

    if (cliConfig.transport === 'stdio') {
      stdio = startStdioServer(coreApplication, {
        ...(cliConfig.stdio.ownerId === undefined ? {} : { ownerId: cliConfig.stdio.ownerId }),
        ...(cliConfig.stdio.legacy === undefined ? {} : { legacy: cliConfig.stdio.legacy }),
        ...(cliConfig.stdio.maxBufferSize === undefined
          ? {}
          : { maxBufferSize: cliConfig.stdio.maxBufferSize }),
        ...(cliConfig.stdio.resourceTimeoutMs === undefined
          ? {}
          : { resourceTimeoutMs: cliConfig.stdio.resourceTimeoutMs }),
      })
      process.once('SIGINT', onSignal)
      process.once('SIGTERM', onSignal)
      process.stdin.once('end', onSignal)
      shutdownListenersInstalled = true
      return
    }

    const httpConfig = parseHttpConfig(cliConfig.http)
    assertHttpCompositionConfig(httpConfig, cliConfig.browserLogin !== undefined)
    if (
      cliConfig.openRouterPkceProfileId !== undefined &&
      !httpConfig.credentialProfileIds.includes(cliConfig.openRouterPkceProfileId)
    ) {
      throw new Error('The OpenRouter PKCE profile must be enabled in HTTP credentialProfileIds.')
    }
    if (httpConfig.credentialProfileIds.length > 0 && cliConfig.browserLogin === undefined) {
      throw new Error('HTTP provider credential management requires browserLogin configuration.')
    }
    for (const profileId of httpConfig.credentialProfileIds) {
      const profile = coreConfig.profiles[profileId]
      if (
        profile === undefined ||
        profile.adapter === 'injected-decision' ||
        profile.credentialMode !== 'byok'
      ) {
        throw new Error('HTTP credentialProfileIds must name explicitly configured BYOK profiles.')
      }
    }
    if (cliConfig.openRouterPkceProfileId !== undefined) {
      openRouterByokProfile(coreConfig.profiles, cliConfig.openRouterPkceProfileId)
    }
    const authenticator = await createOidcAuthenticator({
      issuer: httpConfig.issuer,
      audience: httpConfig.audience,
      resourceUrl: httpConfig.resourceUrl,
      resourceMetadataUrl: httpConfig.resourceMetadataUrl,
      requiredScopes: httpConfig.requiredScopes,
    })
    const browserLogin =
      cliConfig.browserLogin === undefined
        ? undefined
        : await createBrowserLoginService(
            {
              issuer: httpConfig.issuer,
              clientId: cliConfig.browserLogin.clientId,
              redirectUri: new URL(httpConfig.loginCallbackPath, httpConfig.publicOrigin).href,
              publicOrigin: httpConfig.publicOrigin,
              resource: httpConfig.resourceUrl,
              scopes: cliConfig.browserLogin.scopes,
              ...(cliConfig.browserLogin.allowInsecureLoopbackCookies === undefined
                ? {}
                : {
                    allowInsecureLoopbackCookies:
                      cliConfig.browserLogin.allowInsecureLoopbackCookies,
                  }),
            },
            authenticator,
          )
    const viewer = createCoreViewerAccess(coreApplication)
    const credentialHandlers = createCredentialManagementHandlers(coreConfig.profiles, vault)
    const pkce =
      cliConfig.openRouterPkceProfileId === undefined
        ? undefined
        : createOpenRouterPkceService(
            {
              callbackUrl: new URL(httpConfig.openRouterCallbackPath, httpConfig.publicOrigin).href,
              profileId: cliConfig.openRouterPkceProfileId,
              publicOrigin: httpConfig.publicOrigin,
            },
            async (input) => {
              openRouterByokProfile(coreConfig.profiles, input.profileId)
              await vault.save(input)
            },
          )

    const runningHttpServer = createHttpServer({
      config: httpConfig,
      authenticator,
      ...(browserLogin === undefined ? {} : { browserLogin }),
      readViewerDocument: viewer.readDocument,
      readViewerArtifact: viewer.readArtifact,
      ...(pkce === undefined ? {} : { openRouterPkce: pkce }),
      artifactStore: sharedArtifactStore,
      createServerForPrincipal: (principal) =>
        createPrincipalScopedMcpServer(coreApplication, principal),
      ...credentialHandlers,
    })
    http = runningHttpServer
    await new Promise<void>((resolveListen, rejectListen) => {
      runningHttpServer.server.once('error', rejectListen)
      runningHttpServer.server.listen(httpConfig.port, httpConfig.bindHost, () => {
        runningHttpServer.server.off('error', rejectListen)
        resolveListen()
      })
    })
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    shutdownListenersInstalled = true
  } catch (error: unknown) {
    try {
      await shutdown()
    } catch (cleanupError: unknown) {
      const cleanupType = cleanupError instanceof Error ? cleanupError.name : 'unknown'
      process.stderr.write(`MCP startup cleanup did not complete cleanly (${cleanupType}).\n`)
    }
    throw error
  }
}

async function main(): Promise<void> {
  try {
    await start()
  } catch {
    process.exitCode = 1
    process.stderr.write(
      'MCP server could not start. Check the bounded configuration and operator setup.\n',
    )
  }
}

const entryPath = process.argv[1]
let invokedAsEntry = false
if (entryPath !== undefined) {
  try {
    invokedAsEntry = realpathSync(entryPath) === fileURLToPath(import.meta.url)
  } catch {
    invokedAsEntry = false
  }
}
if (invokedAsEntry) await main()
