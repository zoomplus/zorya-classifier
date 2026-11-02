import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { PhaseFreeze, EvaluatorPrivateAnnotationBundle } from './schemas.js'
import { hashIdentity } from './hash-identity.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const refSchema = z
  .object({ path: z.string().min(1), sha256: digest, bytes: z.number().int().positive() })
  .strict()
const boxSchema = z
  .object({
    left: z.number().finite(),
    top: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict()
const proofSchema = z
  .object({
    schema: z.literal('h8a-native-selector-source-oracle-proof-v1'),
    caseId: z.string().min(1),
    sourceSha256: digest,
    sourceCanvasWidth: z.number().int().positive(),
    sourceCanvasHeight: z.number().int().positive(),
    targetTextSha256: digest,
    stratum: z.enum(['photo', 'ui', 'map']),
    sourceGroup: z.string().min(1),
    expectedPresence: z.enum(['present', 'absent']),
    referenceBoxesSha256: digest.nullable(),
    scope: z.enum(['full-app-window', 'visible-map-viewport']),
    oracleKind: z.enum(['atspi-component', 'source-state-renderer']),
    modelAssisted: z.literal(false),
    ocrAssisted: z.literal(false),
    segmentationModelAssisted: z.literal(false),
    rawSourceState: refSchema,
    oracleCode: refSchema,
    completeVisibleInventory: refSchema
      .extend({
        complete: z.literal(true),
        sameState: z.literal(true),
        matchingVisibleObjectIds: z.array(z.string().min(1)),
        queriedScopeSha256: digest,
        transformSha256: digest,
      })
      .strict(),
    transformEvidence: refSchema,
    geometry: z
      .object({
        sourceObjectId: z.string().min(1),
        boxes: z.array(boxSchema).min(1),
        extentsEvidence: refSchema,
        fullyVisible: z.literal(true),
        clipped: z.literal(false),
        inferredHiddenGeometry: z.literal(false),
      })
      .strict()
      .nullable(),
    scopeEvidence: refSchema,
  })
  .strict()

const normalizedIdentitySchema = z
  .object({
    caseId: z.string().min(1),
    sourceSha256: digest,
    sourceCanvasWidth: z.number().int().positive(),
    sourceCanvasHeight: z.number().int().positive(),
    rawSourceStateSha256: digest,
    targetTextSha256: digest,
    stratum: z.enum(['ui', 'map']),
    sourceGroup: z.string().min(1),
    scope: z.enum(['full-app-window', 'visible-map-viewport']),
  })
  .strict()
const scopeEvidenceSchema = normalizedIdentitySchema
  .extend({
    schema: z.literal('h8a-native-selector-source-oracle-scope-v1'),
    sourceRect: boxSchema,
  })
  .strict()
const transformEvidenceSchema = normalizedIdentitySchema
  .extend({
    schema: z.literal('h8a-native-selector-source-oracle-transform-v1'),
    scopeEvidenceSha256: digest,
    matrix: z
      .object({
        a: z.number().finite(),
        b: z.number().finite(),
        c: z.number().finite(),
        d: z.number().finite(),
        e: z.number().finite(),
        f: z.number().finite(),
      })
      .strict(),
  })
  .strict()
const inventoryEvidenceSchema = normalizedIdentitySchema
  .extend({
    schema: z.literal('h8a-native-selector-source-oracle-visible-inventory-v1'),
    scopeEvidenceSha256: digest,
    transformEvidenceSha256: digest,
    complete: z.literal(true),
    sameState: z.literal(true),
    objects: z.array(
      z
        .object({
          objectId: z.string().min(1),
          targetTextSha256: digest,
          sourceGroup: z.string().min(1),
          captureExtents: z.array(boxSchema).min(1),
          fullyVisible: z.boolean(),
          clipped: z.boolean(),
          inferredHiddenGeometry: z.literal(false),
        })
        .strict(),
    ),
  })
  .strict()
const extentEvidenceSchema = normalizedIdentitySchema
  .extend({
    schema: z.literal('h8a-native-selector-source-oracle-extents-v1'),
    scopeEvidenceSha256: digest,
    transformEvidenceSha256: digest,
    sourceObjectId: z.string().min(1),
    captureExtents: z.array(boxSchema).min(1),
    fullyVisible: z.literal(true),
    clipped: z.literal(false),
    inferredHiddenGeometry: z.literal(false),
  })
  .strict()

type NativeSelectorSourceOracleReference = z.infer<typeof refSchema>
export interface SourceOracleProvenanceRow {
  caseId: string
  sourceSha256: string
  provenanceSha256: string
  annotationMethod: 'independent-source-oracle-v1'
  packedMaskSha256: null
  sourceOracleProof: NativeSelectorSourceOracleReference
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** Validates private, bounded source-oracle evidence before any runtime or provider setup. */
export async function validateNativeSelectorSourceOracleProvenance(input: {
  freeze: PhaseFreeze
  annotations: EvaluatorPrivateAnnotationBundle
  sourceRows: readonly { caseId: string; sha256: string; sourceGroup: string }[]
  provenanceRows: readonly {
    caseId: string
    sourceSha256: string
    provenanceSha256: string
    annotationMethod: string
    packedMaskSha256: string | null
    sourceOracleProof?: NativeSelectorSourceOracleReference
  }[]
  artifactRoot: string
  readPinned: (path: string, sha256: string, maximumBytes: number) => Promise<Uint8Array>
}): Promise<void> {
  const root = resolve(input.artifactRoot)
  if (root !== input.artifactRoot)
    throw new RangeError('Source-oracle artifact root must be canonical')
  const producerById = new Map(input.freeze.producerCases.map((row) => [row.opaqueCaseId, row]))
  const annotationById = new Map(input.annotations.cases.map((row) => [row.opaqueCaseId, row]))
  const sourceById = new Map(input.sourceRows.map((row) => [row.caseId, row]))
  if (
    producerById.size !== input.freeze.producerCases.length ||
    annotationById.size !== input.annotations.cases.length ||
    sourceById.size !== input.sourceRows.length
  )
    throw new RangeError('Source-oracle case identities must be unique')
  for (const provenance of input.provenanceRows) {
    if (provenance.annotationMethod !== 'independent-source-oracle-v1') continue
    const proofRef = provenance.sourceOracleProof
    if (!proofRef || provenance.packedMaskSha256 !== null)
      throw new RangeError('Source-oracle annotation requires a pinned proof and no mask reference')
    const proofPath = resolve(proofRef.path)
    if (!isAbsolute(proofRef.path) || proofPath !== proofRef.path || !inside(root, proofPath))
      throw new RangeError('Source-oracle proof pin escapes the trusted artifact namespace')
    const source = sourceById.get(provenance.caseId)
    const producer = producerById.get(provenance.caseId)
    const annotation = annotationById.get(provenance.caseId)
    if (!source || !producer || !annotation || annotation.stratum === 'photo')
      throw new RangeError('Source-oracle provenance is restricted to frozen UI and map cases')
    const proof = proofSchema.parse(
      JSON.parse(
        Buffer.from(
          await input.readPinned(proofRef.path, proofRef.sha256, 2 * 1024 * 1024),
        ).toString('utf8'),
      ) as unknown,
    )
    const expectedScope = annotation.stratum === 'ui' ? 'full-app-window' : 'visible-map-viewport'
    const expectedOracle = annotation.stratum === 'ui' ? 'atspi-component' : 'source-state-renderer'
    const expectedBoxesSha256 = annotation.referenceBoxes.length
      ? hashIdentity(annotation.referenceBoxes)
      : null
    if (
      proof.caseId !== provenance.caseId ||
      proof.sourceSha256 !== source.sha256 ||
      provenance.sourceSha256 !== source.sha256 ||
      provenance.provenanceSha256 !== proofRef.sha256 ||
      proof.sourceCanvasWidth !== producer.sourceCanvasWidth ||
      proof.sourceCanvasHeight !== producer.sourceCanvasHeight ||
      proof.targetTextSha256 !== digestText(producer.targetTaskText) ||
      proof.stratum !== annotation.stratum ||
      proof.sourceGroup !== annotation.sourceGroup ||
      source.sourceGroup !== annotation.sourceGroup ||
      proof.expectedPresence !== annotation.expectedPresence ||
      proof.referenceBoxesSha256 !== expectedBoxesSha256 ||
      proof.scope !== expectedScope ||
      proof.oracleKind !== expectedOracle ||
      proof.completeVisibleInventory.queriedScopeSha256 !== proof.scopeEvidence.sha256 ||
      proof.completeVisibleInventory.transformSha256 !== proof.transformEvidence.sha256
    )
      throw new RangeError(
        'Source-oracle proof does not bind the frozen case and private annotation',
      )
    const refs = [
      proofRef,
      proof.rawSourceState,
      proof.oracleCode,
      proof.completeVisibleInventory,
      proof.transformEvidence,
      proof.scopeEvidence,
      ...(proof.geometry ? [proof.geometry.extentsEvidence] : []),
    ]
    const seen = new Set<string>()
    const contentsByPath = new Map<string, Uint8Array>()
    for (const ref of refs) {
      const path = resolve(ref.path)
      if (!isAbsolute(ref.path) || path !== ref.path || !inside(root, path) || seen.has(path))
        throw new RangeError('Source-oracle proof contains a duplicate or escaping evidence pin')
      seen.add(path)
      const bytes = await input.readPinned(path, ref.sha256, 2 * 1024 * 1024)
      if (bytes.byteLength !== ref.bytes)
        throw new RangeError('Source-oracle evidence byte length differs from its pin')
      contentsByPath.set(path, Uint8Array.from(bytes))
    }
    const readNormalized = <T>(ref: NativeSelectorSourceOracleReference, schema: z.ZodType<T>): T =>
      schema.parse(
        JSON.parse(Buffer.from(contentsByPath.get(ref.path)!).toString('utf8')) as unknown,
      )
    const identity = {
      caseId: proof.caseId,
      sourceSha256: proof.sourceSha256,
      sourceCanvasWidth: proof.sourceCanvasWidth,
      sourceCanvasHeight: proof.sourceCanvasHeight,
      rawSourceStateSha256: proof.rawSourceState.sha256,
      targetTextSha256: proof.targetTextSha256,
      stratum: proof.stratum,
      sourceGroup: proof.sourceGroup,
      scope: proof.scope,
    }
    const scopeEvidence = readNormalized(proof.scopeEvidence, scopeEvidenceSchema)
    const transformEvidence = readNormalized(proof.transformEvidence, transformEvidenceSchema)
    const inventory = readNormalized(proof.completeVisibleInventory, inventoryEvidenceSchema)
    const commonIdentityMatches = (value: z.infer<typeof normalizedIdentitySchema>): boolean =>
      value.caseId === identity.caseId &&
      value.sourceSha256 === identity.sourceSha256 &&
      value.sourceCanvasWidth === identity.sourceCanvasWidth &&
      value.sourceCanvasHeight === identity.sourceCanvasHeight &&
      value.rawSourceStateSha256 === identity.rawSourceStateSha256 &&
      value.targetTextSha256 === identity.targetTextSha256 &&
      value.stratum === identity.stratum &&
      value.sourceGroup === identity.sourceGroup &&
      value.scope === identity.scope
    const scopeRect = scopeEvidence.sourceRect
    const scopeFitsCanvas = boxInside(scopeRect, proof.sourceCanvasWidth, proof.sourceCanvasHeight)
    const fullUiScope =
      scopeRect.left === 0 &&
      scopeRect.top === 0 &&
      scopeRect.width === proof.sourceCanvasWidth &&
      scopeRect.height === proof.sourceCanvasHeight
    const matrix = transformEvidence.matrix
    const determinant = matrix.a * matrix.d - matrix.b * matrix.c
    if (
      !commonIdentityMatches(scopeEvidence) ||
      !commonIdentityMatches(transformEvidence) ||
      !commonIdentityMatches(inventory) ||
      !scopeFitsCanvas ||
      (proof.stratum === 'ui' && !fullUiScope) ||
      transformEvidence.scopeEvidenceSha256 !== proof.scopeEvidence.sha256 ||
      inventory.scopeEvidenceSha256 !== proof.scopeEvidence.sha256 ||
      inventory.transformEvidenceSha256 !== proof.transformEvidence.sha256 ||
      !Number.isFinite(determinant) ||
      Math.abs(determinant) < 1e-12
    )
      throw new RangeError('Source-oracle scope or transform evidence has invalid bindings')
    const seenObjectIds = new Set<string>()
    for (const object of inventory.objects) {
      if (
        seenObjectIds.has(object.objectId) ||
        object.sourceGroup !== identity.sourceGroup ||
        object.captureExtents.some((extent) => {
          const sourceExtent = transformRect(extent, matrix)
          return (
            !boxInside(sourceExtent, proof.sourceCanvasWidth, proof.sourceCanvasHeight) ||
            !boxInsideBox(sourceExtent, scopeRect)
          )
        })
      )
        throw new RangeError('Source-oracle inventory has duplicate or out-of-scope geometry')
      seenObjectIds.add(object.objectId)
    }
    const matchingObjectIds = inventory.objects
      .filter((object) => object.targetTextSha256 === identity.targetTextSha256)
      .map((object) => object.objectId)
    if (
      inventory.complete !== proof.completeVisibleInventory.complete ||
      inventory.sameState !== proof.completeVisibleInventory.sameState ||
      !sameStrings(matchingObjectIds, proof.completeVisibleInventory.matchingVisibleObjectIds)
    )
      throw new RangeError(
        'Source-oracle inventory summary differs from its complete pinned contents',
      )
    if (proof.expectedPresence === 'absent') {
      if (proof.geometry !== null || matchingObjectIds.length !== 0)
        throw new RangeError('Negative source-oracle evidence has a matching visible target')
      continue
    }
    if (!proof.geometry || !matchingObjectIds.includes(proof.geometry.sourceObjectId))
      throw new RangeError('Positive source-oracle evidence must identify a visible target')
    const extents = readNormalized(proof.geometry.extentsEvidence, extentEvidenceSchema)
    const matchingObject = inventory.objects.find(
      (object) => object.objectId === proof.geometry!.sourceObjectId,
    )
    if (
      !matchingObject ||
      matchingObject.targetTextSha256 !== identity.targetTextSha256 ||
      !matchingObject.fullyVisible ||
      matchingObject.clipped ||
      extents.sourceObjectId !== proof.geometry.sourceObjectId ||
      !commonIdentityMatches(extents) ||
      extents.scopeEvidenceSha256 !== proof.scopeEvidence.sha256 ||
      extents.transformEvidenceSha256 !== proof.transformEvidence.sha256 ||
      !extents.fullyVisible ||
      extents.clipped ||
      extents.inferredHiddenGeometry ||
      !sameBoxes(extents.captureExtents, matchingObject.captureExtents) ||
      !sameBoxes(
        extents.captureExtents.map((box) => transformRect(box, matrix)),
        proof.geometry.boxes,
      ) ||
      hashIdentity(proof.geometry.boxes) !== expectedBoxesSha256
    )
      throw new RangeError('Source-oracle visible extents do not reproduce the frozen source boxes')
  }
}

type Box = z.infer<typeof boxSchema>
type Matrix = z.infer<typeof transformEvidenceSchema>['matrix']

function boxInside(box: Box, width: number, height: number): boolean {
  return (
    box.left >= 0 && box.top >= 0 && box.left + box.width <= width && box.top + box.height <= height
  )
}

function boxInsideBox(box: Box, container: Box): boolean {
  return (
    box.left >= container.left &&
    box.top >= container.top &&
    box.left + box.width <= container.left + container.width &&
    box.top + box.height <= container.top + container.height
  )
}

function transformRect(box: Box, matrix: Matrix): Box {
  const points = [
    [box.left, box.top],
    [box.left + box.width, box.top],
    [box.left, box.top + box.height],
    [box.left + box.width, box.top + box.height],
  ].map(([x, y]) => [
    matrix.a * x! + matrix.c * y! + matrix.e,
    matrix.b * x! + matrix.d * y! + matrix.f,
  ])
  const xs = points.map(([x]) => x!)
  const ys = points.map(([, y]) => y!)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  const right = Math.max(...xs)
  const bottom = Math.max(...ys)
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top)
    throw new RangeError('Source-oracle transform produced invalid extents')
  return { left, top, width: right - left, height: bottom - top }
}

function sameBoxes(left: readonly Box[], right: readonly Box[]): boolean {
  return (
    left.length === right.length &&
    left.every((box, index) => {
      const other = right[index]!
      return (
        Math.abs(box.left - other.left) <= 1e-6 &&
        Math.abs(box.top - other.top) <= 1e-6 &&
        Math.abs(box.width - other.width) <= 1e-6 &&
        Math.abs(box.height - other.height) <= 1e-6
      )
    })
  )
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function digestText(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')
}
