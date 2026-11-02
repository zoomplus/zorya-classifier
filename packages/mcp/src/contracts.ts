import type {
  AnyLocateInput,
  ClassifyInput,
  Classifier,
  ClassificationResult,
  DecisionPort,
  LocalizationMetadata,
  LocalizationResult,
  PixelRect,
  SegmentationPort,
  SegmentationMetadata,
  SegmentationVerification,
  WholeObjectLocated,
  WholeObjectLocalizationResult,
} from 'zorya-classifier'

export interface VerifiedIdentity {
  readonly issuer: string
  readonly subject: string
  readonly scopes: readonly string[]
}

/** Server-derived identity. Tool arguments never provide an owner identifier. */
export type Principal =
  | { readonly ownerId: string; readonly transport: 'stdio'; readonly identity?: never }
  | { readonly ownerId: string; readonly transport: 'http'; readonly identity: VerifiedIdentity }

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }

export type ImageSource =
  | { readonly kind: 'inlineBase64'; readonly data: string; readonly mediaType?: string }
  | { readonly kind: 'localPath'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'uploadedId'; readonly id: string }
  | {
      readonly kind: 'chatgptFile'
      readonly downloadUrl: string
      readonly fileId: string
      readonly mediaType?: string
      readonly fileName?: string
    }

export interface ImagePayload {
  /** Freshly owned bytes; implementations must not return caller-owned mutable storage. */
  readonly bytes: Uint8Array
  readonly mediaType: string
  readonly width: number
  readonly height: number
}

export interface MediaLoadRequest {
  readonly source: ImageSource
  readonly principal: Principal
  readonly signal: AbortSignal
  readonly deadlineAt: number
  readonly maxBytes: number
}

export interface MediaPort {
  loadImage(request: MediaLoadRequest): Promise<ImagePayload>
}

export type ArtifactRole = 'source' | 'cutout' | 'mask'

export interface ArtifactDescriptor {
  readonly id: string
  readonly role: ArtifactRole
  readonly mediaType: string
  readonly byteLength: number
  readonly expiresAt: number
  readonly width?: number
  readonly height?: number
  readonly encoding?: string
}

export interface ArtifactPort {
  put(input: {
    readonly ownerId: string
    readonly jobId: string
    readonly role: ArtifactRole
    readonly bytes: Uint8Array
    readonly mediaType: string
    readonly expiresAt: number
    readonly width?: number
    readonly height?: number
    readonly encoding?: string
    readonly signal: AbortSignal
    readonly deadlineAt: number
  }): Promise<ArtifactDescriptor>
  read(input: {
    readonly ownerId: string
    readonly artifactId: string
    readonly signal: AbortSignal
    readonly deadlineAt: number
    readonly maxBytes: number
  }): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }>
  deleteJob(input: {
    readonly ownerId: string
    readonly jobId: string
    readonly signal: AbortSignal
    readonly deadlineAt: number
  }): Promise<void>
  deleteOwner(ownerId: string): Promise<void>
}

export type AdapterKind =
  | 'openrouter-vision'
  | 'openrouter-native'
  | 'openai-compatible-vision'
  | 'openai-compatible-text'
  | 'injected-decision'

export type CredentialMode = 'service' | 'byok' | 'none'

interface NetworkModelProfileBase {
  readonly id: string
  readonly model: string
  readonly provider?: string | undefined
  readonly providerName?: string | undefined
  readonly responseModelIds?: readonly string[] | undefined
  readonly endpoint?: string | undefined
}

export type OpenRouterProfile = NetworkModelProfileBase & {
  readonly adapter: 'openrouter-vision' | 'openrouter-native'
  readonly credentialMode: 'service' | 'byok'
  /** Required for service credentials; resolved only on the server. */
  readonly apiKeyEnv?: string
}

export type OpenAICompatibleProfile = NetworkModelProfileBase & {
  readonly adapter: 'openai-compatible-vision' | 'openai-compatible-text'
  readonly credentialMode: CredentialMode
  /** Required for service credentials; resolved only on the server. */
  readonly apiKeyEnv?: string
}

export type NetworkModelProfile = OpenRouterProfile | OpenAICompatibleProfile
export type CredentialModelProfile = NetworkModelProfile & {
  readonly credentialMode: 'service' | 'byok'
}

/** Explicit caller-owned DecisionPort route; it has no synthetic model or credential metadata. */
export interface InjectedDecisionProfile {
  readonly id: string
  readonly adapter: 'injected-decision'
  readonly credentialMode: 'none'
}

export type ModelProfile = NetworkModelProfile | InjectedDecisionProfile

export interface CredentialPort {
  resolve(input: {
    readonly profile: CredentialModelProfile
    readonly principal: Principal
    readonly signal: AbortSignal
    readonly deadlineAt: number
  }): Promise<{ readonly apiKey: string }>
}

export type JobState = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'
export type OperationName = 'classify' | 'locate' | 'extract'

export interface JobSnapshot {
  readonly id: string
  readonly state: JobState
  readonly operation: OperationName
  readonly createdAt: number
  readonly deadlineAt: number
  readonly artifacts: readonly ArtifactDescriptor[]
  readonly result?: OperationOutput
  readonly error?: SafeError
}

export interface SafeError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export type LocalizationOutput =
  | { readonly geometryKind: 'coarse-region'; readonly result: LocalizationResult }
  | { readonly geometryKind: 'whole-object'; readonly result: WholeObjectLocalizationResult }

export type ExtractionOutput =
  | {
      readonly status: 'extracted'
      readonly location: WholeObjectLocated
      readonly region: PixelRect
      readonly center: { readonly x: number; readonly y: number }
      readonly offset: { readonly x: number; readonly y: number }
      readonly segmentation: SegmentationMetadata
      readonly verification?: SegmentationVerification
      readonly artifacts: readonly ArtifactDescriptor[]
    }
  | {
      readonly status: 'not-found'
      readonly reason: string
      readonly metadata: LocalizationMetadata
      readonly artifacts: readonly ArtifactDescriptor[]
    }
  | {
      readonly status: 'unknown'
      readonly reason: string
      readonly metadata?: LocalizationMetadata
      readonly location?: WholeObjectLocated
      readonly seedLocation?: LocalizationResult
      readonly segmentation?: SegmentationMetadata
      readonly verification?: SegmentationVerification
      readonly artifacts: readonly ArtifactDescriptor[]
    }

export type OperationOutput =
  | { readonly operation: 'classify'; readonly result: ClassificationResult }
  | { readonly operation: 'locate'; readonly result: LocalizationOutput }
  | { readonly operation: 'extract'; readonly result: ExtractionOutput }

export type ResourcePayload =
  | { readonly kind: 'json'; readonly mediaType: string; readonly value: JsonValue }
  | { readonly kind: 'text'; readonly mediaType: string; readonly text: string }
  | { readonly kind: 'binary'; readonly mediaType: string; readonly bytes: Uint8Array }

export const MCP_TOOL_NAMES = [
  'zorya_classify',
  'zorya_locate',
  'zorya_extract',
  'zorya_get_job',
  'zorya_cancel_job',
  'zorya_capabilities',
] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

export interface InvokeRequest {
  readonly toolName: McpToolName
  readonly args: unknown
  readonly principal: Principal
  readonly signal: AbortSignal
}

export interface CoreApplication {
  invoke(request: InvokeRequest): Promise<JsonObject>
  readResource(input: {
    readonly uri: string
    readonly principal: Principal
    readonly signal: AbortSignal
    readonly deadlineAt: number
  }): Promise<ResourcePayload>
  shutdown(): Promise<void>
}

/** Adapter boundary for a classifier created from an explicit profile. */
export interface ClassifierLease {
  readonly classifier: Classifier
  readonly segmenter?: SegmentationPort
  /** Dispose only instances owned by this lease after physical work has settled. */
  dispose(input: { readonly signal: AbortSignal; readonly deadlineAt: number }): Promise<void>
}

export interface ClassifierFactory {
  create(
    input:
      | {
          readonly profile: CredentialModelProfile
          readonly apiKey: string
          readonly principal: Principal
          readonly signal: AbortSignal
          readonly deadlineAt: number
        }
      | {
          readonly profile: OpenAICompatibleProfile & { readonly credentialMode: 'none' }
          readonly principal: Principal
          readonly signal: AbortSignal
          readonly deadlineAt: number
        }
      | {
          readonly profile: InjectedDecisionProfile
          readonly decisionPort: DecisionPort
          readonly principal: Principal
          readonly signal: AbortSignal
          readonly deadlineAt: number
        },
  ): Promise<ClassifierLease>
}

export type ClassifyOperation = ClassifyInput
export type LocateOperation = AnyLocateInput
