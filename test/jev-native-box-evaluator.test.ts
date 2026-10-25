import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  JEV_BOX_COVERAGE_GATE,
  JEV_BOX_IOU_GATE,
  buildH8MaskOverlayRgba,
  mapEvaluatorNormalizedBoxToSource,
  scoreJevNativeBoxRow,
  validateEvaluatorFrozenRequestPayload,
  validateParseableEnvelopeReceiptCostConsistency,
  validateReceiptResponseEnvelopeCostIfParseable,
  validateRunManifestReceiptCardinality,
} from '../benchmarks/v03/evaluate-jev-native-box.js'
import {
  JEV_NATIVE_BOX_GENERIC_BOX_INSTRUCTION,
  JEV_NATIVE_BOX_GENERIC_NOUL_INSTRUCTION,
  JEV_NATIVE_BOX_MAX_COST_USD,
  JEV_NATIVE_BOX_MAX_PHYSICAL_CALLS,
  JEV_NATIVE_BOX_MODEL,
  authoredTargetStateLine,
  buildJevNativeBoxWireBody,
  type SourceImageTransformMetadata,
} from '../benchmarks/v03/jev-native-box.js'
import { jevNativeBoxRunManifestSchema } from '../benchmarks/v03/run-jev-native-box.js'

const identityTransform: SourceImageTransformMetadata = {
  source: { width: 100, height: 100 },
  output: { width: 100, height: 100 },
  content: { left: 0, top: 0, width: 100, height: 100 },
  scaleX: 1,
  scaleY: 1,
}

await test('evaluator mapper rejects padding overlap without clamping', () => {
  const letterbox: SourceImageTransformMetadata = {
    source: { width: 100, height: 100 },
    output: { width: 200, height: 200 },
    content: { left: 50, top: 50, width: 100, height: 100 },
    scaleX: 1,
    scaleY: 1,
  }
  assert.throws(
    () =>
      mapEvaluatorNormalizedBoxToSource(
        { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 },
        letterbox,
      ),
    /padding-only/u,
  )
})

await test('evaluator mapper preserves continuous coordinates with scale', () => {
  const scaled: SourceImageTransformMetadata = {
    source: { width: 800, height: 600 },
    output: { width: 800, height: 600 },
    content: { left: 0, top: 0, width: 800, height: 600 },
    scaleX: 2,
    scaleY: 4,
  }
  const mapped = mapEvaluatorNormalizedBoxToSource(
    { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 },
    scaled,
  )
  assert.equal(mapped.left, 40)
  assert.equal(mapped.top, 15)
  assert.equal(mapped.width, 40)
  assert.equal(mapped.height, 15)
})

function freezeRow(caseId: string): Parameters<typeof scoreJevNativeBoxRow>[0]['freezeRow'] {
  return {
    caseId,
    target: 'Thing',
    imagePath: 'images/x.png',
    sourceSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceWidth: 100,
    sourceHeight: 100,
    preparedImageSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    preparedWidth: 100,
    preparedHeight: 100,
    sourceImageTransform: identityTransform,
    requestBodySha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    requestBodyBytes: 10,
    requestPayloadRelativePath: `payloads/${caseId}.request.json`,
    authoredTargetLine: authoredTargetStateLine('Thing'),
    presenceInstructions: JEV_NATIVE_BOX_GENERIC_NOUL_INSTRUCTION,
    objectInstructions: JEV_NATIVE_BOX_GENERIC_BOX_INSTRUCTION,
  }
}

const presentTruth = {
  caseId: 'pilot-v03-photo-01',
  sourceCaseId: 'photo-dev-present-05',
  stratum: 'photo' as const,
  presence: 'present' as const,
  imageSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sourceWidth: 100,
  sourceHeight: 100,
  boxes: [{ left: 10, top: 10, width: 40, height: 40 }],
  referenceMasks: [],
}

const h8Empty = {
  h8aBoxGatePass: null,
  h8aFalseOutput: null,
  h8aMaskIoU: null,
  h8SelectedMaskSha256: null,
  h8SelectedMaskRelativePath: null,
  h8MaskSourceWidth: null,
  h8MaskSourceHeight: null,
  h8MaskDerivedBox: null,
  h8InstanceDiagnostics: [],
  h8EvaluationCrossCheckFalseOutput: null,
}

await test('nonresolved run row with valid noul and box does not positive task pass', () => {
  const scored = scoreJevNativeBoxRow({
    truth: presentTruth,
    freezeRow: freezeRow('pilot-v03-photo-01'),
    runRow: {
      caseId: 'pilot-v03-photo-01',
      status: 'protocol-error',
      presenceNoul: 0.9,
      rawBox: { left: 0.1, top: 0.1, right: 0.5, bottom: 0.5 },
      responseBodySha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      errorCode: 'deadline-exceeded',
    },
    h8Comparison: { ...h8Empty, h8aBoxGatePass: false, h8aFalseOutput: false },
  })
  assert.equal(scored.derivedPresence, 'present')
  assert.equal(scored.geometryGatePass, true)
  assert.equal(scored.positiveTaskPass, false)
  assert.equal(scored.jevRunStatus, 'protocol-error')
})

await test('positive task pass requires present noul and geometry gate', () => {
  const pass = scoreJevNativeBoxRow({
    truth: presentTruth,
    freezeRow: freezeRow('pilot-v03-photo-01'),
    runRow: {
      caseId: 'pilot-v03-photo-01',
      status: 'resolved',
      presenceNoul: 0.9,
      rawBox: { left: 0.1, top: 0.1, right: 0.5, bottom: 0.5 },
      responseBodySha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      errorCode: null,
    },
    h8Comparison: { ...h8Empty, h8aBoxGatePass: false, h8aFalseOutput: false },
  })
  assert.equal(pass.derivedPresence, 'present')
  assert.equal(pass.geometryGatePass, true)
  assert.equal(pass.positiveTaskPass, true)
  assert.ok(pass.jevInstanceDiagnostics.some((item) => item.iou >= JEV_BOX_IOU_GATE))
  assert.ok(pass.jevInstanceDiagnostics.some((item) => item.coverage >= JEV_BOX_COVERAGE_GATE))
})

await test('uncertain noul blocks positive task pass but retains raw box', () => {
  const scored = scoreJevNativeBoxRow({
    truth: presentTruth,
    freezeRow: freezeRow('pilot-v03-photo-01'),
    runRow: {
      caseId: 'pilot-v03-photo-01',
      status: 'resolved',
      presenceNoul: 0.5,
      rawBox: { left: 0.1, top: 0.1, right: 0.5, bottom: 0.5 },
      responseBodySha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      errorCode: null,
    },
    h8Comparison: { ...h8Empty, h8aBoxGatePass: false, h8aFalseOutput: false },
  })
  assert.equal(scored.derivedPresence, 'uncertain')
  assert.equal(scored.geometryGatePass, true)
  assert.equal(scored.positiveTaskPass, false)
  assert.equal(scored.rawBoxRetained, true)
})

await test('negative rows classify semantic outcomes separately from geometry', () => {
  const absentTruth = { ...presentTruth, presence: 'absent' as const, caseId: 'pilot-v03-photo-04' }
  const falseOutput = scoreJevNativeBoxRow({
    truth: absentTruth,
    freezeRow: freezeRow('pilot-v03-photo-04'),
    runRow: {
      caseId: 'pilot-v03-photo-04',
      status: 'resolved',
      presenceNoul: 0.9,
      rawBox: { left: 0.2, top: 0.2, right: 0.4, bottom: 0.4 },
      responseBodySha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      errorCode: null,
    },
    h8Comparison: { ...h8Empty, h8aFalseOutput: true },
  })
  assert.equal(falseOutput.jevNegativeOutcome, 'present-false-output')
  assert.ok(falseOutput.sourceBox)

  const noCall = scoreJevNativeBoxRow({
    truth: absentTruth,
    freezeRow: freezeRow('pilot-v03-photo-04'),
    runRow: {
      caseId: 'pilot-v03-photo-04',
      status: 'not-run',
      presenceNoul: null,
      rawBox: null,
      responseBodySha256: null,
      errorCode: 'admission-blocked',
    },
    h8Comparison: { ...h8Empty, h8aFalseOutput: false },
  })
  assert.equal(noCall.jevNegativeOutcome, 'error-or-no-call')
})

await test('h8 mask overlay rgba differs from bbox-only svg path', () => {
  const width = 4
  const height = 3
  const bits = new Uint8Array(width * height)
  bits[5] = 1
  bits[6] = 1
  const overlay = buildH8MaskOverlayRgba(bits, width, height)
  assert.equal(overlay.length, width * height * 4)
  assert.equal(overlay[5 * 4 + 3], 140)
  assert.equal(overlay[0 * 4 + 3], 0)
  const bboxOnly = Buffer.alloc(width * height * 4)
  assert.notDeepEqual(overlay.subarray(0, 32), bboxOnly.subarray(0, 32))
})

await test('validateEvaluatorFrozenRequestPayload rejects target leaked into questions', () => {
  const imagePart = {
    type: 'image_url' as const,
    image_url: { url: 'data:image/png;base64,AA==', detail: 'high' as const },
  }
  const row = freezeRow('pilot-v03-photo-01')
  const body = buildJevNativeBoxWireBody('SecretThing', imagePart)
  const tampered = {
    ...body,
    questions: {
      presence: {
        type: 'noul' as const,
        instructions: `${JEV_NATIVE_BOX_GENERIC_NOUL_INSTRUCTION} SecretThing`,
      },
      object: body.questions.object,
    },
  }
  assert.throws(
    () =>
      validateEvaluatorFrozenRequestPayload(
        {
          ...row,
          target: 'SecretThing',
          authoredTargetLine: authoredTargetStateLine('SecretThing'),
        },
        `${JSON.stringify(tampered)}\n`,
      ),
    /target-leaked-into-questions/u,
  )
})

await test('validateEvaluatorFrozenRequestPayload accepts canonical wire body', () => {
  const target = 'Widget'
  const pngBase64 = Buffer.from([137, 80, 78, 71]).toString('base64')
  const digest = createHash('sha256').update(Buffer.from(pngBase64, 'base64')).digest('hex')
  const imagePart = {
    type: 'image_url' as const,
    image_url: { url: `data:image/png;base64,${pngBase64}`, detail: 'high' as const },
  }
  const row = {
    ...freezeRow('pilot-v03-photo-01'),
    target,
    authoredTargetLine: authoredTargetStateLine(target),
    preparedImageSha256: digest,
  }
  const body = buildJevNativeBoxWireBody(target, imagePart)
  assert.doesNotThrow(() => validateEvaluatorFrozenRequestPayload(row, `${JSON.stringify(body)}\n`))
  assert.equal(body.model, JEV_NATIVE_BOX_MODEL)
})

await test('validateRunManifestReceiptCardinality allows protocol-error without receipt', () => {
  const baseBudget = {
    admittedPhysicalCalls: 0,
    knownCostUsd: 0,
    unknownCostCalls: 0,
    inFlightCalls: 0,
    accountedExposureUsd: 0,
    maxPhysicalCalls: JEV_NATIVE_BOX_MAX_PHYSICAL_CALLS,
    maxCostUsd: JEV_NATIVE_BOX_MAX_COST_USD,
  }
  assert.doesNotThrow(() =>
    validateRunManifestReceiptCardinality({
      schema: 'v03-jev-native-box-run-v1',
      status: 'blocked',
      profileId: 'jev-native-box-dev12-v1',
      freezeSha256: 'e'.repeat(64),
      sourceClosureSha256: 'e'.repeat(64),
      sourceClosureSha256After: 'e'.repeat(64),
      dataRoot: '/tmp/data',
      freezeDirectory: '/tmp/freeze',
      rows: [
        {
          caseId: 'pilot-v03-photo-01',
          status: 'protocol-error',
          presenceNoul: null,
          rawBox: null,
          responseBodySha256: null,
          errorCode: 'deadline-exceeded',
        },
      ],
      physicalReceipts: [],
      budget: baseBudget,
      consecutiveTransportErrors: 0,
    }),
  )
})

await test('validateRunManifestReceiptCardinality rejects resolved row without receipt', () => {
  assert.throws(
    () =>
      validateRunManifestReceiptCardinality({
        schema: 'v03-jev-native-box-run-v1',
        status: 'blocked',
        profileId: 'jev-native-box-dev12-v1',
        freezeSha256: 'e'.repeat(64),
        sourceClosureSha256: 'e'.repeat(64),
        sourceClosureSha256After: 'e'.repeat(64),
        dataRoot: '/tmp/data',
        freezeDirectory: '/tmp/freeze',
        rows: [
          {
            caseId: 'pilot-v03-photo-01',
            status: 'resolved',
            presenceNoul: 0.9,
            rawBox: { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 },
            responseBodySha256: 'd'.repeat(64),
            errorCode: null,
          },
        ],
        physicalReceipts: [],
        budget: {
          admittedPhysicalCalls: 0,
          knownCostUsd: 0,
          unknownCostCalls: 0,
          inFlightCalls: 0,
          accountedExposureUsd: 0,
          maxPhysicalCalls: JEV_NATIVE_BOX_MAX_PHYSICAL_CALLS,
          maxCostUsd: JEV_NATIVE_BOX_MAX_COST_USD,
        },
        consecutiveTransportErrors: 0,
      }),
    /resolved-row-receipt-mismatch/u,
  )
})

await test('parseable envelope cost consistency rejects null-vs-known mismatch', () => {
  assert.throws(
    () => validateParseableEnvelopeReceiptCostConsistency(0.01, null),
    /usage-cost-mismatch/u,
  )
  assert.throws(
    () => validateParseableEnvelopeReceiptCostConsistency(null, 0.01),
    /usage-cost-mismatch/u,
  )
})

await test('parseable envelope cost consistency allows both-null and matching known', () => {
  assert.doesNotThrow(() => validateParseableEnvelopeReceiptCostConsistency(null, null))
  assert.doesNotThrow(() => validateParseableEnvelopeReceiptCostConsistency(0.0025, 0.0025))
  assert.throws(
    () => validateParseableEnvelopeReceiptCostConsistency(0.01, 0.02),
    /usage-cost-mismatch/u,
  )
})

await test('malformed protocol response body skips envelope cost audit', () => {
  assert.doesNotThrow(() => validateReceiptResponseEnvelopeCostIfParseable('not-json{{{', null))
  assert.doesNotThrow(() => validateReceiptResponseEnvelopeCostIfParseable('not-json{{{', 0.01))
})

await test('run manifest schema rejects receipt hash mismatch shape', () => {
  assert.throws(() =>
    jevNativeBoxRunManifestSchema.parse({
      schema: 'v03-jev-native-box-run-v1',
      status: 'complete',
      profileId: 'jev-native-box-dev12-v1',
      freezeSha256: 'e'.repeat(64),
      sourceClosureSha256: 'e'.repeat(64),
      sourceClosureSha256After: 'e'.repeat(64),
      dataRoot: '/tmp/data',
      freezeDirectory: '/tmp/freeze',
      rows: [],
      physicalReceipts: [
        {
          physicalId: 1,
          caseId: 'pilot-v03-photo-01',
          requestBodySha256: 'not-a-digest',
          httpStatus: 200,
          responseBodySha256: null,
          responseModel: null,
          responseProvider: null,
          costUsd: null,
          durationMs: 1,
          outcome: 'resolved',
          errorCode: null,
        },
      ],
      budget: {
        admittedPhysicalCalls: 1,
        knownCostUsd: 0,
        unknownCostCalls: 1,
        inFlightCalls: 0,
        accountedExposureUsd: 0.02,
        maxPhysicalCalls: 12,
        maxCostUsd: 0.25,
      },
      consecutiveTransportErrors: 0,
    }),
  )
})
