import type { DecisionPort, ExtractionResult } from 'zorya-classifier'
import { z } from 'zod'

import { parseMcpConfig } from '../config.js'
import type {
  ArtifactDescriptor,
  ArtifactPort,
  CoreApplication as CoreApplicationContract,
  ClassifierFactory,
  CredentialPort,
  CredentialModelProfile,
  ImagePayload,
  ImageSource,
  JsonObject,
  MediaPort,
  ModelProfile,
  OpenAICompatibleProfile,
  OperationOutput,
  Principal,
  ResourcePayload,
} from '../contracts.js'
import { McpCoreError, abortError } from '../errors.js'
import { PublishedClassifierFactory } from '../library/published-classifier-factory.js'
import { packMaskBytes } from './packed-mask.js'
import { JobScheduler } from './job-scheduler.js'
import {
  cancelJobToolInputSchema,
  capabilitiesToolInputSchema,
  classifyToolInputSchema,
  extractToolInputSchema,
  getJobToolInputSchema,
  imageSourceFromInput,
  locateToolInputSchema,
} from '../tools/schemas.js'

export interface CoreApplicationOptions {
  readonly config: unknown
  readonly mediaPort: MediaPort
  readonly artifactPort: CoreArtifactPort
  readonly mediaCapabilities?: { readonly remote: boolean; readonly uploads: boolean }
  readonly credentialPort?: CredentialPort
  readonly classifierFactory?: ClassifierFactory
  readonly injectedDecisionPorts?: Readonly<Record<string, DecisionPort>>
  readonly onCleanupFailure?: () => void
}

export type CoreArtifactPort = ArtifactPort

interface OperationInput {
  readonly source?: ImageSource
  readonly text?: string
  readonly target?: string
  readonly classes?: readonly { readonly id: string; readonly description: string }[]
  readonly instructions?: string
  readonly exclusions?: readonly string[]
  readonly roi?: {
    readonly left: number
    readonly top: number
    readonly width: number
    readonly height: number
  }
  readonly mode?: 'region' | 'whole-object'
  readonly profileId?: string
}

const jsonObjectSchema = z.record(z.string(), z.json())
const mediaCapabilitiesSchema = z.strictObject({
  remote: z.boolean(),
  uploads: z.boolean(),
})
const mediaTypeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.+-]+\/[\w.+-]+$/)
const artifactDescriptorSchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    role: z.enum(['source', 'cutout', 'mask']),
    mediaType: mediaTypeSchema,
    byteLength: z.number().int().min(0).max(100_000_000),
    expiresAt: z.number().int().positive(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    encoding: z.string().min(1).max(64).optional(),
  })
  .superRefine((descriptor, context) => {
    if ((descriptor.width === undefined) !== (descriptor.height === undefined)) {
      context.addIssue({ code: 'custom', message: 'Artifact dimensions must be paired.' })
    }
  })

export class CoreApplication implements CoreApplicationContract {
  readonly #config
  readonly #mediaPort: MediaPort
  readonly #artifactPort: CoreArtifactPort
  readonly #credentialPort: CredentialPort | undefined
  readonly #classifierFactory: ClassifierFactory
  readonly #injectedDecisionPorts: Readonly<Record<string, DecisionPort>>
  readonly #mediaCapabilities: { readonly remote: boolean; readonly uploads: boolean }
  readonly #scheduler: JobScheduler

  constructor(options: CoreApplicationOptions) {
    this.#config = parseMcpConfig(options.config)
    this.#mediaPort = options.mediaPort
    this.#artifactPort = options.artifactPort
    this.#mediaCapabilities = mediaCapabilitiesSchema.parse(
      options.mediaCapabilities ?? { remote: false, uploads: false },
    )
    this.#credentialPort = options.credentialPort
    this.#classifierFactory =
      options.classifierFactory ?? new PublishedClassifierFactory(this.#config)
    this.#injectedDecisionPorts = options.injectedDecisionPorts ?? {}
    this.#scheduler = new JobScheduler({
      config: this.#config,
      onEvict: (ownerId, jobId) =>
        this.#artifactPort.deleteJob({
          ownerId,
          jobId,
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 1_000,
        }),
      ...(options.onCleanupFailure === undefined
        ? {}
        : { onCleanupFailure: options.onCleanupFailure }),
    })
  }

  async invoke(input: {
    readonly toolName: string
    readonly args: unknown
    readonly principal: Principal
    readonly signal: AbortSignal
  }): Promise<JsonObject> {
    input.signal.throwIfAborted()
    switch (input.toolName) {
      case 'zorya_classify': {
        const args = parseToolInput(classifyToolInputSchema, input.args)
        const source = imageSourceFromInput(args)
        this.#validateImageSource(source, input.principal)
        const operationInput: OperationInput = {
          ...(source === undefined ? {} : { source }),
          ...(args.text === undefined ? {} : { text: args.text }),
          classes: args.classes,
          ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
          ...(args.profileId === undefined ? {} : { profileId: args.profileId }),
        }
        return this.#submit({
          principal: input.principal,
          signal: input.signal,
          operation: 'classify',
          queuedBytes: estimateQueuedBytes(operationInput),
          input: operationInput,
        })
      }
      case 'zorya_locate': {
        const args = parseToolInput(locateToolInputSchema, input.args)
        const source = imageSourceFromInput(args)
        if (source === undefined)
          throw new McpCoreError('INVALID_INPUT', 'An image source is required.')
        this.#validateImageSource(source, input.principal)
        if (args.mode === 'whole-object') this.#requireSegmentation('Whole-object localization')
        const operationInput: OperationInput = {
          source,
          target: args.target,
          exclusions: args.exclusions,
          ...(args.roi === undefined ? {} : { roi: args.roi }),
          mode: args.mode,
          ...(args.profileId === undefined ? {} : { profileId: args.profileId }),
        }
        return this.#submit({
          principal: input.principal,
          signal: input.signal,
          operation: 'locate',
          queuedBytes: estimateQueuedBytes(operationInput),
          input: operationInput,
        })
      }
      case 'zorya_extract': {
        const args = parseToolInput(extractToolInputSchema, input.args)
        const source = imageSourceFromInput(args)
        if (source === undefined)
          throw new McpCoreError('INVALID_INPUT', 'An image source is required.')
        this.#validateImageSource(source, input.principal)
        this.#requireSegmentation('Object extraction')
        const operationInput: OperationInput = {
          source,
          target: args.target,
          exclusions: args.exclusions,
          ...(args.roi === undefined ? {} : { roi: args.roi }),
          ...(args.profileId === undefined ? {} : { profileId: args.profileId }),
        }
        return this.#submit({
          principal: input.principal,
          signal: input.signal,
          operation: 'extract',
          queuedBytes: estimateQueuedBytes(operationInput),
          input: operationInput,
        })
      }
      case 'zorya_get_job': {
        const args = parseToolInput(getJobToolInputSchema, input.args)
        return this.#toBoundedJsonObject(this.#scheduler.get(input.principal.ownerId, args.jobId))
      }
      case 'zorya_cancel_job': {
        const args = parseToolInput(cancelJobToolInputSchema, input.args)
        return this.#toBoundedJsonObject(
          this.#scheduler.cancel(input.principal.ownerId, args.jobId),
        )
      }
      case 'zorya_capabilities': {
        parseToolInput(capabilitiesToolInputSchema, input.args)
        return this.#toBoundedJsonObject(this.#capabilities(input.principal))
      }
      default:
        throw new McpCoreError('INVALID_INPUT', 'Unknown tool.')
    }
  }

  async readResource(input: {
    readonly uri: string
    readonly principal: Principal
    readonly signal: AbortSignal
    readonly deadlineAt: number
  }): Promise<ResourcePayload> {
    this.#assertActive(input.signal, input.deadlineAt)
    let uri: URL
    try {
      uri = new URL(input.uri)
    } catch {
      throw new McpCoreError('NOT_FOUND', 'Resource was not found.')
    }
    if (uri.protocol !== 'zorya:') throw new McpCoreError('NOT_FOUND', 'Resource was not found.')
    const id = uri.pathname.slice(1)
    if (id.length === 0 || uri.search.length > 0 || uri.hash.length > 0) {
      throw new McpCoreError('NOT_FOUND', 'Resource was not found.')
    }
    if (uri.hostname === 'jobs') {
      return {
        kind: 'json',
        mediaType: 'application/json',
        value: this.#toBoundedJsonObject(
          this.#scheduler.readResourceSnapshot(input.principal.ownerId, id),
        ),
      }
    }
    if (uri.hostname === 'artifacts') {
      const artifact = await this.#artifactPort.read({
        ownerId: input.principal.ownerId,
        artifactId: id,
        signal: input.signal,
        deadlineAt: input.deadlineAt,
        maxBytes: this.#config.limits.maxArtifactBytes,
      })
      this.#assertActive(input.signal, input.deadlineAt)
      if (
        !(artifact.bytes instanceof Uint8Array) ||
        !mediaTypeSchema.safeParse(artifact.mediaType).success
      ) {
        throw new McpCoreError('ARTIFACT_UNAVAILABLE', 'Artifact metadata is invalid.')
      }
      const bytes = Uint8Array.from(artifact.bytes)
      if (bytes.byteLength > this.#config.limits.maxArtifactBytes) {
        throw new McpCoreError(
          'ARTIFACT_UNAVAILABLE',
          'Artifact exceeds the configured size limit.',
        )
      }
      return { kind: 'binary', mediaType: artifact.mediaType, bytes }
    }
    throw new McpCoreError('NOT_FOUND', 'Resource was not found.')
  }

  async shutdown(): Promise<void> {
    await this.#scheduler.shutdown()
  }

  #submit(input: {
    readonly principal: Principal
    readonly signal: AbortSignal
    readonly operation: 'classify' | 'locate' | 'extract'
    readonly queuedBytes: number
    readonly input: OperationInput
  }): JsonObject {
    input.signal.throwIfAborted()
    return this.#scheduler.submit({
      principal: input.principal,
      operation: input.operation,
      queuedBytes: input.queuedBytes,
      task: (jobId, signal, deadlineAt) =>
        this.#runOperation(
          jobId,
          input.principal,
          input.operation,
          input.input,
          signal,
          deadlineAt,
        ),
    })
  }

  async #runOperation(
    jobId: string,
    principal: Principal,
    operation: 'classify' | 'locate' | 'extract',
    input: OperationInput,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<OperationOutput> {
    this.#assertActive(signal, deadlineAt)
    let image: ImagePayload | undefined
    let sourceArtifact: ArtifactDescriptor | undefined
    let lease: Awaited<ReturnType<ClassifierFactory['create']>> | undefined
    let completed = false
    try {
      const profile = this.#selectProfile(input.profileId)
      this.#assertAdapterSupports(profile, operation, input.source !== undefined)
      if (input.source !== undefined) {
        const loaded = await this.#mediaPort.loadImage({
          source: input.source,
          principal,
          signal,
          deadlineAt,
          maxBytes: this.#config.limits.maxImageBytes,
        })
        this.#assertActive(signal, deadlineAt)
        image = ownAndValidateImage(
          loaded,
          this.#config.limits.maxImageBytes,
          this.#config.limits.maxImagePixels,
        )
      }

      lease = await this.#createLease(profile, principal, signal, deadlineAt)
      this.#assertActive(signal, deadlineAt)

      if (operation === 'classify') {
        if (input.classes === undefined)
          throw new McpCoreError('INVALID_INPUT', 'Classes are required.')
        const result = await lease.classifier.classify({
          signal,
          input: {
            ...(input.text === undefined ? {} : { text: input.text }),
            ...(image === undefined ? {} : { image: image.bytes }),
          },
          classes: [...input.classes],
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        })
        this.#assertActive(signal, deadlineAt)
        completed = true
        return { operation: 'classify', result }
      }

      if (input.target === undefined || image === undefined) {
        throw new McpCoreError('INVALID_INPUT', 'Spatial operations require an image and target.')
      }
      if (operation === 'locate') {
        if (input.mode === 'whole-object') {
          if (lease.segmenter === undefined)
            this.#requireLeaseSegmenter('Whole-object localization')
          const result = await lease.classifier.locate({
            image: image.bytes,
            target: input.target,
            exclusions: [...(input.exclusions ?? [])],
            ...(input.roi === undefined ? {} : { roi: input.roi }),
            mode: 'whole-object',
            signal,
          })
          this.#assertActive(signal, deadlineAt)
          sourceArtifact = await this.#storeSourceArtifact(
            image,
            principal.ownerId,
            jobId,
            signal,
            deadlineAt,
          )
          this.#scheduler.addArtifacts(principal.ownerId, jobId, [sourceArtifact])
          completed = true
          return {
            operation: 'locate',
            result: { geometryKind: 'whole-object', result },
          }
        }
        const result = await lease.classifier.locate({
          image: image.bytes,
          target: input.target,
          exclusions: [...(input.exclusions ?? [])],
          ...(input.roi === undefined ? {} : { roi: input.roi }),
          mode: 'region',
          signal,
        })
        this.#assertActive(signal, deadlineAt)
        sourceArtifact = await this.#storeSourceArtifact(
          image,
          principal.ownerId,
          jobId,
          signal,
          deadlineAt,
        )
        this.#scheduler.addArtifacts(principal.ownerId, jobId, [sourceArtifact])
        completed = true
        return { operation: 'locate', result: { geometryKind: 'coarse-region', result } }
      }

      if (lease.segmenter === undefined) this.#requireLeaseSegmenter('Object extraction')
      const extraction = await lease.classifier.extract({
        image: image.bytes,
        target: input.target,
        exclusions: [...(input.exclusions ?? [])],
        ...(input.roi === undefined ? {} : { roi: input.roi }),
        signal,
      })
      this.#assertActive(signal, deadlineAt)
      sourceArtifact = await this.#storeSourceArtifact(
        image,
        principal.ownerId,
        jobId,
        signal,
        deadlineAt,
      )
      this.#scheduler.addArtifacts(principal.ownerId, jobId, [sourceArtifact])
      const artifacts: ArtifactDescriptor[] = sourceArtifact === undefined ? [] : [sourceArtifact]
      const projected = await this.#projectExtraction(
        extraction,
        principal.ownerId,
        jobId,
        signal,
        deadlineAt,
        artifacts,
      )
      this.#scheduler.addArtifacts(
        principal.ownerId,
        jobId,
        projected.artifacts.filter((artifact) => artifact.role !== 'source'),
      )
      this.#assertActive(signal, deadlineAt)
      completed = true
      return { operation: 'extract', result: projected }
    } finally {
      try {
        if (lease !== undefined) await lease.dispose({ signal, deadlineAt })
      } finally {
        if (!completed && operation !== 'classify') {
          this.#scheduler.clearArtifacts(principal.ownerId, jobId)
          // Job-scoped cleanup is awaited before releasing the scheduler slot, even after abort.
          await this.#artifactPort.deleteJob({
            ownerId: principal.ownerId,
            jobId,
            signal,
            deadlineAt,
          })
        }
      }
    }
  }

  async #projectExtraction(
    result: ExtractionResult,
    ownerId: string,
    jobId: string,
    signal: AbortSignal,
    deadlineAt: number,
    artifacts: ArtifactDescriptor[],
  ) {
    if (result.status === 'extracted') {
      const png = await this.#putArtifact({
        ownerId,
        jobId,
        role: 'cutout',
        bytes: result.png,
        mediaType: 'image/png',
        width: result.mask.width,
        height: result.mask.height,
        expiresAt: Date.now() + this.#config.limits.artifactTtlMs,
        signal,
        deadlineAt,
      })
      const mask = await this.#putArtifact({
        ownerId,
        jobId,
        role: 'mask',
        bytes: packMaskBytes(result.mask.data, result.mask.width, result.mask.height),
        mediaType: 'application/octet-stream',
        width: result.mask.width,
        height: result.mask.height,
        encoding: 'binary-lsb0',
        expiresAt: Date.now() + this.#config.limits.artifactTtlMs,
        signal,
        deadlineAt,
      })
      artifacts.push(png, mask)
      return {
        status: 'extracted' as const,
        location: result.location,
        region: result.region,
        center: result.center,
        offset: result.offset,
        segmentation: result.segmentation,
        ...(result.verification === undefined ? {} : { verification: result.verification }),
        artifacts: [...artifacts],
      }
    }
    if (result.status === 'not-found') {
      return {
        status: 'not-found' as const,
        reason: result.reason,
        metadata: result.metadata,
        artifacts: [...artifacts],
      }
    }
    return {
      status: 'unknown' as const,
      reason: result.reason,
      ...('metadata' in result ? { metadata: result.metadata } : {}),
      ...('location' in result ? { location: result.location } : {}),
      ...('seedLocation' in result ? { seedLocation: result.seedLocation } : {}),
      ...('segmentation' in result ? { segmentation: result.segmentation } : {}),
      ...('verification' in result ? { verification: result.verification } : {}),
      artifacts: [...artifacts],
    }
  }

  async #putArtifact(input: Parameters<CoreArtifactPort['put']>[0]): Promise<ArtifactDescriptor> {
    this.#assertActive(input.signal, input.deadlineAt)
    if (input.bytes.byteLength > this.#config.limits.maxArtifactBytes) {
      throw new McpCoreError('RESOURCE_LIMIT', 'Artifact exceeds the configured size limit.')
    }
    const bytes = Uint8Array.from(input.bytes)
    const descriptor = await this.#artifactPort.put({ ...input, bytes })
    this.#assertActive(input.signal, input.deadlineAt)
    const parsedDescriptor = artifactDescriptorSchema.safeParse(descriptor)
    if (!parsedDescriptor.success) {
      throw new McpCoreError('ARTIFACT_UNAVAILABLE', 'Artifact metadata is invalid.')
    }
    if (
      parsedDescriptor.data.byteLength !== bytes.byteLength ||
      parsedDescriptor.data.mediaType !== input.mediaType ||
      parsedDescriptor.data.role !== input.role ||
      parsedDescriptor.data.expiresAt > input.expiresAt ||
      parsedDescriptor.data.expiresAt <= Date.now() ||
      parsedDescriptor.data.byteLength > this.#config.limits.maxArtifactBytes
    ) {
      throw new McpCoreError('ARTIFACT_UNAVAILABLE', 'Artifact exceeds the configured size limit.')
    }
    const normalized = parsedDescriptor.data
    return {
      id: normalized.id,
      role: normalized.role,
      mediaType: normalized.mediaType,
      byteLength: normalized.byteLength,
      expiresAt: normalized.expiresAt,
      ...(normalized.width === undefined ? {} : { width: normalized.width }),
      ...(normalized.height === undefined ? {} : { height: normalized.height }),
      ...(normalized.encoding === undefined ? {} : { encoding: normalized.encoding }),
    }
  }

  async #storeSourceArtifact(
    image: ImagePayload,
    ownerId: string,
    jobId: string,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<ArtifactDescriptor> {
    return this.#putArtifact({
      ownerId,
      jobId,
      role: 'source',
      bytes: image.bytes,
      mediaType: image.mediaType,
      width: image.width,
      height: image.height,
      expiresAt: Date.now() + this.#config.limits.artifactTtlMs,
      signal,
      deadlineAt,
    })
  }

  async #createLease(
    profile: ModelProfile,
    principal: Principal,
    signal: AbortSignal,
    deadlineAt: number,
  ) {
    this.#assertActive(signal, deadlineAt)
    if (profile.adapter === 'injected-decision') {
      const decisionPort = this.#injectedDecisionPorts[profile.id]
      if (decisionPort === undefined) {
        throw new McpCoreError(
          'UNSUPPORTED_OPERATION',
          'This injected DecisionPort profile has no caller-provided port.',
        )
      }
      return this.#classifierFactory.create({
        profile,
        decisionPort,
        principal,
        signal,
        deadlineAt,
      })
    }
    if (isKeylessOpenAIProfile(profile)) {
      return this.#classifierFactory.create({ profile, principal, signal, deadlineAt })
    }
    if (!isCredentialModelProfile(profile)) {
      throw new McpCoreError('INVALID_INPUT', 'The configured profile is invalid.')
    }
    const credentialPort = this.#credentialPort
    if (credentialPort === undefined) {
      throw new McpCoreError('CREDENTIAL_UNAVAILABLE', 'No credential resolver is configured.')
    }
    const credential = await credentialPort.resolve({ profile, principal, signal, deadlineAt })
    this.#assertActive(signal, deadlineAt)
    if (credential.apiKey.length === 0) {
      throw new McpCoreError('CREDENTIAL_UNAVAILABLE', 'The configured credential is unavailable.')
    }
    return this.#classifierFactory.create({
      profile,
      apiKey: credential.apiKey,
      principal,
      signal,
      deadlineAt,
    })
  }

  #selectProfile(profileId: string | undefined): ModelProfile {
    const selectedId = profileId ?? this.#config.defaultProfileId
    if (!Object.hasOwn(this.#config.profiles, selectedId)) {
      throw new McpCoreError('INVALID_INPUT', 'The requested profile is not configured.')
    }
    const profile = this.#config.profiles[selectedId]
    if (profile === undefined)
      throw new McpCoreError('INVALID_INPUT', 'The requested profile is unavailable.')
    return profile
  }

  #assertAdapterSupports(profile: ModelProfile, operation: string, hasImage: boolean): void {
    if (profile.adapter === 'openai-compatible-text' && hasImage) {
      throw new McpCoreError(
        'UNSUPPORTED_OPERATION',
        'The selected text adapter cannot accept images.',
      )
    }
    if (operation !== 'classify' && profile.adapter === 'openai-compatible-text') {
      throw new McpCoreError(
        'UNSUPPORTED_OPERATION',
        'Spatial operations require a vision adapter.',
      )
    }
  }

  #requireSegmentation(operation: string): void {
    if (this.#config.segmentation === undefined) {
      throw new McpCoreError(
        'UNSUPPORTED_OPERATION',
        `${operation} is unavailable because no caller-owned segmenter is configured.`,
      )
    }
  }

  #requireLeaseSegmenter(operation: string): never {
    throw new McpCoreError(
      'UNSUPPORTED_OPERATION',
      `${operation} is unavailable because the selected classifier lease has no segmenter.`,
    )
  }

  #validateImageSource(source: ImageSource | undefined, principal: Principal): void {
    if (source === undefined) return
    if (source.kind === 'localPath') {
      if (principal.transport !== 'stdio') {
        throw new McpCoreError('FORBIDDEN', 'Local file paths are available only over stdio.')
      }
      if (this.#config.stdio.inputRoot === undefined) {
        throw new McpCoreError('UNSUPPORTED_OPERATION', 'No stdio input directory is configured.')
      }
      return
    }
    if (
      (source.kind === 'url' || source.kind === 'chatgptFile') &&
      !this.#mediaCapabilities.remote
    ) {
      throw new McpCoreError(
        'UNSUPPORTED_OPERATION',
        'Remote image sources are unavailable without configured trusted hosts.',
      )
    }
    if (source.kind === 'uploadedId' && !this.#mediaCapabilities.uploads) {
      throw new McpCoreError('UNSUPPORTED_OPERATION', 'Uploaded image ids are not configured.')
    }
  }

  #capabilities(principal: Principal): JsonObject {
    const profiles = Object.values(this.#config.profiles).map((profile) => ({
      id: profile.id,
      adapter: profile.adapter,
      ...(profile.adapter === 'injected-decision' ? {} : { model: profile.model }),
      ...('provider' in profile && profile.provider !== undefined
        ? { provider: profile.provider }
        : {}),
      ...('providerName' in profile && profile.providerName !== undefined
        ? { providerName: profile.providerName }
        : {}),
      ...('responseModelIds' in profile && profile.responseModelIds !== undefined
        ? { responseModelIds: [...profile.responseModelIds] }
        : {}),
    }))
    const hasSpatialProfile = Object.values(this.#config.profiles).some(
      (profile) => profile.adapter !== 'openai-compatible-text',
    )
    const hasSegmenter = this.#config.segmentation !== undefined
    return {
      transport: {
        active: principal.transport,
        supportedProtocols: [
          'stdio:2026-07-28',
          'stdio:2025-11-25',
          'streamable-http:2026-07-28',
          'streamable-http:2025-11-25',
          'legacy-sse:2025-11-25',
        ],
      },
      inputs: {
        inlineBase64: true,
        localPath: principal.transport === 'stdio' && this.#config.stdio.inputRoot !== undefined,
        url: this.#mediaCapabilities.remote,
        chatgptFile: this.#mediaCapabilities.remote,
        uploadedId: this.#mediaCapabilities.uploads,
      },
      profiles,
      operations: {
        classify: true,
        locateRegion: hasSpatialProfile,
        locateWholeObject: hasSpatialProfile && hasSegmenter,
        extract: hasSpatialProfile && hasSegmenter,
      },
      limits: {
        maxImageBytes: this.#config.limits.maxImageBytes,
        maxImagePixels: this.#config.limits.maxImagePixels,
        maxQueuedJobs: this.#config.limits.maxQueuedJobs,
        maxQueuedJobsPerOwner: this.#config.limits.maxQueuedJobsPerOwner,
        maxStoredJobs: this.#config.limits.maxStoredJobs,
        maxStoredJobsPerOwner: this.#config.limits.maxStoredJobsPerOwner,
        maxQueuedInputBytes: this.#config.limits.maxQueuedInputBytes,
        maxQueuedInputBytesPerOwner: this.#config.limits.maxQueuedInputBytesPerOwner,
        maxActiveJobs: this.#config.limits.maxActiveJobs,
        maxActiveJobsPerOwner: this.#config.limits.maxActiveJobsPerOwner,
        jobTimeoutMs: this.#config.limits.jobTimeoutMs,
        jobTtlMs: this.#config.limits.jobTtlMs,
        artifactTtlMs: this.#config.limits.artifactTtlMs,
        maxArtifactBytes: this.#config.limits.maxArtifactBytes,
        maxArtifactTotalBytes: this.#config.limits.maxArtifactTotalBytes,
        maxArtifactTotalBytesPerOwner: this.#config.limits.maxArtifactTotalBytesPerOwner,
        maxResultJsonBytes: this.#config.limits.maxResultJsonBytes,
      },
    }
  }

  #assertActive(signal: AbortSignal, deadlineAt: number): void {
    if (signal.aborted) throw abortError(signal)
    if (Date.now() >= deadlineAt) {
      throw new McpCoreError('TIMEOUT', 'Job deadline exceeded.', true)
    }
  }

  #toBoundedJsonObject(value: unknown): JsonObject {
    const output = toJsonObject(value)
    if (Buffer.byteLength(JSON.stringify(output)) > this.#config.limits.maxResultJsonBytes) {
      throw new McpCoreError('RESOURCE_LIMIT', 'Tool output exceeds the configured size limit.')
    }
    return output
  }
}

function estimateQueuedBytes(input: OperationInput): number {
  return Buffer.byteLength(JSON.stringify(input))
}

function isKeylessOpenAIProfile(profile: ModelProfile): profile is OpenAICompatibleProfile & {
  readonly credentialMode: 'none'
} {
  return (
    (profile.adapter === 'openai-compatible-vision' ||
      profile.adapter === 'openai-compatible-text') &&
    profile.credentialMode === 'none'
  )
}

function isCredentialModelProfile(profile: ModelProfile): profile is CredentialModelProfile {
  return profile.adapter !== 'injected-decision' && profile.credentialMode !== 'none'
}

function ownAndValidateImage(
  image: ImagePayload,
  maxBytes: number,
  maxPixels: number,
): ImagePayload {
  if (!(image.bytes instanceof Uint8Array) || image.bytes.byteLength === 0) {
    throw new McpCoreError('MEDIA_UNAVAILABLE', 'The image source did not contain valid bytes.')
  }
  if (image.bytes.byteLength > maxBytes) {
    throw new McpCoreError('RESOURCE_LIMIT', 'Image exceeds the configured byte limit.')
  }
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width * image.height > maxPixels
  ) {
    throw new McpCoreError('RESOURCE_LIMIT', 'Image dimensions exceed the configured pixel limit.')
  }
  if (!/^image\/[a-zA-Z0-9.+-]+$/.test(image.mediaType)) {
    throw new McpCoreError('MEDIA_UNAVAILABLE', 'The image media type is invalid.')
  }
  return {
    bytes: Uint8Array.from(image.bytes),
    mediaType: image.mediaType,
    width: image.width,
    height: image.height,
  }
}

function toJsonObject(value: unknown): JsonObject {
  return jsonObjectSchema.parse(value)
}

function parseToolInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  try {
    return schema.parse(input)
  } catch {
    throw new McpCoreError('INVALID_INPUT', 'Tool arguments are invalid.')
  }
}

export function createCoreApplication(options: CoreApplicationOptions): CoreApplication {
  return new CoreApplication(options)
}
