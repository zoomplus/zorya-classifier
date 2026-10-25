import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { DecisionState, ImagePart } from '../../src/entities/contracts.js'
import { pixelRectSchema } from '../../src/entities/contracts.js'
import {
  acceptsResponseModel,
  unexpectedResponseProvider,
} from '../../src/infrastructure/decision-transport/route-identity.js'
import { hashCanonical } from '../v02/protocol.js'

export const JEV_NATIVE_BOX_PROFILE_ID = 'jev-native-box-dev12-v1' as const
export const JEV_NATIVE_BOX_RUN_SCHEMA = 'v03-jev-native-box-run-v1' as const
export const JEV_NATIVE_BOX_FREEZE_SCHEMA = 'v03-jev-native-box-freeze-v1' as const
export const JEV_NATIVE_BOX_EVALUATION_SCHEMA = 'v03-jev-native-box-evaluation-v1' as const

export const JEV_NATIVE_BOX_MODEL = 'typesafe/jev-1.14' as const
const JEV_NATIVE_BOX_PROVIDER = 'typesafe' as const
const JEV_NATIVE_BOX_PROVIDER_NAME = 'TypeSafe' as const
export const JEV_NATIVE_BOX_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions' as const
export const JEV_NATIVE_BOX_API_PATH = '/api/alpha/decisions' as const

export const JEV_NATIVE_BOX_CASE_DEADLINE_MS = 240_000 as const
export const JEV_NATIVE_BOX_MAX_PHYSICAL_CALLS = 12 as const
export const JEV_NATIVE_BOX_MAX_COST_USD = 0.25 as const
export const JEV_NATIVE_BOX_UNKNOWN_RESERVE_USD = 0.02 as const
export const JEV_NATIVE_BOX_MAX_REQUEST_BYTES = 24 * 1024 * 1024
export const JEV_NATIVE_BOX_MAX_RESPONSE_BYTES = 1024 * 1024
export const JEV_NATIVE_BOX_MAX_SOURCE_ENCODED_BYTES = 16 * 1024 * 1024
export const JEV_NATIVE_BOX_PREPARED_MIN_SIDE = 280 as const
export const JEV_NATIVE_BOX_PREPARED_MAX_SIDE = 1568 as const
export const JEV_NATIVE_BOX_MAX_CONSECUTIVE_TRANSPORT_ERRORS = 2 as const

const JEV_NATIVE_BOX_CAPABILITY_SOURCE_SHA256 =
  'e95ee387c4bb60e207c04553675cccf44bdacce35d75d3dfbb7de9eefa7f2705' as const
const JEV_NATIVE_BOX_CAPABILITY_MAX_INPUT_EXPOSURE_USD = 0.011010048 as const

export const JEV_NATIVE_BOX_MANIFEST_LOCKS = [
  {
    path: 'benchmarks/v03/pilot-inputs/photo.json',
    sha256: 'ee1d36d254f3aeddd9b9739143754dfbdc3409e155ab76334e10cf04e0bfb44b',
  },
  {
    path: 'benchmarks/v03/pilot-inputs/ui.json',
    sha256: '5732d534990bfa98299a4e85f760acfa5319e0193e86bc182853558786cb0e9f',
  },
  {
    path: 'benchmarks/v03/pilot-inputs/map.json',
    sha256: '6886670e7f9529805196fe8502975f78c968ff612bfa3279c323cad215ba89c4',
  },
] as const

export const JEV_NATIVE_BOX_EXPECTED_CASE_IDS = [
  'pilot-v03-photo-01',
  'pilot-v03-photo-02',
  'pilot-v03-photo-03',
  'pilot-v03-photo-04',
  'pilot-v03-ui-01',
  'pilot-v03-ui-02',
  'pilot-v03-ui-03',
  'pilot-v03-ui-04',
  'pilot-v03-map-01',
  'pilot-v03-map-02',
  'pilot-v03-map-03',
  'pilot-v03-map-04',
] as const

export const JEV_NATIVE_BOX_GENERIC_NOUL_INSTRUCTION =
  'Does the image contain a visible instance matching the authored target described in state?' as const
export const JEV_NATIVE_BOX_GENERIC_BOX_INSTRUCTION =
  'Return the axis-aligned whole-object bounding box for the visible instance matching the authored target on the image.' as const

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)

const imageRefSchema = z
  .object({
    path: z.string().min(1),
    sha256: digestSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()

const locateSchema = z
  .object({
    target: z.string().min(1).max(2000),
    instruction: z.string().min(1).max(2000).optional(),
  })
  .strict()

const classifySchema = z
  .object({
    question: z.string().min(1).max(2000).optional(),
    options: z.array(z.string()).optional(),
  })
  .strict()

export const jevNativeBoxProducerRowSchema = z
  .object({
    caseId: z.string().min(1),
    image: imageRefSchema,
    locate: locateSchema,
    classify: classifySchema,
  })
  .strict()

export type JevNativeBoxProducerRow = z.infer<typeof jevNativeBoxProducerRowSchema>

const jevNativeBoxProducerInputsSchema = z.array(jevNativeBoxProducerRowSchema).length(12)

export const JEV_NATIVE_BOX_PRODUCER_INPUTS_SHA256 = hashManifestLocks(
  JEV_NATIVE_BOX_MANIFEST_LOCKS,
)

export function assertProducerInputOrder(rows: readonly JevNativeBoxProducerRow[]): void {
  jevNativeBoxProducerInputsSchema.parse(rows)
  for (let index = 0; index < JEV_NATIVE_BOX_EXPECTED_CASE_IDS.length; index += 1) {
    if (rows[index]?.caseId !== JEV_NATIVE_BOX_EXPECTED_CASE_IDS[index])
      throw new Error('producer-case-order-mismatch')
  }
}

interface SourcePixelBox {
  left: number
  top: number
  width: number
  height: number
}

const sourceImageTransformSchema = z
  .object({
    sourceImageTransform: z.object({
      source: z.object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
      output: z.object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
      content: pixelRectSchema,
      scaleX: z.number().finite().positive(),
      scaleY: z.number().finite().positive(),
    }),
  })
  .strict()

export type SourceImageTransformMetadata = z.infer<
  typeof sourceImageTransformSchema
>['sourceImageTransform']

const normalizedProviderBoxSchema = z
  .object({
    left: z.number().finite(),
    top: z.number().finite(),
    right: z.number().finite(),
    bottom: z.number().finite(),
  })
  .strict()

const jevNativeBoxUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    cost: z.number().finite().nonnegative().nullable().optional(),
  })
  .strict()

export type NormalizedProviderBox = z.infer<typeof normalizedProviderBoxSchema>

const jevNativeBoxWireQuestionsSchema = z
  .object({
    presence: z.object({ type: z.literal('noul'), instructions: z.string().min(1) }).strict(),
    object: z.object({ type: z.literal('box'), instructions: z.string().min(1) }).strict(),
  })
  .strict()

const imagePartSchema = z
  .object({
    type: z.literal('image_url'),
    image_url: z
      .object({
        url: z.string().min(1),
        detail: z.literal('high'),
      })
      .strict(),
  })
  .strict()

export const jevNativeBoxWireBodySchema = z
  .object({
    model: z.literal(JEV_NATIVE_BOX_MODEL),
    provider: z
      .object({
        only: z.tuple([z.literal(JEV_NATIVE_BOX_PROVIDER)]),
        allow_fallbacks: z.literal(false),
      })
      .strict(),
    state: z.tuple([imagePartSchema, z.string().min(1)]),
    questions: jevNativeBoxWireQuestionsSchema,
  })
  .strict()

const jevNativeBoxResponseSchema = z
  .object({
    id: z.string().min(1).max(512).nullable().optional(),
    model: z.string().min(1).max(128).nullable().optional(),
    provider: z.string().min(1).max(128).nullable().optional(),
    usage: jevNativeBoxUsageSchema.nullable().optional(),
    answers: z
      .object({
        presence: z
          .object({
            type: z.literal('noul'),
            noul: z.number().min(0).max(1),
            confidence: z.number().min(0).max(1).nullable().optional(),
          })
          .strict(),
        object: z
          .object({
            type: z.literal('box'),
            box: normalizedProviderBoxSchema,
            confidence: z.number().min(0).max(1).nullable().optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()

type JevNativeBoxParsedResponse = z.infer<typeof jevNativeBoxResponseSchema>

export const jevNativeBoxCapabilityReceiptSchema = z
  .object({
    capturedAt: z.string().min(1),
    source: z.string().url(),
    model: z.literal(JEV_NATIVE_BOX_MODEL),
    provider: z.literal(JEV_NATIVE_BOX_PROVIDER),
    providerName: z.literal(JEV_NATIVE_BOX_PROVIDER_NAME),
    contextLength: z.literal(262144),
    pricing: z
      .object({
        prompt: z.literal('0.000000042'),
        completion: z.literal('0'),
        discount: z.literal(0),
      })
      .strict(),
    architecture: z
      .object({
        tokenizer: z.literal('Other'),
        instruct_type: z.null(),
        modality: z.literal('text+image->decisions'),
        input_modalities: z.tuple([z.literal('text'), z.literal('image')]),
        output_modalities: z.tuple([z.literal('decisions')]),
      })
      .strict(),
    sha256: z.literal(JEV_NATIVE_BOX_CAPABILITY_SOURCE_SHA256),
    maximumInputExposureUsd: z.literal(JEV_NATIVE_BOX_CAPABILITY_MAX_INPUT_EXPOSURE_USD),
    reservePerCallUsd: z.literal(JEV_NATIVE_BOX_UNKNOWN_RESERVE_USD),
  })
  .strict()

function hashManifestLocks(locks: readonly { path: string; sha256: string }[]): string {
  const hash = createHash('sha256')
  for (const item of locks) {
    hash.update(item.path)
    hash.update('\0')
    hash.update(item.sha256)
  }
  return hash.digest('hex')
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function computeJevNativeBoxFreezeSha256(
  freeze: Record<string, unknown> & { freezeSha256?: never },
): string {
  return hashCanonical(freeze)
}

export function authoredTargetStateLine(target: string): string {
  return `Authored target: ${JSON.stringify(target)}. Authored exclusions: ${JSON.stringify([])}.`
}

export function buildJevNativeBoxWireBody(
  target: string,
  preparedImagePart: ImagePart,
): z.infer<typeof jevNativeBoxWireBodySchema> {
  const targetLine = authoredTargetStateLine(target)
  const body = {
    state: [preparedImagePart, targetLine],
    questions: {
      presence: { type: 'noul' as const, instructions: JEV_NATIVE_BOX_GENERIC_NOUL_INSTRUCTION },
      object: { type: 'box' as const, instructions: JEV_NATIVE_BOX_GENERIC_BOX_INSTRUCTION },
    },
    model: JEV_NATIVE_BOX_MODEL,
    provider: { only: [JEV_NATIVE_BOX_PROVIDER] as const, allow_fallbacks: false as const },
  }
  return jevNativeBoxWireBodySchema.parse(body)
}

export function parseSourceImageTransformFromImageState(
  imageState: DecisionState,
): SourceImageTransformMetadata {
  const transformPart = imageState.find((part): part is string => typeof part === 'string')
  if (!transformPart) throw new Error('missing-transform')
  let json: unknown
  try {
    json = JSON.parse(transformPart)
  } catch {
    throw new Error('invalid-transform-json')
  }
  return sourceImageTransformSchema.parse(json).sourceImageTransform
}

export function extractPreparedImagePart(imageState: DecisionState): ImagePart {
  const imagePart = imageState.find(
    (part): part is ImagePart => typeof part !== 'string' && part.type === 'image_url',
  )
  if (!imagePart) throw new Error('missing-prepared-image')
  return imagePart
}

export function mapNoulScoreToPresence(noul: number): 'present' | 'absent' | 'uncertain' {
  if (!Number.isFinite(noul)) throw new Error('invalid-noul')
  if (noul > 0.5) return 'present'
  if (noul < 0.5) return 'absent'
  return 'uncertain'
}

export function validateNormalizedProviderBox(box: NormalizedProviderBox): void {
  const { left, top, right, bottom } = box
  if (![left, top, right, bottom].every(Number.isFinite)) throw new Error('box-nonfinite')
  if (
    left < 0 ||
    top < 0 ||
    right < 0 ||
    bottom < 0 ||
    left > 1 ||
    top > 1 ||
    right > 1 ||
    bottom > 1
  )
    throw new Error('box-out-of-unit-range')
  if (!(left < right) || !(top < bottom)) throw new Error('box-unordered')
  if (right - left <= 0 || bottom - top <= 0) throw new Error('box-zero-area')
}

export function convertNormalizedBoxToSourceBox(
  box: NormalizedProviderBox,
  transform: SourceImageTransformMetadata,
): SourcePixelBox {
  validateNormalizedProviderBox(box)
  const { output, content, scaleX, scaleY, source } = transform
  const canvasLeft = box.left * output.width
  const canvasTop = box.top * output.height
  const canvasRight = box.right * output.width
  const canvasBottom = box.bottom * output.height
  const contentRight = content.left + content.width
  const contentBottom = content.top + content.height
  if (
    canvasLeft < content.left ||
    canvasTop < content.top ||
    canvasRight > contentRight ||
    canvasBottom > contentBottom
  )
    throw new Error('box-padding-only')
  const sourceLeft = (canvasLeft - content.left) / scaleX
  const sourceTop = (canvasTop - content.top) / scaleY
  const sourceRight = (canvasRight - content.left) / scaleX
  const sourceBottom = (canvasBottom - content.top) / scaleY
  if (sourceLeft < 0 || sourceTop < 0 || sourceRight > source.width || sourceBottom > source.height)
    throw new Error('box-out-of-source')
  const width = sourceRight - sourceLeft
  const height = sourceBottom - sourceTop
  if (!(width > 0) || !(height > 0)) throw new Error('box-zero-area-source')
  return { left: sourceLeft, top: sourceTop, width, height }
}

export function overlayRoundedBox(box: SourcePixelBox): SourcePixelBox {
  return {
    left: Math.round(box.left),
    top: Math.round(box.top),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
}

export function validateJevNativeBoxResponseMetadata(response: JevNativeBoxParsedResponse): {
  model: string
  provider: string
} {
  const model = response.model
  if (model == null || model.length === 0) throw new Error('missing-response-model')
  if (
    !acceptsResponseModel(model, {
      model: JEV_NATIVE_BOX_MODEL,
      responseModelIds: [],
    })
  )
    throw new Error('unexpected-response-model')
  const provider = response.provider
  if (provider == null || provider.length === 0) throw new Error('missing-response-provider')
  if (
    unexpectedResponseProvider(provider, {
      provider: JEV_NATIVE_BOX_PROVIDER,
      providerName: JEV_NATIVE_BOX_PROVIDER_NAME,
    })
  )
    throw new Error('unexpected-response-provider')
  validateNormalizedProviderBox(response.answers.object.box)
  return { model, provider }
}

const jevNativeBoxResponseEnvelopeSchema = z
  .object({
    model: z.string().min(1).max(128).nullable().optional(),
    provider: z.string().min(1).max(128).nullable().optional(),
    usage: jevNativeBoxUsageSchema.nullable().optional(),
  })
  .passthrough()

export function parseJevNativeBoxResponseEnvelope(raw: string): {
  usageCost: number | null
  model: string | null
  provider: string | null
} {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error('invalid-response-json')
  }
  const envelope = jevNativeBoxResponseEnvelopeSchema.parse(json)
  const usageCost = envelope.usage?.cost ?? null
  return {
    usageCost: usageCost !== null && Number.isFinite(usageCost) ? usageCost : null,
    model: envelope.model ?? null,
    provider: envelope.provider ?? null,
  }
}

export function parseJevNativeBoxResponse(raw: string): JevNativeBoxParsedResponse {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error('invalid-response-json')
  }
  return jevNativeBoxResponseSchema.parse(json)
}

const capabilityEndpointSchema = z
  .object({
    name: z.string().min(1),
    model_id: z.literal(JEV_NATIVE_BOX_MODEL),
    model_name: z.literal('TypeSafe: Jev 1.14'),
    context_length: z.literal(262144),
    pricing: z
      .object({
        prompt: z.literal('0.000000042'),
        completion: z.literal('0'),
        discount: z.literal(0),
      })
      .strict(),
    provider_name: z.literal(JEV_NATIVE_BOX_PROVIDER_NAME),
    tag: z.literal(JEV_NATIVE_BOX_PROVIDER),
  })
  .passthrough()

const capabilitySourceSchema = z
  .object({
    data: z
      .object({
        id: z.literal(JEV_NATIVE_BOX_MODEL),
        name: z.literal('TypeSafe: Jev 1.14'),
        created: z.number().int().positive(),
        description: z.string().min(1),
        architecture: jevNativeBoxCapabilityReceiptSchema.shape.architecture,
        endpoints: z.array(capabilityEndpointSchema).min(1),
      })
      .passthrough(),
  })
  .passthrough()

export async function validateCapabilityArtifacts(input: {
  receiptPath: string
  sourcePath: string
  readFile: (path: string) => Promise<Uint8Array>
}): Promise<z.infer<typeof jevNativeBoxCapabilityReceiptSchema>> {
  const sourceBytes = await input.readFile(input.sourcePath)
  if (sha256Bytes(sourceBytes) !== JEV_NATIVE_BOX_CAPABILITY_SOURCE_SHA256)
    throw new Error('capability-source-hash-mismatch')
  capabilitySourceSchema.parse(JSON.parse(new TextDecoder().decode(sourceBytes)))
  const receiptBytes = await input.readFile(input.receiptPath)
  const receipt = jevNativeBoxCapabilityReceiptSchema.parse(
    JSON.parse(new TextDecoder().decode(receiptBytes)),
  )
  if (receipt.sha256 !== JEV_NATIVE_BOX_CAPABILITY_SOURCE_SHA256)
    throw new Error('capability-receipt-source-mismatch')
  return receipt
}

const jevNativeBoxFreezeRowSchema = z
  .object({
    caseId: z.string().min(1),
    target: z.string().min(1),
    imagePath: z.string().min(1),
    sourceSha256: digestSchema,
    sourceWidth: z.number().int().positive(),
    sourceHeight: z.number().int().positive(),
    preparedImageSha256: digestSchema,
    preparedWidth: z.number().int().positive(),
    preparedHeight: z.number().int().positive(),
    sourceImageTransform: sourceImageTransformSchema.shape.sourceImageTransform,
    requestBodySha256: digestSchema,
    requestBodyBytes: z.number().int().positive(),
    requestPayloadRelativePath: z.string().min(1),
    authoredTargetLine: z.string().min(1),
    presenceInstructions: z.literal(JEV_NATIVE_BOX_GENERIC_NOUL_INSTRUCTION),
    objectInstructions: z.literal(JEV_NATIVE_BOX_GENERIC_BOX_INSTRUCTION),
  })
  .strict()

export const jevNativeBoxFreezeSchema = z
  .object({
    schema: z.literal(JEV_NATIVE_BOX_FREEZE_SCHEMA),
    status: z.literal('frozen-before-dispatch'),
    profileId: z.literal(JEV_NATIVE_BOX_PROFILE_ID),
    freezeSha256: digestSchema,
    producerInputsSha256: z.literal(JEV_NATIVE_BOX_PRODUCER_INPUTS_SHA256),
    producerCodeSha256: digestSchema,
    sourceClosureSha256: digestSchema,
    sourceClosure: z.array(
      z
        .object({
          path: z.string().min(1),
          sha256: digestSchema,
          bytes: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    capabilitySourceSha256: z.literal(JEV_NATIVE_BOX_CAPABILITY_SOURCE_SHA256),
    capabilityReceipt: jevNativeBoxCapabilityReceiptSchema,
    h8aRunSha256: digestSchema,
    h8aEvaluationSha256: digestSchema,
    route: z
      .object({
        model: z.literal(JEV_NATIVE_BOX_MODEL),
        provider: z.literal(JEV_NATIVE_BOX_PROVIDER),
        providerName: z.literal(JEV_NATIVE_BOX_PROVIDER_NAME),
        apiEndpoint: z.literal(JEV_NATIVE_BOX_API_PATH),
        allowFallbacks: z.literal(false),
        dangerZoneImagesHeader: z.literal(true),
      })
      .strict(),
    budget: z
      .object({
        maxPhysicalCalls: z.literal(JEV_NATIVE_BOX_MAX_PHYSICAL_CALLS),
        maxCostUsd: z.literal(JEV_NATIVE_BOX_MAX_COST_USD),
        unknownReserveUsdPerCall: z.literal(JEV_NATIVE_BOX_UNKNOWN_RESERVE_USD),
      })
      .strict(),
    limits: z
      .object({
        caseDeadlineMs: z.literal(JEV_NATIVE_BOX_CASE_DEADLINE_MS),
        maxRequestBytes: z.literal(JEV_NATIVE_BOX_MAX_REQUEST_BYTES),
        maxResponseBytes: z.literal(JEV_NATIVE_BOX_MAX_RESPONSE_BYTES),
        maxSourceEncodedBytes: z.literal(JEV_NATIVE_BOX_MAX_SOURCE_ENCODED_BYTES),
        preparedMinSide: z.literal(JEV_NATIVE_BOX_PREPARED_MIN_SIDE),
        preparedMaxSide: z.literal(JEV_NATIVE_BOX_PREPARED_MAX_SIDE),
      })
      .strict(),
    manifestLocks: z.array(z.object({ path: z.string().min(1), sha256: digestSchema }).strict()),
    rows: z.array(jevNativeBoxFreezeRowSchema).length(12),
  })
  .strict()

export type JevNativeBoxFreeze = z.infer<typeof jevNativeBoxFreezeSchema>
