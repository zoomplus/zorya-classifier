import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  UI_STATE_DEV40_BOUNDARY_PREFLIGHT_SHA256,
  UI_STATE_DEV40_CAPTURE_VIEW_SHA256,
  UI_STATE_DEV40_FINGERPRINT_IMPLEMENTATION_SHA256,
  UI_STATE_DEV40_PARENT_REGISTRATION_SHA256,
  UI_STATE_DEV40_PRECAPTURE_ROSTER_SHA256,
  UI_STATE_DEV40_PRECAPTURE_STABILITY_SHA256,
  UI_STATE_DEV40_ROOT,
  UI_STATE_DEV40_STATE_FINGERPRINT_ALGORITHM,
  UI_STATE_DEV40_WORDING_SHA256,
} from './ui-state-dev40-policy.js'

const uiStateBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
  })
  .strict()

const stateOrder = ['showing', 'visible', 'enabled', 'selected', 'checked', 'focused'] as const
const uiVisibleNodeSchema = z
  .object({
    index: z.number().int().nonnegative(),
    role: z.string(),
    name: z.string(),
    states: z.array(z.enum(stateOrder)).min(2),
    bounds: uiStateBoundsSchema.nullable(),
  })
  .strict()
  .superRefine((node, context) => {
    const indices = node.states.map((state) => stateOrder.indexOf(state))
    if (
      !node.states.includes('showing') ||
      !node.states.includes('visible') ||
      new Set(node.states).size !== node.states.length ||
      indices.some((value, index) => index > 0 && indices[index - 1]! >= value)
    )
      context.addIssue({ code: 'custom', message: 'UI state flags are not complete and ordered' })
  })

const uiWindowStackEntrySchema = z
  .object({
    title: z.string(),
    geometry: z
      .object({
        x: z.number().int(),
        y: z.number().int(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        screen: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()

export const uiTargetOracleSchema = z
  .object({
    role: z.string().min(1),
    name: z.string(),
    expectedPresence: z.enum(['present', 'absent']),
    preMatchCount: z.number().int().nonnegative(),
    postMatchCount: z.number().int().nonnegative(),
    uniqueMatchBounds: uiStateBoundsSchema.nullable(),
  })
  .strict()

const uiVisibleStateSchema = z
  .object({
    visibleNodes: z.array(uiVisibleNodeSchema).min(1),
    windowStack: z.array(uiWindowStackEntrySchema).min(1),
  })
  .strict()
  .superRefine((state, context) => {
    if (
      state.visibleNodes.some((node, index) => node.index !== index) ||
      new Set(state.visibleNodes.map((node) => node.index)).size !== state.visibleNodes.length
    )
      context.addIssue({ code: 'custom', message: 'Visible UI node indices must be contiguous' })
  })

const uiNativeCaptureTransformSchema = z
  .object({
    sourceX: z.literal(0),
    sourceY: z.literal(0),
    sourceWidth: z.literal(1280),
    sourceHeight: z.literal(1024),
    scale: z.literal(1),
    paddingLeft: z.literal(0),
    paddingTop: z.literal(0),
  })
  .strict()

const uiNativeStateProofRowSchema = z
  .object({
    order: z.number().int().nonnegative(),
    opaqueCaseId: z.string().min(1),
    sourceGroup: z.string().min(1),
    stateId: z.string().min(1),
    application: z.string().min(1),
    applicationVersion: z.string().min(1),
    sourceInputSha256ByBasename: z.record(
      z.string().regex(/^[A-Za-z0-9._-]+$/u),
      z.string().regex(/^[a-f0-9]{64}$/u),
    ),
    nativeStateFingerprintSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    normalizedNativeStateDocument: uiVisibleStateSchema,
    capture: z
      .object({
        path: z.string().min(1),
        pngSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        decodedRgbSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        width: z.literal(1280),
        height: z.literal(1024),
        view: z.literal('whole-root-1280x1024-no-crop-no-scale-no-overlay-no-pointer'),
        transform: uiNativeCaptureTransformSchema,
      })
      .strict(),
    inventory: z
      .object({
        preSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        postSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        complete: z.literal(true),
        traversalErrorCount: z.literal(0),
        preFingerprintSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        postFingerprintSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    targetOracle: uiTargetOracleSchema,
    appBoundary: z
      .object({
        environmentKeys: z.array(z.string()),
        forbiddenEnvironmentKeysAbsent: z.array(z.string()),
        captureMountAccess: z.literal('blocked:PermissionError'),
        evaluatorScriptAccess: z.literal('blocked:PermissionError'),
        fingerprintScriptAccess: z.literal('blocked:PermissionError'),
        driverEnvironmentAccess: z.literal('blocked:PermissionError'),
        capabilityEffectiveHex: z.literal('0000000000000000'),
        boundaryProbePath: z.literal(
          `${UI_STATE_DEV40_ROOT}/ui/probes/boundary-preflight-01.stdout`,
        ),
        boundaryProbeSha256: z.literal(UI_STATE_DEV40_BOUNDARY_PREFLIGHT_SHA256),
      })
      .strict(),
    captureStatus: z
      .object({
        path: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        sourcePngSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    captureLog: z
      .object({
        path: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        stderrPath: z.string().min(1),
        stderrSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
  })
  .strict()
  .superRefine((row, context) => {
    const count = row.targetOracle.expectedPresence === 'present' ? 1 : 0
    if (
      row.inventory.preFingerprintSha256 !== row.inventory.postFingerprintSha256 ||
      row.inventory.preSha256 !== row.inventory.postSha256 ||
      row.inventory.preFingerprintSha256 !== row.nativeStateFingerprintSha256 ||
      row.captureStatus.sourcePngSha256 !== row.capture.pngSha256 ||
      row.targetOracle.preMatchCount !== count ||
      row.targetOracle.postMatchCount !== count ||
      (count === 1) !== (row.targetOracle.uniqueMatchBounds !== null)
    )
      context.addIssue({
        code: 'custom',
        message: 'UI state or target proof is not stable and closed',
      })
  })

export const uiNativeStateProofRowsSchema = z.object({
  schema: z.literal('h8a-ui-native-state-proof-rows-v1'),
  studyId: z.literal('ui-state-dev40-v1'),
  registrationSha256: z.literal(UI_STATE_DEV40_PARENT_REGISTRATION_SHA256),
  sourceRosterSha256: z.literal(UI_STATE_DEV40_PRECAPTURE_ROSTER_SHA256),
  wordingSha256: z.literal(UI_STATE_DEV40_WORDING_SHA256),
  captureViewSha256: z.literal(UI_STATE_DEV40_CAPTURE_VIEW_SHA256),
  preCaptureStabilitySha256: z.literal(UI_STATE_DEV40_PRECAPTURE_STABILITY_SHA256),
  fingerprintAlgorithm: z.literal(UI_STATE_DEV40_STATE_FINGERPRINT_ALGORITHM),
  referenceAlgorithmPath: z.literal('scripts/native_state_fingerprint.py'),
  referenceAlgorithmSha256: z.literal(UI_STATE_DEV40_FINGERPRINT_IMPLEMENTATION_SHA256),
  serialization: z.literal(
    "UTF-8 JSON insertion order, ensure_ascii=false, separators=(',',':'), SHA-256",
  ),
  rows: z.array(uiNativeStateProofRowSchema).length(10),
})

export const uiCaptureStatusSchema = z
  .object({
    schema: z.literal('ui-state-dev40-capture-attempt-status-v1'),
    order: z.number().int().min(1).max(10),
    opaqueCaseId: z.string().min(1),
    exitCode: z.literal(0),
    startedUtc: z.string().datetime({ offset: true }).optional(),
    stdoutPath: z.string().min(1),
    stdoutSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    stderrPath: z.string().min(1),
    stderrSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    captureFailure: z.null(),
    inventorySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    captureReceipt: z
      .object({
        caseId: z.string().min(1),
        imagePath: z.string().min(1),
        pngSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        rgbSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        width: z.literal(1280),
        height: z.literal(1024),
        preInventorySha256: z.string().regex(/^[a-f0-9]{64}$/u),
        postInventorySha256: z.string().regex(/^[a-f0-9]{64}$/u),
        preQueryMatchCount: z.number().int().nonnegative(),
        postQueryMatchCount: z.number().int().nonnegative(),
        postInventoryComplete: z.literal(true),
        postTraversalErrorCount: z.literal(0),
        nativeFingerprintAlgorithm: z.literal(UI_STATE_DEV40_STATE_FINGERPRINT_ALGORITHM),
        preNativeVisibleStateSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        postNativeVisibleStateSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        preNativeVisibleState: uiVisibleStateSchema,
        postNativeVisibleState: uiVisibleStateSchema,
        appBoundary: z
          .object({
            keys: z.array(z.string()),
            '/opt/capture': z.literal('blocked:PermissionError'),
            '/opt/probe.py': z.literal('blocked:PermissionError'),
            driverEnvironment: z.literal('blocked:PermissionError'),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()

export const uiCaptureLedgerSchema = z
  .object({
    schema: z.literal('h8a-ui-capture-ledger-v1'),
    rows: z
      .array(
        z
          .object({
            order: z.number().int().min(1).max(10),
            opaqueCaseId: z.string().min(1),
            sourceGroup: z.string().min(1),
            stateId: z.string().min(1),
            expectedPresence: z.enum(['present', 'absent']),
            imagePath: z.string().min(1),
            pngSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            decodedRgbSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            perceptualHash64: z.string().regex(/^[a-f0-9]{16}$/u),
            inventoryPreSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            inventoryPostSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            nativeStateFingerprintSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            captureStatusPath: z.string().min(1),
            captureStatusSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            captureLogPath: z.string().min(1),
            captureLogSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .length(10),
  })
  .strict()

export const uiSourcePixelNoveltyAuditSchema = z
  .object({
    schema: z.literal('h8a-ui-source-pixel-novelty-audit-v1'),
    historicalRegistryPath: z.string().min(1),
    historicalRegistrySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    historicalRowsCompared: z.literal(348),
    exactEncodedOrDecodedRgbDuplicatePolicy: z.literal('reject'),
    uiPerceptualHashPolicy: z.literal(
      'diagnostic-only-when-visible-native-state-proof-is-distinct',
    ),
    rows: z
      .array(
        z
          .object({
            order: z.number().int().min(1).max(10),
            opaqueCaseId: z.string().min(1),
            sourceBytesSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            decodedRgbSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            perceptualHash64: z.string().regex(/^[a-f0-9]{16}$/u),
            nearestHistoricalPerceptualHashHamming: z.number().int().min(0).max(64),
            historicalExactEncodedDuplicateCount: z.literal(0),
            historicalExactDecodedRgbDuplicateCount: z.literal(0),
            nativeStateFingerprintSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .length(10),
    peerPairs: z
      .array(
        z
          .object({
            leftOrder: z.number().int().min(1).max(10),
            leftOpaqueCaseId: z.string().min(1),
            rightOrder: z.number().int().min(1).max(10),
            rightOpaqueCaseId: z.string().min(1),
            perceptualHashHamming: z.number().int().min(0).max(64),
            exactEncodedDuplicate: z.literal(false),
            exactDecodedRgbDuplicate: z.literal(false),
            nativeStateFingerprintEqual: z.literal(false),
            pHashDisposition: z.literal('diagnostic-only-ui-state-proof-distinct'),
          })
          .strict(),
      )
      .length(45),
  })
  .strict()
  .strict()
  .superRefine((proof, context) => {
    if (
      new Set(proof.rows.map((row) => row.opaqueCaseId)).size !== proof.rows.length ||
      new Set(proof.rows.map((row) => row.nativeStateFingerprintSha256)).size !==
        proof.rows.length ||
      proof.rows.some((row, index) => row.order !== index + 1)
    )
      context.addIssue({
        code: 'custom',
        message: 'UI state proof rows are not unique and ordered',
      })
  })

export function computeUiVisibleStateFingerprint(stateUnknown: unknown): string {
  const state = uiVisibleStateSchema.parse(stateUnknown)
  const serialized = JSON.stringify(state)
  return createHash('sha256').update(serialized, 'utf8').digest('hex')
}

export interface UiSourcePixelIdentity {
  opaqueCaseId: string
  stratum: 'photo' | 'ui' | 'map'
  encodedSha256: string
  decodedRgbSha256: string
  perceptualHash64: string
  visibleStateFingerprintSha256?: string
}

interface HistoricalPixelIdentity {
  encodedSha256: string
  decodedRgbSha256: string
  perceptualHash64: string
}

function hamming64(left: string, right: string): number {
  let distance = 0
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`)
  while (value !== 0n) {
    distance += Number(value & 1n)
    value >>= 1n
  }
  return distance
}

export function validateUiStateSourcePixelPolicy(
  rows: readonly UiSourcePixelIdentity[],
  historicalRows: readonly HistoricalPixelIdentity[],
): void {
  const ids = new Set<string>()
  const encoded = new Set(historicalRows.map((row) => row.encodedSha256))
  const decodedRgb = new Set(historicalRows.map((row) => row.decodedRgbSha256))
  const fingerprints = new Set<string>()
  for (const row of rows) {
    if (ids.has(row.opaqueCaseId)) throw new RangeError('Duplicate source case identity')
    ids.add(row.opaqueCaseId)
    if (encoded.has(row.encodedSha256))
      throw new RangeError(`Exact encoded source duplicate for ${row.opaqueCaseId}`)
    if (decodedRgb.has(row.decodedRgbSha256))
      throw new RangeError(`Exact decoded RGB source duplicate for ${row.opaqueCaseId}`)
    encoded.add(row.encodedSha256)
    decodedRgb.add(row.decodedRgbSha256)
    if (row.stratum === 'ui') {
      if (!row.visibleStateFingerprintSha256)
        throw new RangeError(`Missing native visible-state proof for ${row.opaqueCaseId}`)
      if (fingerprints.has(row.visibleStateFingerprintSha256))
        throw new RangeError(`Duplicate native visible UI state for ${row.opaqueCaseId}`)
      fingerprints.add(row.visibleStateFingerprintSha256)
    }
  }
  for (const row of rows) {
    if (row.stratum === 'ui') continue
    const nearest = Math.min(
      ...historicalRows.map((prior) => hamming64(row.perceptualHash64, prior.perceptualHash64)),
      ...rows
        .filter((other) => other.opaqueCaseId !== row.opaqueCaseId)
        .map((other) => hamming64(row.perceptualHash64, other.perceptualHash64)),
    )
    if (nearest <= 4)
      throw new RangeError(
        `Photo/map source ${row.opaqueCaseId} fails the unchanged pHash distance gate`,
      )
  }
}
