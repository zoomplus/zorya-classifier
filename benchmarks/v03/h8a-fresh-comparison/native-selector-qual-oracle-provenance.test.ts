import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { PHASE_NATIVE_SELECTOR_QUAL120_ID } from './constants.js'
import { evaluatorPrivateAnnotationBundleSchema } from './schemas.js'
import { buildSyntheticAnnotationBundle, buildSyntheticPhaseFreeze } from './test-fixtures.js'
import { validateNativeSelectorSourceOracleProvenance } from './native-selector-qual-oracle-provenance.js'
import type { SourceOracleProvenanceRow } from './native-selector-qual-oracle-provenance.js'
import {
  NATIVE_SELECTOR_QUAL_FREEZE_ID,
  nativeSelectorQualAnnotationProvenancePolicySchema,
} from './native-selector-qual-protocol.js'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

await test('QUAL provenance schema preserves old methods and closes the new proof-tag shape', () => {
  const base = Array.from({ length: 120 }, (_, index) => ({
    caseId: `case-${index}`,
    sourceSha256: 'a'.repeat(64),
    provenanceSha256: 'b'.repeat(64),
    annotationMethod: 'independent-human-review-v1' as const,
    packedMaskSha256: null,
  }))
  const sourceOracle = {
    caseId: 'case-40',
    sourceSha256: 'c'.repeat(64),
    provenanceSha256: 'd'.repeat(64),
    annotationMethod: 'independent-source-oracle-v1' as const,
    packedMaskSha256: null,
    sourceOracleProof: { path: '/tmp/proof.json', sha256: 'd'.repeat(64), bytes: 12 },
  }
  const parsed = nativeSelectorQualAnnotationProvenancePolicySchema.parse({
    schema: 'h8a-native-selector-qual120-annotation-provenance-v1',
    freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
    annotations: base.map((row, index) => (index === 40 ? sourceOracle : row)),
  })
  assert.equal(parsed.annotations[40]?.annotationMethod, 'independent-source-oracle-v1')
  assert.equal(
    nativeSelectorQualAnnotationProvenancePolicySchema.parse({
      schema: 'h8a-native-selector-qual120-annotation-provenance-v1',
      freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
      annotations: base,
    }).annotations[0]?.annotationMethod,
    'independent-human-review-v1',
  )
  assert.throws(() =>
    nativeSelectorQualAnnotationProvenancePolicySchema.parse({
      schema: 'h8a-native-selector-qual120-annotation-provenance-v1',
      freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
      annotations: base.map((row, index) =>
        index === 40 ? { ...sourceOracle, packedMaskSha256: 'e'.repeat(64) } : row,
      ),
    }),
  )
})

await test('source-oracle UI evidence binds positive geometry and complete same-state absence', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'qual-source-oracle-'))
  t.after(async () => rm(tempRoot, { recursive: true, force: true }))
  const evidenceRoot = join(tempRoot, 'evidence')
  await mkdir(evidenceRoot)
  const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(
    PHASE_NATIVE_SELECTOR_QUAL120_ID,
  )
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(
    buildSyntheticAnnotationBundle(
      PHASE_NATIVE_SELECTOR_QUAL120_ID,
      freeze.freezeId,
      freeze.producerCases,
      freeze.pairedSchedule,
    ),
  )
  const uiRows = annotations.cases.filter((row) => row.stratum === 'ui')
  const present = uiRows.find((row) => row.expectedPresence === 'present')!
  const absent = uiRows.find((row) => row.expectedPresence === 'absent')!
  const mapRows = annotations.cases.filter((row) => row.stratum === 'map')
  const mapPresent = mapRows.find((row) => row.expectedPresence === 'present')!
  const mapAbsent = mapRows.find((row) => row.expectedPresence === 'absent')!
  const sourceAnnotations = [present, absent, mapPresent, mapAbsent]
  const sourceRows = sourceAnnotations.map((row) => ({
    caseId: row.opaqueCaseId,
    sha256: freeze.producerCases.find((producer) => producer.opaqueCaseId === row.opaqueCaseId)!
      .sourceBytesSha256,
    sourceGroup: row.sourceGroup,
  }))
  const readPinned = async (path: string, expectedSha: string, maxBytes: number) => {
    const bytes = await readFile(path)
    assert.ok(bytes.byteLength <= maxBytes)
    assert.equal(sha256(bytes), expectedSha)
    return bytes
  }
  type ProofOverrides = {
    scopeRect?: { left: number; top: number; width: number; height: number }
    transform?: { a: number; b: number; c: number; d: number; e: number; f: number }
    inventoryStateSha256?: string
    inventoryTargetTextSha256?: string
    inventoryTransformSha256?: string
    inventoryClipped?: boolean
    captureExtents?: Array<{ left: number; top: number; width: number; height: number }>
    additionalInventoryObjects?: Array<{
      objectId: string
      targetTextSha256: string
      sourceGroup: string
      captureExtents: Array<{ left: number; top: number; width: number; height: number }>
      fullyVisible: boolean
      clipped: boolean
      inferredHiddenGeometry: false
    }>
  }
  const makeProof = async (
    annotation: (typeof annotations.cases)[number],
    isPresent: boolean,
    overrides: ProofOverrides = {},
  ) => {
    const refs = new Map<string, { path: string; sha256: string; bytes: number }>()
    const producer = freeze.producerCases.find(
      (row) => row.opaqueCaseId === annotation.opaqueCaseId,
    )!
    const source = sourceRows.find((row) => row.caseId === annotation.opaqueCaseId)!
    const targetTextSha256 = sha256(Buffer.from(producer.targetTaskText, 'utf8'))
    const common = {
      caseId: annotation.opaqueCaseId,
      sourceSha256: source.sha256,
      sourceCanvasWidth: producer.sourceCanvasWidth,
      sourceCanvasHeight: producer.sourceCanvasHeight,
      rawSourceStateSha256: '',
      targetTextSha256,
      stratum: annotation.stratum,
      sourceGroup: annotation.sourceGroup,
      scope: annotation.stratum === 'ui' ? 'full-app-window' : 'visible-map-viewport',
    } as const
    const opaquePin = async (name: string, bytes: Uint8Array) => {
      const path = join(evidenceRoot, `${annotation.opaqueCaseId}-${name}.bin`)
      await writeFile(path, bytes)
      const ref = { path, sha256: sha256(bytes), bytes: bytes.byteLength }
      refs.set(name, ref)
      return ref
    }
    const rawSourceState = await opaquePin('state', Buffer.from('synthetic raw UI state'))
    await opaquePin('oracle', Buffer.from('synthetic AT-SPI code pin'))
    const targetBoxes = annotation.referenceBoxes.map((box) => ({ ...box }))
    const defaultScopeRect =
      annotation.stratum === 'ui'
        ? {
            left: 0,
            top: 0,
            width: producer.sourceCanvasWidth,
            height: producer.sourceCanvasHeight,
          }
        : isPresent
          ? {
              left: Math.max(0, Math.min(...targetBoxes.map((box) => box.left)) - 2),
              top: Math.max(0, Math.min(...targetBoxes.map((box) => box.top)) - 2),
              width: Math.min(
                producer.sourceCanvasWidth -
                  Math.max(0, Math.min(...targetBoxes.map((box) => box.left)) - 2),
                Math.max(...targetBoxes.map((box) => box.left + box.width)) -
                  Math.max(0, Math.min(...targetBoxes.map((box) => box.left)) - 2) +
                  2,
              ),
              height: Math.min(
                producer.sourceCanvasHeight -
                  Math.max(0, Math.min(...targetBoxes.map((box) => box.top)) - 2),
                Math.max(...targetBoxes.map((box) => box.top + box.height)) -
                  Math.max(0, Math.min(...targetBoxes.map((box) => box.top)) - 2) +
                  2,
              ),
            }
          : {
              left: 0,
              top: 0,
              width: producer.sourceCanvasWidth - 1,
              height: producer.sourceCanvasHeight,
            }
    const scopeEvidence = {
      schema: 'h8a-native-selector-source-oracle-scope-v1',
      ...common,
      rawSourceStateSha256: rawSourceState.sha256,
      sourceRect: overrides.scopeRect ?? defaultScopeRect,
    }
    const scopeBytes = Buffer.from(JSON.stringify(scopeEvidence))
    const scopePath = join(evidenceRoot, `${annotation.opaqueCaseId}-scope.json`)
    await writeFile(scopePath, scopeBytes)
    const scopeRef = { path: scopePath, sha256: sha256(scopeBytes), bytes: scopeBytes.length }
    refs.set('scope', scopeRef)
    const transformEvidence = {
      schema: 'h8a-native-selector-source-oracle-transform-v1',
      ...common,
      rawSourceStateSha256: rawSourceState.sha256,
      scopeEvidenceSha256: scopeRef.sha256,
      matrix: overrides.transform ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    }
    const transformBytes = Buffer.from(JSON.stringify(transformEvidence))
    const transformPath = join(evidenceRoot, `${annotation.opaqueCaseId}-transform.json`)
    await writeFile(transformPath, transformBytes)
    const transformRef = {
      path: transformPath,
      sha256: sha256(transformBytes),
      bytes: transformBytes.length,
    }
    refs.set('transform', transformRef)
    const captureExtents = overrides.captureExtents ?? targetBoxes
    const matchingObject = {
      objectId: 'control-1',
      targetTextSha256: overrides.inventoryTargetTextSha256 ?? targetTextSha256,
      sourceGroup: annotation.sourceGroup,
      captureExtents,
      fullyVisible: true,
      clipped: overrides.inventoryClipped ?? false,
      inferredHiddenGeometry: false,
    }
    const inventory = {
      schema: 'h8a-native-selector-source-oracle-visible-inventory-v1',
      ...common,
      rawSourceStateSha256: overrides.inventoryStateSha256 ?? rawSourceState.sha256,
      scopeEvidenceSha256: scopeRef.sha256,
      transformEvidenceSha256: overrides.inventoryTransformSha256 ?? transformRef.sha256,
      complete: true,
      sameState: true,
      objects: [
        isPresent
          ? matchingObject
          : {
              ...matchingObject,
              targetTextSha256: overrides.inventoryTargetTextSha256 ?? 'f'.repeat(64),
              captureExtents: [{ left: 0, top: 0, width: 1, height: 1 }],
            },
        ...(overrides.additionalInventoryObjects ?? []),
      ],
    }
    const inventoryBytes = Buffer.from(JSON.stringify(inventory))
    const inventoryPath = join(evidenceRoot, `${annotation.opaqueCaseId}-inventory.json`)
    await writeFile(inventoryPath, inventoryBytes)
    const inventoryRef = {
      path: inventoryPath,
      sha256: sha256(inventoryBytes),
      bytes: inventoryBytes.length,
    }
    refs.set('inventory', inventoryRef)
    const proof = {
      schema: 'h8a-native-selector-source-oracle-proof-v1',
      caseId: annotation.opaqueCaseId,
      sourceSha256: source.sha256,
      sourceCanvasWidth: producer.sourceCanvasWidth,
      sourceCanvasHeight: producer.sourceCanvasHeight,
      targetTextSha256,
      stratum: annotation.stratum,
      sourceGroup: annotation.sourceGroup,
      expectedPresence: annotation.expectedPresence,
      referenceBoxesSha256: targetBoxes.length
        ? (await import('./hash-identity.js')).hashIdentity(targetBoxes)
        : null,
      scope: annotation.stratum === 'ui' ? 'full-app-window' : 'visible-map-viewport',
      oracleKind: annotation.stratum === 'ui' ? 'atspi-component' : 'source-state-renderer',
      modelAssisted: false,
      ocrAssisted: false,
      segmentationModelAssisted: false,
      rawSourceState: refs.get('state')!,
      oracleCode: refs.get('oracle')!,
      completeVisibleInventory: {
        ...inventoryRef,
        complete: true,
        sameState: true,
        matchingVisibleObjectIds: inventory.objects
          .filter((object) => object.targetTextSha256 === targetTextSha256)
          .map((object) => object.objectId),
        queriedScopeSha256: scopeRef.sha256,
        transformSha256: transformRef.sha256,
      },
      transformEvidence: transformRef,
      geometry: isPresent
        ? {
            sourceObjectId: 'control-1',
            boxes: targetBoxes,
            extentsEvidence: await (async () => {
              const extentsEvidence = {
                schema: 'h8a-native-selector-source-oracle-extents-v1',
                ...common,
                rawSourceStateSha256: rawSourceState.sha256,
                scopeEvidenceSha256: scopeRef.sha256,
                transformEvidenceSha256: transformRef.sha256,
                sourceObjectId: 'control-1',
                captureExtents,
                fullyVisible: true,
                clipped: false,
                inferredHiddenGeometry: false,
              }
              const bytes = Buffer.from(JSON.stringify(extentsEvidence))
              const path = join(evidenceRoot, `${annotation.opaqueCaseId}-extents.json`)
              await writeFile(path, bytes)
              const ref = { path, sha256: sha256(bytes), bytes: bytes.length }
              refs.set('extents', ref)
              return ref
            })(),
            fullyVisible: true,
            clipped: false,
            inferredHiddenGeometry: false,
          }
        : null,
      scopeEvidence: scopeRef,
    }
    const proofBytes = Buffer.from(JSON.stringify(proof))
    const path = join(evidenceRoot, `${annotation.opaqueCaseId}-proof.json`)
    await writeFile(path, proofBytes)
    return {
      caseId: annotation.opaqueCaseId,
      sourceSha256: proof.sourceSha256,
      provenanceSha256: sha256(proofBytes),
      annotationMethod: 'independent-source-oracle-v1' as const,
      packedMaskSha256: null,
      sourceOracleProof: { path, sha256: sha256(proofBytes), bytes: proofBytes.byteLength },
    } satisfies SourceOracleProvenanceRow
  }
  const provenanceRows = [
    await makeProof(present, true),
    await makeProof(absent, false),
    await makeProof(mapPresent, true),
    await makeProof(mapAbsent, false),
  ]
  await validateNativeSelectorSourceOracleProvenance({
    freeze,
    annotations,
    sourceRows,
    provenanceRows,
    artifactRoot: resolve(tempRoot),
    readPinned,
  })
  const changedFreeze = {
    ...freeze,
    producerCases: freeze.producerCases.map((producer) =>
      producer.opaqueCaseId === present.opaqueCaseId
        ? { ...producer, targetTaskText: `${producer.targetTaskText} changed` }
        : producer,
    ),
  }
  await assert.rejects(
    validateNativeSelectorSourceOracleProvenance({
      freeze: changedFreeze,
      annotations,
      sourceRows,
      provenanceRows,
      artifactRoot: resolve(tempRoot),
      readPinned,
    }),
    /does not bind the frozen case/u,
  )
  const assertInvalidProof = async (
    annotation: (typeof annotations.cases)[number],
    isPresent: boolean,
    overrides: ProofOverrides,
  ) => {
    const invalid = await makeProof(annotation, isPresent, overrides)
    await assert.rejects(
      validateNativeSelectorSourceOracleProvenance({
        freeze,
        annotations,
        sourceRows: sourceRows.filter((source) => source.caseId === annotation.opaqueCaseId),
        provenanceRows: [invalid],
        artifactRoot: resolve(tempRoot),
        readPinned,
      }),
    )
  }
  const presentProducer = freeze.producerCases.find(
    (row) => row.opaqueCaseId === present.opaqueCaseId,
  )!
  await assertInvalidProof(present, true, {
    scopeRect: {
      left: 1,
      top: 1,
      width: presentProducer.sourceCanvasWidth - 1,
      height: presentProducer.sourceCanvasHeight - 1,
    },
  })
  await assertInvalidProof(present, true, {
    transform: { a: 1, b: 0, c: 0, d: 1, e: 1, f: 0 },
  })
  await assertInvalidProof(present, true, {
    inventoryTransformSha256: 'e'.repeat(64),
  })
  await assertInvalidProof(present, true, {
    inventoryStateSha256: 'e'.repeat(64),
  })
  await assertInvalidProof(present, true, {
    inventoryTargetTextSha256: 'e'.repeat(64),
  })
  await assertInvalidProof(present, true, {
    inventoryClipped: true,
  })
  const visibleTargetBox = present.referenceBoxes[0]!
  const clippedNonTargetInventoryProof = await makeProof(present, true, {
    additionalInventoryObjects: [
      {
        objectId: 'clipped-non-target',
        targetTextSha256: 'f'.repeat(64),
        sourceGroup: present.sourceGroup,
        captureExtents: [
          { left: visibleTargetBox.left, top: visibleTargetBox.top, width: 1, height: 1 },
        ],
        fullyVisible: false,
        clipped: true,
        inferredHiddenGeometry: false,
      },
      {
        objectId: 'second-visible-target',
        targetTextSha256: sha256(
          Buffer.from(
            freeze.producerCases.find((row) => row.opaqueCaseId === present.opaqueCaseId)!
              .targetTaskText,
            'utf8',
          ),
        ),
        sourceGroup: present.sourceGroup,
        captureExtents: present.referenceBoxes.map((box) => ({ ...box })),
        fullyVisible: true,
        clipped: false,
        inferredHiddenGeometry: false,
      },
    ],
  })
  await validateNativeSelectorSourceOracleProvenance({
    freeze,
    annotations,
    sourceRows: sourceRows.filter((source) => source.caseId === present.opaqueCaseId),
    provenanceRows: [clippedNonTargetInventoryProof],
    artifactRoot: resolve(tempRoot),
    readPinned,
  })
  await assertInvalidProof(absent, false, {
    inventoryTargetTextSha256: sha256(
      Buffer.from(
        freeze.producerCases.find((row) => row.opaqueCaseId === absent.opaqueCaseId)!
          .targetTaskText,
        'utf8',
      ),
    ),
  })
  await assertInvalidProof(absent, false, {
    additionalInventoryObjects: [
      {
        objectId: 'partially-visible-target',
        targetTextSha256: sha256(
          Buffer.from(
            freeze.producerCases.find((row) => row.opaqueCaseId === absent.opaqueCaseId)!
              .targetTaskText,
            'utf8',
          ),
        ),
        sourceGroup: absent.sourceGroup,
        captureExtents: [{ left: 0, top: 0, width: 1, height: 1 }],
        fullyVisible: false,
        clipped: true,
        inferredHiddenGeometry: false,
      },
    ],
  })
  const mapProducer = freeze.producerCases.find(
    (row) => row.opaqueCaseId === mapPresent.opaqueCaseId,
  )!
  const mapBox = mapPresent.referenceBoxes[0]!
  await assertInvalidProof(mapPresent, true, {
    scopeRect: {
      left: mapProducer.sourceCanvasWidth - 1,
      top: mapProducer.sourceCanvasHeight - 1,
      width: 1,
      height: 1,
    },
  })
  await assertInvalidProof(mapPresent, true, {
    captureExtents: [
      {
        left: mapProducer.sourceCanvasWidth - 1,
        top: mapBox.top,
        width: 3,
        height: mapBox.height,
      },
    ],
  })
  assert.equal(sourceBytesByCaseId.size, 120)
})

await test('source-oracle evidence rejects a photo tag before reading its proof', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'qual-source-oracle-reject-'))
  t.after(async () => rm(tempRoot, { recursive: true, force: true }))
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_NATIVE_SELECTOR_QUAL120_ID)
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(
    buildSyntheticAnnotationBundle(
      PHASE_NATIVE_SELECTOR_QUAL120_ID,
      freeze.freezeId,
      freeze.producerCases,
      freeze.pairedSchedule,
    ),
  )
  const photo = annotations.cases.find((row) => row.stratum === 'photo')!
  const row: SourceOracleProvenanceRow = {
    caseId: photo.opaqueCaseId,
    sourceSha256: freeze.producerCases.find(
      (producer) => producer.opaqueCaseId === photo.opaqueCaseId,
    )!.sourceBytesSha256,
    provenanceSha256: '0'.repeat(64),
    annotationMethod: 'independent-source-oracle-v1',
    packedMaskSha256: null,
    sourceOracleProof: { path: join(tempRoot, 'missing'), sha256: '0'.repeat(64), bytes: 1 },
  }
  await assert.rejects(
    validateNativeSelectorSourceOracleProvenance({
      freeze,
      annotations,
      sourceRows: [
        { caseId: photo.opaqueCaseId, sha256: row.sourceSha256, sourceGroup: photo.sourceGroup },
      ],
      provenanceRows: [row],
      artifactRoot: resolve(tempRoot),
      readPinned: async () => Buffer.from('{}'),
    }),
    /restricted to frozen UI and map/u,
  )
})
