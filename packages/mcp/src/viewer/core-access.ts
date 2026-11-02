import { z } from 'zod'
import type { ArtifactDescriptor, CoreApplication, JsonValue } from '../contracts.js'
import type { ViewerArtifactReader, ViewerDocument, ViewerDocumentReader } from './document.js'

const artifactDescriptorSchema = z.object({
  id: z.string().min(1).max(256),
  role: z.enum(['source', 'cutout', 'mask']),
  mediaType: z.string().min(1).max(128),
  byteLength: z.number().int().nonnegative(),
  expiresAt: z.number().finite(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  encoding: z.string().max(64).optional(),
})

const jobSnapshotSchema = z.object({
  id: z.string().min(1).max(256),
  operation: z.enum(['classify', 'locate', 'extract']),
  artifacts: z.array(artifactDescriptorSchema).max(32),
  result: z.unknown().optional(),
})

function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 24) return '[nested value omitted]'
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.slice(0, 2_000).map((entry) => jsonValue(entry, depth + 1))
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .slice(0, 2_000)
      .map(([key, entry]) => [key, jsonValue(entry, depth + 1)] as const)
    return Object.fromEntries(entries)
  }
  return null
}

function object(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== undefined && typeof value === 'object' && value !== null && !Array.isArray(value)
}

function field(value: JsonValue | undefined, name: string): JsonValue | undefined {
  return object(value) ? value[name] : undefined
}

function finiteNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function outputBox(result: JsonValue | undefined): {
  readonly geometryKind?: 'coarse-region' | 'whole-object'
  readonly box?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
} {
  const operation = field(result, 'operation')
  const opName = typeof operation === 'string' ? operation : undefined
  let geometryKind: 'coarse-region' | 'whole-object' | undefined
  let region: JsonValue | undefined
  if (opName === 'locate') {
    const localization = field(result, 'result')
    const candidateKind = field(localization, 'geometryKind')
    if (candidateKind === 'coarse-region' || candidateKind === 'whole-object')
      geometryKind = candidateKind
    region = field(field(localization, 'result'), 'region')
  } else if (opName === 'extract') {
    const extraction = field(result, 'result')
    if (field(extraction, 'status') === 'extracted') {
      geometryKind = 'whole-object'
      region = field(extraction, 'region')
    }
  }
  const left = finiteNumber(field(region, 'left'))
  const top = finiteNumber(field(region, 'top'))
  const width = finiteNumber(field(region, 'width'))
  const height = finiteNumber(field(region, 'height'))
  const box =
    left === undefined || top === undefined || width === undefined || height === undefined
      ? undefined
      : { x: left, y: top, width, height }
  return {
    ...(geometryKind === undefined ? {} : { geometryKind }),
    ...(box === undefined ? {} : { box }),
  }
}

function outputMaskRegion(
  result: JsonValue | undefined,
):
  | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  | undefined {
  if (field(result, 'operation') !== 'extract') return undefined
  const extraction = field(result, 'result')
  if (field(extraction, 'status') !== 'extracted') return undefined
  const region = field(extraction, 'region')
  const left = finiteNumber(field(region, 'left'))
  const top = finiteNumber(field(region, 'top'))
  const width = finiteNumber(field(region, 'width'))
  const height = finiteNumber(field(region, 'height'))
  if (
    left === undefined ||
    top === undefined ||
    width === undefined ||
    height === undefined ||
    ![left, top, width, height].every(Number.isSafeInteger)
  )
    return undefined
  return { x: left, y: top, width, height }
}

function descriptor(value: z.output<typeof artifactDescriptorSchema>): ArtifactDescriptor {
  return {
    id: value.id,
    role: value.role,
    mediaType: value.mediaType,
    byteLength: value.byteLength,
    expiresAt: value.expiresAt,
    ...(value.width === undefined ? {} : { width: value.width }),
    ...(value.height === undefined ? {} : { height: value.height }),
    ...(value.encoding === undefined ? {} : { encoding: value.encoding }),
  }
}

export function createCoreViewerAccess(application: CoreApplication): {
  readonly readDocument: ViewerDocumentReader
  readonly readArtifact: ViewerArtifactReader
} {
  return {
    async readDocument(input) {
      const payload = await application.readResource({
        uri: `zorya://jobs/${encodeURIComponent(input.jobId)}`,
        principal: input.principal,
        signal: input.signal,
        deadlineAt: input.deadlineAt,
      })
      if (payload.kind !== 'json') return undefined
      const parsed = jobSnapshotSchema.safeParse(payload.value)
      if (!parsed.success || parsed.data.id !== input.jobId) return undefined
      const sourceValue = parsed.data.artifacts.find((artifact) => artifact.role === 'source')
      if (!sourceValue || sourceValue.width === undefined || sourceValue.height === undefined)
        return undefined
      const source = descriptor(sourceValue)
      const cutoutValue = parsed.data.artifacts.find((artifact) => artifact.role === 'cutout')
      const cutout = cutoutValue === undefined ? undefined : descriptor(cutoutValue)
      const maskValue = parsed.data.artifacts.find((artifact) => artifact.role === 'mask')
      const mask = maskValue === undefined ? undefined : descriptor(maskValue)
      const result = jsonValue(parsed.data.result)
      const maskRegion = outputMaskRegion(result)
      const alignedMask =
        mask !== undefined &&
        maskRegion !== undefined &&
        mask.encoding === 'binary-lsb0' &&
        mask.width === maskRegion.width &&
        mask.height === maskRegion.height
          ? mask
          : undefined
      return {
        ownerId: input.principal.ownerId,
        jobId: parsed.data.id,
        title: `Zorya ${parsed.data.operation} job ${parsed.data.id}`,
        source,
        ...(cutout === undefined ? {} : { cutout }),
        ...(alignedMask === undefined || maskRegion === undefined
          ? {}
          : { mask: alignedMask, maskRegion }),
        ...outputBox(result),
        result,
      } satisfies ViewerDocument
    },
    async readArtifact(input) {
      const payload = await application.readResource({
        uri: `zorya://artifacts/${encodeURIComponent(input.artifactId)}`,
        principal: input.principal,
        signal: input.signal,
        deadlineAt: input.deadlineAt,
      })
      return payload.kind === 'binary'
        ? { bytes: Uint8Array.from(payload.bytes), mediaType: payload.mediaType }
        : undefined
    },
  }
}
