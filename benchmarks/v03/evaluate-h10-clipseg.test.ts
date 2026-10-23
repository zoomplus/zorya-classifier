import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import sharp from 'sharp'
import type { Box } from '../v02/metrics.js'
import { wholeObjectMatch } from '../v02/metrics.js'
import {
  H10_CLIP_MODEL_MAX_LENGTH,
  H10_FALSE_OUTPUTS_MAXIMUM,
  H10_POSITIVE_SUCCESS_MINIMUM,
  H10_REAL_RUN_DEVICE,
  MINIMAL_DEV_MANIFEST_SHA256,
  auditCandidateMask,
  buildExpectedH10PilotRows,
  compareLockedManifestToFreezeRows,
  evaluateH10ClipsegRun,
  expectedManifestRowsMatch,
  foregroundBoundsToBox,
  maskForegroundBounds,
  resolveMaskPathWithinRunRoot,
  validateApprovedContractShape,
  validateProducerOutcomeRowFields,
  verifyAssetDirectoryOnDisk,
  verifyAssetReceiptMetadata,
  verifyContractFile,
  verifyEmittedMaskInventory,
  verifyEffectiveProcessorSnapshot,
  verifyRunDeviceAndFreezePath,
  verifyRunRecordProducerBindings,
  verifyCudaDevRunReceiptConsistency,
  verifyScriptPathHash,
  runSchema,
  freezeRuntimeSchema,
  type ExpectedH10PilotRow,
} from './evaluate-h10-clipseg.js'

function validEffectiveProcessorSnapshot() {
  return {
    image_processor_class: 'ViTImageProcessor' as const,
    image_processor_module: 'transformers.models.vit.image_processing_vit' as const,
    use_fast: false as const,
    size: { height: 352 as const, width: 352 as const },
    resample: 2 as const,
    do_resize: true as const,
    do_rescale: true as const,
    do_normalize: true as const,
    rescale_factor: 1 / 255,
    image_mean: [0.485, 0.456, 0.406],
    image_std: [0.229, 0.224, 0.225],
  }
}

const CANVAS = 100

async function writeMaskPng(
  path: string,
  width: number,
  height: number,
  paint: (x: number, y: number) => boolean,
): Promise<{
  sha256: string
  bounds: { x_min: number; y_min: number; x_max: number; y_max: number }
}> {
  const rgba = Buffer.alloc(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rgba[y * width + x] = paint(x, y) ? 255 : 0
    }
  }
  await sharp(rgba, { raw: { width, height, channels: 1 } })
    .toColourspace('b-w')
    .png()
    .toFile(path)
  const bytes = await readFile(path)
  const bounds = maskForegroundBounds(
    Uint8Array.from(rgba, (value) => (value === 255 ? 1 : 0)),
    width,
    height,
  )
  assert.ok(bounds)
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bounds }
}

function syntheticExpectedRows(
  options: { splitReferenceRow0?: boolean } = {},
): ExpectedH10PilotRow[] {
  const standardReference: Box = { left: 10, top: 10, width: 20, height: 20 }
  const referenceLarge: Box = { left: 0, top: 0, width: 100, height: 100 }
  const referenceSmall: Box = { left: 0, top: 0, width: 10, height: 10 }
  const rows: ExpectedH10PilotRow[] = []
  for (let row_index = 0; row_index < 12; row_index++) {
    const stratum = row_index < 4 ? 'photo' : row_index < 8 ? 'ui' : 'map'
    const presence = row_index === 3 || row_index === 7 || row_index === 11 ? 'absent' : 'present'
    rows.push({
      row_index,
      row_key: `fixture-${String(row_index).padStart(2, '0')}`,
      caseId: `fixture-${String(row_index).padStart(2, '0')}`,
      authored_target: `target-${row_index}`,
      expectedSourceSha256: createHash('sha256').update(`source-${row_index}`).digest('hex'),
      sourceWidth: CANVAS,
      sourceHeight: CANVAS,
      stratum,
      presence,
      referenceBoxes:
        presence === 'present'
          ? options.splitReferenceRow0 && row_index === 0
            ? [referenceLarge, referenceSmall]
            : [standardReference]
          : [],
    })
  }
  return rows
}

type RowSpec = {
  outcome_kind: 'candidate' | 'unresolved_empty' | 'technical_error'
  paint?: (x: number, y: number) => boolean
  tamperSha?: boolean
  wrongDimensions?: boolean
  wrongBounds?: boolean
  wrongSourceSha?: boolean
  wrongTarget?: boolean
  wrongKey?: boolean
  falseEmptyFields?: boolean
  omit?: boolean
}

async function buildFixtureRun(
  expected: ExpectedH10PilotRow[],
  specs: RowSpec[],
  options: { skipRows?: number[] } = {},
) {
  const runRoot = await mkdtemp(join(tmpdir(), 'zorya-h10-eval-'))
  const masksDir = join(runRoot, 'masks')
  await mkdir(masksDir, { recursive: true })
  const rows = []
  for (const expectedRow of expected) {
    if (options.skipRows?.includes(expectedRow.row_index)) continue
    const spec = specs[expectedRow.row_index] ?? { outcome_kind: 'unresolved_empty' as const }
    if (spec.omit) continue
    const relativeMaskPath = join('masks', `${expectedRow.row_key}.png`)
    const maskPath = join(runRoot, relativeMaskPath)
    let mask_sha256: string | null = null
    let foreground_bounds: {
      x_min: number
      y_min: number
      x_max: number
      y_max: number
    } | null = null
    if (spec.outcome_kind === 'candidate') {
      const width = spec.wrongDimensions ? expectedRow.sourceWidth - 1 : expectedRow.sourceWidth
      const height = spec.wrongDimensions ? expectedRow.sourceHeight - 1 : expectedRow.sourceHeight
      const painted =
        spec.paint ?? ((x: number, y: number) => x >= 10 && x < 30 && y >= 10 && y < 30)
      const mask = await writeMaskPng(maskPath, width, height, painted)
      mask_sha256 = spec.tamperSha ? '0'.repeat(64) : mask.sha256
      foreground_bounds = spec.wrongBounds
        ? { x_min: 0, y_min: 0, x_max: 1, y_max: 1 }
        : mask.bounds
    }
    rows.push({
      row_index: expectedRow.row_index,
      row_key: spec.wrongKey ? 'wrong-key' : expectedRow.row_key,
      authored_target: spec.wrongTarget ? 'wrong-target' : expectedRow.authored_target,
      outcome_kind: spec.outcome_kind,
      source_width: expectedRow.sourceWidth,
      source_height: expectedRow.sourceHeight,
      source_sha256: spec.wrongSourceSha ? 'f'.repeat(64) : expectedRow.expectedSourceSha256,
      interpolate_pos_encoding: true,
      model_max_length: 77,
      mask_path:
        spec.outcome_kind === 'candidate'
          ? relativeMaskPath
          : spec.falseEmptyFields
            ? relativeMaskPath
            : null,
      mask_sha256: spec.falseEmptyFields ? 'a'.repeat(64) : mask_sha256,
      foreground_bounds: spec.falseEmptyFields
        ? { x_min: 0, y_min: 0, x_max: 1, y_max: 1 }
        : foreground_bounds,
    })
  }
  rows.sort((left, right) => left.row_index - right.row_index)
  await writeFile(
    join(runRoot, 'rows.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  )
  return { runRoot, rows }
}

await test('buildExpectedH10PilotRows joins frozen pilot inputs to truth', async () => {
  const rows = await buildExpectedH10PilotRows()
  assert.equal(rows.length, 12)
  const first = rows[0]
  const last = rows[11]
  assert.ok(first)
  assert.ok(last)
  assert.equal(first.row_key, 'pilot-v03-photo-01')
  assert.equal(first.row_index, 0)
  assert.equal(last.row_key, 'pilot-v03-map-04')
  assert.equal(rows.filter((row) => row.presence === 'present').length, 9)
  assert.equal(rows.filter((row) => row.presence === 'absent').length, 3)
})

await test('wholeObjectMatch rejects split-threshold wins on different reference instances', () => {
  const references: Box[] = [
    { left: 0, top: 0, width: 100, height: 100 },
    { left: 0, top: 0, width: 10, height: 10 },
  ]
  const highCoverageOnly = wholeObjectMatch({ left: 0, top: 0, width: 15, height: 15 }, references)
  assert.equal(highCoverageOnly.matched, false)
  const highIoUOnly = wholeObjectMatch({ left: 0, top: 0, width: 75, height: 75 }, references)
  assert.equal(highIoUOnly.matched, false)
})

await test('H10 evaluator reports clean gate pass for valid fixture run', async () => {
  const expected = syntheticExpectedRows()
  const specs: RowSpec[] = expected.map((row) =>
    row.presence === 'absent'
      ? { outcome_kind: 'unresolved_empty' }
      : {
          outcome_kind: 'candidate',
          paint: (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30,
        },
  )
  const { runRoot, rows } = await buildFixtureRun(expected, specs)
  try {
    const report = await evaluateH10ClipsegRun({
      runRoot,
      mode: 'synthetic-fixture',
      expectedRows: expected,
      rows,
    })
    assert.equal(report.gate.positiveSuccesses, 9)
    assert.equal(report.gate.falseOutputs, 0)
    assert.equal(report.gate.cleanPass, true)
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})

await test('H10 evaluator rejects wrong source SHA and target or ID joins', async () => {
  const expected = syntheticExpectedRows()
  for (const [label, specPatch] of [
    ['wrong-source-sha', { wrongSourceSha: true }],
    ['wrong-target', { wrongTarget: true }],
    ['wrong-key', { wrongKey: true }],
  ] as const) {
    const specs: RowSpec[] = expected.map((row) =>
      row.row_index === 1
        ? { outcome_kind: 'candidate' as const, ...specPatch }
        : { outcome_kind: 'unresolved_empty' as const },
    )
    const { runRoot, rows } = await buildFixtureRun(expected, specs)
    try {
      const report = await evaluateH10ClipsegRun({
        runRoot,
        mode: 'synthetic-fixture',
        expectedRows: expected,
        rows,
      })
      assert.equal(report.gate.cleanPass, false, label)
      assert.ok(
        report.integrityErrors.some((item) => item.includes('fixture-01')),
        label,
      )
    } finally {
      await rm(runRoot, { recursive: true, force: true })
    }
  }
})

await test('H10 evaluator rejects tampered mask SHA, dimensions, binary pixels, and bounds', async () => {
  const expected = syntheticExpectedRows()
  for (const [label, patch] of [
    ['tampered-sha', { tamperSha: true }],
    ['wrong-dimensions', { wrongDimensions: true }],
    ['wrong-bounds', { wrongBounds: true }],
  ] as const) {
    const specs: RowSpec[] = expected.map((row, index) =>
      index === 2
        ? { outcome_kind: 'candidate' as const, ...patch }
        : { outcome_kind: 'unresolved_empty' as const },
    )
    const { runRoot, rows } = await buildFixtureRun(expected, specs)
    try {
      const report = await evaluateH10ClipsegRun({
        runRoot,
        mode: 'synthetic-fixture',
        expectedRows: expected,
        rows,
      })
      assert.equal(report.gate.cleanPass, false, label)
      const row2 = report.perRow.find((row) => row.row_index === 2)
      assert.ok(row2)
      assert.ok(
        row2.maskAudit.status === 'invalid' ||
          report.integrityErrors.some((item) => item.includes('fixture-02')),
        label,
      )
    } finally {
      await rm(runRoot, { recursive: true, force: true })
    }
  }

  const runRoot = await mkdtemp(join(tmpdir(), 'zorya-h10-eval-binary-'))
  const maskPath = join(runRoot, 'masks', 'bad.png')
  await mkdir(join(runRoot, 'masks'), { recursive: true })
  const rgba = Buffer.alloc(CANVAS * CANVAS)
  rgba[0] = 127
  await sharp(rgba, { raw: { width: CANVAS, height: CANVAS, channels: 1 } })
    .png()
    .toFile(maskPath)
  const bytes = await readFile(maskPath)
  const mask_sha256 = createHash('sha256').update(bytes).digest('hex')
  const audit = await auditCandidateMask({
    runRoot,
    expectedWidth: CANVAS,
    expectedHeight: CANVAS,
    row: {
      row_index: 0,
      row_key: 'fixture-00',
      authored_target: 'target',
      outcome_kind: 'candidate',
      source_width: CANVAS,
      source_height: CANVAS,
      source_sha256: createHash('sha256').update('source-0').digest('hex'),
      mask_path: join('masks', 'bad.png'),
      mask_sha256,
      foreground_bounds: { x_min: 0, y_min: 0, x_max: 0, y_max: 0 },
      interpolate_pos_encoding: true,
    },
  })
  assert.equal(audit.status, 'invalid')
  await rm(runRoot, { recursive: true, force: true })
})

await test('H10 evaluator rejects alpha and multichannel mask PNGs', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'zorya-h10-eval-rgba-'))
  const maskPath = join(runRoot, 'masks', 'rgba.png')
  await mkdir(join(runRoot, 'masks'), { recursive: true })
  await sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toFile(maskPath)
  const bytes = await readFile(maskPath)
  const mask_sha256 = createHash('sha256').update(bytes).digest('hex')
  const audit = await auditCandidateMask({
    runRoot,
    expectedWidth: CANVAS,
    expectedHeight: CANVAS,
    row: {
      row_index: 0,
      row_key: 'fixture-00',
      authored_target: 'target',
      outcome_kind: 'candidate',
      source_width: CANVAS,
      source_height: CANVAS,
      source_sha256: createHash('sha256').update('source-0').digest('hex'),
      mask_path: join('masks', 'rgba.png'),
      mask_sha256,
      foreground_bounds: { x_min: 0, y_min: 0, x_max: 0, y_max: 0 },
      interpolate_pos_encoding: true,
    },
  })
  assert.equal(audit.status, 'invalid')
  assert.ok(audit.reason === 'mask-has-alpha' || audit.reason === 'mask-not-single-channel-l')
  await rm(runRoot, { recursive: true, force: true })
})

function contractRequiringModelMaxLength(): Record<string, unknown> {
  return {
    schema: 'v03-h10-clipseg-producer-contract-v1',
    processor: { class: 'CLIPSegProcessor' },
    model_conditioning_payload: {
      fields: ['oriented_source_rgb', 'authored_target_string'],
    },
    row_output: {
      required_fields: [
        'source_sha256',
        'oriented_rgb_sha256',
        'authored_target',
        'model_max_length',
        'interpolate_pos_encoding',
      ],
    },
  }
}

function minimalProducerRowForContract(modelMaxLength: number) {
  return {
    row_index: 0,
    row_key: 'fixture-00',
    authored_target: 'target',
    outcome_kind: 'unresolved_empty' as const,
    source_width: CANVAS,
    source_height: CANVAS,
    source_sha256: createHash('sha256').update('x').digest('hex'),
    oriented_rgb_sha256: createHash('sha256').update('rgb').digest('hex'),
    model_max_length: modelMaxLength,
    interpolate_pos_encoding: true,
  }
}

await test('validateProducerOutcomeRowFields requires contract model_max_length === 77', () => {
  const contract = contractRequiringModelMaxLength()
  const accepted = validateProducerOutcomeRowFields(
    minimalProducerRowForContract(H10_CLIP_MODEL_MAX_LENGTH),
    contract,
  )
  assert.equal(accepted.length, 0)
  const rejected = validateProducerOutcomeRowFields(
    minimalProducerRowForContract(H10_CLIP_MODEL_MAX_LENGTH - 1),
    contract,
  )
  assert.ok(
    rejected.includes(`fixture-00:contract-model-max-length-not-${H10_CLIP_MODEL_MAX_LENGTH}`),
  )
})

await test('validateProducerOutcomeRowFields rejects false unresolved-empty mask fields', () => {
  const errors = validateProducerOutcomeRowFields(
    {
      row_index: 0,
      row_key: 'fixture-00',
      authored_target: 'target',
      outcome_kind: 'unresolved_empty',
      source_width: CANVAS,
      source_height: CANVAS,
      source_sha256: createHash('sha256').update('x').digest('hex'),
      mask_path: 'masks/x.png',
      mask_sha256: 'b'.repeat(64),
      foreground_bounds: { x_min: 0, y_min: 0, x_max: 1, y_max: 1 },
    },
    null,
  )
  assert.ok(errors.some((item) => item.includes('unresolved-empty-has-mask-path')))
})

await test('receipt helpers reject tampered contract and asset bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-h10-receipts-'))
  const assetDir = join(root, 'assets')
  await mkdir(assetDir, { recursive: true })
  await writeFile(join(assetDir, 'config.json'), '{"bad":true}', 'utf8')
  const contractPath = join(root, 'contract.json')
  await writeFile(
    contractPath,
    JSON.stringify({
      schema: 'v03-h10-clipseg-producer-contract-v1',
      processor: { class: 'CLIPSegProcessor' },
      model_conditioning_payload: {
        fields: ['oriented_source_rgb', 'authored_target_string'],
      },
      row_output: {
        required_fields: [
          'row_index',
          'row_key',
          'outcome_kind',
          'source_width',
          'source_height',
          'source_sha256',
          'oriented_rgb_sha256',
          'authored_target',
          'model_max_length',
          'interpolate_pos_encoding',
        ],
      },
    }),
    'utf8',
  )
  const contractErrors: string[] = []
  await verifyContractFile(contractPath, '0'.repeat(64), contractErrors)
  assert.ok(contractErrors.includes('contract-bytes-sha256-mismatch'))
  const assetErrors: string[] = []
  await verifyAssetDirectoryOnDisk(assetDir, assetErrors)
  assert.ok(assetErrors.some((item) => item.includes('asset-bytes-mismatch-config.json')))
  const metadataErrors = verifyAssetReceiptMetadata({
    'config.json': { sha256: '0'.repeat(64), bytes: 1 },
  })
  assert.ok(metadataErrors.includes('asset-receipt-metadata-mismatch-config.json'))
  await rm(root, { recursive: true, force: true })
})

await test('expectedManifestRowsMatch requires source_sha256 alignment', () => {
  const expected = syntheticExpectedRows()
  const drifted = expected.map((row) => ({
    row_index: row.row_index,
    row_key: row.row_key,
    source_path: `/tmp/${row.row_key}.png`,
    authored_target: row.authored_target,
    source_sha256: '0'.repeat(64),
  }))
  const errors = expectedManifestRowsMatch(expected, drifted)
  assert.ok(errors.some((item) => item.includes('manifest-source-sha-0')))
})

await test('H10 evaluator treats empty positive as unresolved and negative candidate as false output', async () => {
  const expected = syntheticExpectedRows()
  const specs: RowSpec[] = expected.map((row) => {
    if (row.presence === 'absent' && row.row_index === 11) {
      return {
        outcome_kind: 'candidate',
        paint: (x: number, y: number) => x < 5 && y < 5,
      }
    }
    return { outcome_kind: 'unresolved_empty' }
  })
  const { runRoot, rows } = await buildFixtureRun(expected, specs)
  try {
    const report = await evaluateH10ClipsegRun({
      runRoot,
      mode: 'synthetic-fixture',
      expectedRows: expected,
      rows,
    })
    assert.equal(report.gate.positiveSuccesses, 0)
    assert.equal(report.gate.falseOutputs, 1)
    assert.equal(report.gate.cleanPass, false)
    assert.ok(report.gate.positiveSuccesses < H10_POSITIVE_SUCCESS_MINIMUM)
    assert.ok(report.gate.falseOutputs > H10_FALSE_OUTPUTS_MAXIMUM)
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})

await test('H10 evaluator blocks clean pass on missing row, technical errors, and false empty fields', async () => {
  const expected = syntheticExpectedRows()
  const specs: RowSpec[] = expected.map((row) =>
    row.row_index === 4
      ? { outcome_kind: 'technical_error' }
      : row.row_index === 6
        ? { outcome_kind: 'unresolved_empty', falseEmptyFields: true }
        : { outcome_kind: 'unresolved_empty' },
  )
  const missing = await buildFixtureRun(expected, specs, { skipRows: [5] })
  try {
    const reportMissing = await evaluateH10ClipsegRun({
      runRoot: missing.runRoot,
      mode: 'synthetic-fixture',
      expectedRows: expected,
      rows: missing.rows,
    })
    assert.equal(reportMissing.gate.cleanPass, false)
    assert.ok(reportMissing.integrityErrors.some((item) => item.includes('missing-row')))
    assert.ok(reportMissing.integrityErrors.some((item) => item.includes('technical-error')))
    assert.ok(
      reportMissing.integrityErrors.some((item) => item.includes('unresolved-empty-has-mask-path')),
    )
  } finally {
    await rm(missing.runRoot, { recursive: true, force: true })
  }
})

await test('H10 evaluator fails split-instance positive even when each reference passes one threshold', async () => {
  const expected = syntheticExpectedRows({ splitReferenceRow0: true })
  const specs: RowSpec[] = expected.map((row, index) =>
    index === 0
      ? {
          outcome_kind: 'candidate' as const,
          paint: (x: number, y: number) => x < 75 && y < 75,
        }
      : { outcome_kind: 'unresolved_empty' as const },
  )
  const { runRoot, rows } = await buildFixtureRun(expected, specs)
  try {
    const report = await evaluateH10ClipsegRun({
      runRoot,
      mode: 'synthetic-fixture',
      expectedRows: expected,
      rows,
    })
    const row0 = report.perRow.find((row) => row.row_index === 0)
    assert.ok(row0)
    assert.equal(row0.wholeObjectMatched, false)
    assert.equal(row0.positiveSuccess, false)
    assert.equal(report.gate.cleanPass, false)
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})

await test('expectedManifestRowsMatch detects order and authorship drift', () => {
  const expected = syntheticExpectedRows()
  const drifted = expected.map((row, index) => ({
    row_index: index === 0 ? 1 : index === 1 ? 0 : row.row_index,
    row_key: row.row_key,
    source_path: `/tmp/${row.row_key}.png`,
    authored_target: index === 2 ? 'changed' : row.authored_target,
    source_sha256: row.expectedSourceSha256,
  }))
  const errors = expectedManifestRowsMatch(expected, drifted)
  assert.ok(errors.some((item) => item.includes('manifest-row-key-0')))
  assert.ok(errors.some((item) => item.includes('manifest-authored-target-2')))
})

await test('foregroundBoundsToBox uses inclusive max coordinates', () => {
  const box = foregroundBoundsToBox({ x_min: 3, y_min: 4, x_max: 10, y_max: 12 })
  assert.deepEqual(box, { left: 3, top: 4, width: 8, height: 9 })
})

await test('validateApprovedContractShape rejects stale oriented_source_sha256 requirement', () => {
  const errors = validateApprovedContractShape({
    schema: 'v03-h10-clipseg-producer-contract-v1',
    processor: { class: 'CLIPSegProcessor' },
    model_conditioning_payload: { fields: ['oriented_source_rgb', 'authored_target_string'] },
    row_output: {
      required_fields: [
        'source_sha256',
        'oriented_source_sha256',
        'oriented_rgb_sha256',
        'authored_target',
      ],
    },
  })
  assert.ok(errors.includes('contract-stale-oriented_source_sha256-required'))
})

await test('validateApprovedContractShape rejects contract missing model_max_length required field', () => {
  const errors = validateApprovedContractShape({
    schema: 'v03-h10-clipseg-producer-contract-v1',
    processor: { class: 'CLIPSegProcessor' },
    model_conditioning_payload: { fields: ['oriented_source_rgb', 'authored_target_string'] },
    row_output: {
      required_fields: ['source_sha256', 'oriented_rgb_sha256', 'authored_target'],
    },
  })
  assert.ok(errors.includes('contract-required-field-absent-model_max_length'))
})

await test('compareLockedManifestToFreezeRows detects path and SHA drift', () => {
  const base = {
    row_index: 0,
    row_key: 'fixture-00',
    source_path: '/tmp/source-0.png',
    authored_target: 'target-0',
    source_sha256: 'a'.repeat(64),
  }
  const locked = Array.from({ length: 12 }, (_, index) => ({ ...base, row_index: index }))
  const drifted = locked.map((row, index) =>
    index === 2 ? { ...row, source_path: '/tmp/other.png', source_sha256: 'b'.repeat(64) } : row,
  )
  const errors = compareLockedManifestToFreezeRows(locked, drifted)
  assert.ok(errors.includes('manifest-freeze-row-drift-2'))
})

await test('verifyScriptPathHash rejects tampered script bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-h10-script-'))
  const scriptPath = join(root, 'worker.py')
  await writeFile(scriptPath, '# worker\n', 'utf8')
  const digest = createHash('sha256')
    .update(await readFile(scriptPath))
    .digest('hex')
  const ok = await verifyScriptPathHash(scriptPath, digest, 'worker')
  assert.equal(ok.length, 0)
  const bad = await verifyScriptPathHash(scriptPath, '0'.repeat(64), 'worker')
  assert.ok(bad.includes('worker-script-sha256-mismatch'))
  await rm(root, { recursive: true, force: true })
})

await test('verifyRunDeviceAndFreezePath rejects device and freeze path mismatch', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'zorya-h10-run-link-'))
  const freezePath = join(runRoot, 'freeze.json')
  const otherFreezePath = join(runRoot, 'other-freeze.json')
  await writeFile(freezePath, '{}', 'utf8')
  await writeFile(otherFreezePath, '{}', 'utf8')
  const errors: string[] = []
  await verifyRunDeviceAndFreezePath(
    runRoot,
    {
      schema: 'v03-h10-clipseg-freeze-v1',
      requested_device: H10_REAL_RUN_DEVICE,
    } as never,
    {
      schema: 'v03-h10-clipseg-run-v1',
      device: 'cpu',
      freeze_path: otherFreezePath,
    } as never,
    errors,
  )
  assert.ok(errors.includes('run-device-mismatch'))
  assert.ok(errors.includes('run-freeze-path-mismatch'))
  await rm(runRoot, { recursive: true, force: true })
})

await test('verifyEmittedMaskInventory rejects stray and missing mask files', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'zorya-h10-mask-inv-'))
  const masksDir = join(runRoot, 'masks')
  await mkdir(masksDir, { recursive: true })
  const maskPath = join(masksDir, 'fixture-00.png')
  await writeFile(maskPath, Buffer.from([0]), 'utf8')
  await writeFile(join(masksDir, 'stray.png'), Buffer.from([0]), 'utf8')
  const errors: string[] = []
  await verifyEmittedMaskInventory(
    runRoot,
    [
      {
        row_index: 0,
        row_key: 'fixture-00',
        authored_target: 'target',
        outcome_kind: 'candidate',
        source_width: 10,
        source_height: 10,
        source_sha256: 'a'.repeat(64),
        mask_path: maskPath,
      },
    ] as never,
    errors,
  )
  assert.ok(errors.some((item) => item.startsWith('stray-mask-file-')))
  await rm(runRoot, { recursive: true, force: true })
})

await test('verifyEmittedMaskInventory rejects nested stray mask files', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'zorya-h10-mask-nested-'))
  const masksDir = join(runRoot, 'masks')
  const nestedDir = join(masksDir, 'nested')
  await mkdir(nestedDir, { recursive: true })
  const maskPath = join(masksDir, 'fixture-00.png')
  await writeFile(maskPath, Buffer.from([0]), 'utf8')
  await writeFile(join(nestedDir, 'stray.png'), Buffer.from([0]), 'utf8')
  const errors: string[] = []
  await verifyEmittedMaskInventory(
    runRoot,
    [
      {
        row_index: 0,
        row_key: 'fixture-00',
        authored_target: 'target',
        outcome_kind: 'candidate',
        source_width: 10,
        source_height: 10,
        source_sha256: 'a'.repeat(64),
        mask_path: maskPath,
      },
    ] as never,
    errors,
  )
  assert.ok(errors.includes('masks-nested-directory-nested'))
  assert.ok(errors.some((item) => item.startsWith('stray-mask-file-')))
  await rm(runRoot, { recursive: true, force: true })
})

await test('verifyEffectiveProcessorSnapshot rejects false do_rescale and do_normalize', () => {
  const base = validEffectiveProcessorSnapshot()
  assert.deepEqual(verifyEffectiveProcessorSnapshot(base), [])
  assert.ok(
    verifyEffectiveProcessorSnapshot({ ...base, do_rescale: false as never }).includes(
      'effective-processor-do-rescale',
    ),
  )
  assert.ok(
    verifyEffectiveProcessorSnapshot({ ...base, do_normalize: false as never }).includes(
      'effective-processor-do-normalize',
    ),
  )
})

await test('resolveMaskPathWithinRunRoot accepts absolute paths inside runRoot', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'zorya-h10-abs-mask-'))
  const masksDir = join(runRoot, 'masks')
  await mkdir(masksDir, { recursive: true })
  const maskPath = join(masksDir, 'abs.png')
  await writeFile(maskPath, Buffer.from([0]), 'utf8')
  const resolved = await resolveMaskPathWithinRunRoot(runRoot, maskPath)
  assert.equal(resolved, await realpath(maskPath))
  await rm(runRoot, { recursive: true, force: true })
})

await test('H10 evaluator rejects wrong source_width against pilot dimensions', async () => {
  const expected = syntheticExpectedRows()
  const specs: RowSpec[] = expected.map((row) =>
    row.row_index === 1
      ? { outcome_kind: 'unresolved_empty' as const }
      : { outcome_kind: 'unresolved_empty' as const },
  )
  const { runRoot, rows } = await buildFixtureRun(expected, specs)
  const row1 = rows.find((row) => row.row_index === 1)
  assert.ok(row1)
  row1.source_width = expected[1]?.sourceWidth === CANVAS ? CANVAS - 1 : CANVAS
  try {
    const report = await evaluateH10ClipsegRun({
      runRoot,
      mode: 'synthetic-fixture',
      expectedRows: expected,
      rows,
    })
    assert.equal(report.gate.cleanPass, false)
    assert.ok(report.integrityErrors.some((item) => item.includes('source-dimensions-mismatch')))
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})

await test('verifyAssetDirectoryOnDisk rejects symlink escape from asset root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-h10-asset-symlink-'))
  const assetDir = join(root, 'assets')
  const outside = join(root, 'outside-config.json')
  await mkdir(assetDir, { recursive: true })
  await writeFile(outside, '{"outside":true}', 'utf8')
  await symlink(outside, join(assetDir, 'config.json'))
  const errors: string[] = []
  await verifyAssetDirectoryOnDisk(assetDir, errors)
  assert.ok(errors.some((item) => item.includes('asset-bytes-mismatch-config.json')))
  await rm(root, { recursive: true, force: true })
})

await test('dev-run mode rejects injected rows seam', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'zorya-h10-dev-run-'))
  try {
    const report = await evaluateH10ClipsegRun({
      runRoot,
      mode: 'dev-run',
      rows: [],
    })
    assert.equal(report.gate.cleanPass, false)
    assert.ok(report.integrityErrors.includes('dev-run-rejects-injected-rows'))
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})

await test('dev-run rejects injected truth and expectedRows without altering gate', async () => {
  const expected = syntheticExpectedRows()
  const specs: RowSpec[] = expected.map((row) =>
    row.presence === 'absent'
      ? { outcome_kind: 'unresolved_empty' }
      : {
          outcome_kind: 'candidate',
          paint: (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30,
        },
  )
  const { runRoot } = await buildFixtureRun(expected, specs)
  const forgedExpected = expected.map((row) => ({
    ...row,
    presence: 'absent' as const,
    referenceBoxes: [],
  }))
  try {
    const baseline = await evaluateH10ClipsegRun({ runRoot, mode: 'dev-run' })
    const injected = await evaluateH10ClipsegRun({
      runRoot,
      mode: 'dev-run',
      truth: [],
      expectedRows: forgedExpected,
    })
    assert.equal(injected.gate.cleanPass, false)
    assert.ok(injected.integrityErrors.includes('dev-run-rejects-injected-truth'))
    assert.ok(injected.integrityErrors.includes('dev-run-rejects-injected-expected-rows'))
    assert.equal(injected.gate.positiveSuccesses, baseline.gate.positiveSuccesses)
    assert.equal(injected.gate.falseOutputs, baseline.gate.falseOutputs)
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})

const SYNTHETIC_CUDA_VERSION = '12.4'

function syntheticProducerRuntimeReceipt() {
  return {
    python_executable: '/tmp/synthetic-h10/.venv/bin/python',
    python_version: '3.12.7',
    torch: '2.6.0+cu124',
    transformers: '4.57.3',
    pillow: '11.1.0',
    numpy: '2.2.3',
    platform: 'Linux-6.6.87.2-microsoft-standard-WSL2-x86_64-with-glibc2.39',
    cuda_available: true as const,
    cuda_version: SYNTHETIC_CUDA_VERSION,
    cuda_device: {
      cuda_available: true as const,
      cuda_device_index: 0,
      cuda_device_name: 'Synthetic Offline GPU',
      cuda_version: SYNTHETIC_CUDA_VERSION,
    },
  }
}

function syntheticProducerRunRecord(workerScriptSha256: string) {
  return {
    schema: 'v03-h10-clipseg-run-v1' as const,
    status: 'completed',
    freeze_path: '/tmp/synthetic-h10/freeze.json',
    freeze_sha256: createHash('sha256').update('synthetic-freeze').digest('hex'),
    manifest_sha256: MINIMAL_DEV_MANIFEST_SHA256,
    contract_sha256: createHash('sha256').update('synthetic-contract').digest('hex'),
    worker_script_sha256: workerScriptSha256,
    device: H10_REAL_RUN_DEVICE,
    cuda_runtime: {
      cuda_available: true as const,
      cuda_device_index: 0,
      cuda_device_name: 'Synthetic Offline GPU',
      cuda_version: SYNTHETIC_CUDA_VERSION,
    },
    load_ms: 120.5,
    wall_ms: 45_000.25,
    worker_pid: 42_424,
    worker_stderr_tail: 'synthetic stderr tail (offline fixture only)',
    row_count: 12,
  }
}

function syntheticProducerFreezeRecord(workerScriptSha256: string) {
  return {
    schema: 'v03-h10-clipseg-freeze-v1' as const,
    manifest_path: '/tmp/synthetic-h10/manifest.json',
    manifest_sha256: MINIMAL_DEV_MANIFEST_SHA256,
    contract_path: '/tmp/synthetic-h10/contract.json',
    contract_sha256: createHash('sha256').update('synthetic-contract').digest('hex'),
    asset_dir: '/tmp/synthetic-h10/assets',
    asset_receipts: {},
    rows: [],
    recipe: {
      interpolate_pos_encoding: true as const,
      threshold: 'logit >= 0' as const,
      logits_grid: 352 as const,
      max_encoded_bytes: 25_165_824 as const,
      max_oriented_pixels: 2_097_152 as const,
    },
    preprocessor_on_disk: {
      preprocessor_config_sha256: createHash('sha256').update('preprocessor').digest('hex'),
    },
    effective_processor: validEffectiveProcessorSnapshot(),
    runtime: syntheticProducerRuntimeReceipt(),
    worker_script_sha256: workerScriptSha256,
    runner_script_sha256: createHash('sha256').update('runner').digest('hex'),
    common_script_sha256: createHash('sha256').update('common').digest('hex'),
    worker_script_path: '/tmp/synthetic-h10/worker.py',
    runner_script_path: '/tmp/synthetic-h10/runner.py',
    common_script_path: '/tmp/synthetic-h10/common.py',
    requested_device: H10_REAL_RUN_DEVICE,
  }
}

await test('freezeRuntimeSchema accepts producer-shaped runtime and rejects malformed receipts', () => {
  const valid = syntheticProducerRuntimeReceipt()
  assert.doesNotThrow(() => freezeRuntimeSchema.parse(valid))
  assert.deepEqual(verifyCudaDevRunReceiptConsistency(valid, valid.cuda_device), [])
  assert.throws(() => freezeRuntimeSchema.parse({ ...valid, python_version: '' }))
  const cudaFlagMismatch = {
    ...valid,
    cuda_device: { cuda_available: false as const },
  }
  freezeRuntimeSchema.parse(cudaFlagMismatch)
  assert.ok(
    verifyCudaDevRunReceiptConsistency(cudaFlagMismatch, valid.cuda_device).includes(
      'freeze-runtime-cuda-available-flag-mismatch',
    ),
  )
  const falseCuda = {
    ...valid,
    cuda_available: false as const,
    cuda_version: '',
    cuda_device: { cuda_available: false as const },
  }
  freezeRuntimeSchema.parse(falseCuda)
  assert.ok(
    verifyCudaDevRunReceiptConsistency(falseCuda, valid.cuda_device).includes(
      'freeze-runtime-cuda-unavailable',
    ),
  )
  const wrongIndex = {
    ...valid,
    cuda_device: { ...valid.cuda_device, cuda_device_index: 1 },
  }
  assert.ok(
    verifyCudaDevRunReceiptConsistency(wrongIndex, valid.cuda_device).includes(
      'freeze-cuda-device-index-not-zero',
    ),
  )
  const versionDrift = {
    ...valid,
    cuda_device: { ...valid.cuda_device, cuda_version: '12.5' },
  }
  assert.ok(
    verifyCudaDevRunReceiptConsistency(versionDrift, valid.cuda_device).includes(
      'cuda-version-freeze-receipt-device-mismatch',
    ),
  )
  const runMismatch = {
    ...valid.cuda_device,
    cuda_version: '12.5',
  }
  assert.ok(
    verifyCudaDevRunReceiptConsistency(valid, runMismatch).includes(
      'cuda-version-freeze-device-run-mismatch',
    ),
  )
})

await test('runSchema accepts synthetic producer-shaped run.json and freeze bindings', () => {
  const workerDigest = createHash('sha256').update('synthetic-worker-script').digest('hex')
  const runRecord = runSchema.parse(syntheticProducerRunRecord(workerDigest))
  const freezeRecord = syntheticProducerFreezeRecord(workerDigest)
  assert.deepEqual(verifyRunRecordProducerBindings(runRecord, freezeRecord as never), [])
  assert.equal(runRecord.worker_script_sha256, freezeRecord.worker_script_sha256)
  assert.equal(runRecord.manifest_sha256, MINIMAL_DEV_MANIFEST_SHA256)
})

await test('verifyRunRecordProducerBindings rejects worker_script_sha256 mismatch', () => {
  const workerDigest = createHash('sha256').update('synthetic-worker-script').digest('hex')
  const runRecord = runSchema.parse(syntheticProducerRunRecord(workerDigest))
  const freezeRecord = syntheticProducerFreezeRecord(
    createHash('sha256').update('different-worker-script').digest('hex'),
  )
  const errors = verifyRunRecordProducerBindings(runRecord, freezeRecord as never)
  assert.ok(errors.includes('run-worker-script-sha256-mismatch'))
})

await test('runSchema rejects oversize worker_stderr_tail and invalid cuda_runtime', () => {
  const workerDigest = createHash('sha256').update('synthetic-worker-script').digest('hex')
  const base = syntheticProducerRunRecord(workerDigest)
  assert.throws(() =>
    runSchema.parse({
      ...base,
      worker_stderr_tail: 'x'.repeat(16_385),
    }),
  )
  assert.throws(() =>
    runSchema.parse({
      ...base,
      cuda_runtime: { cuda_available: true, cuda_device_index: 0 },
    }),
  )
  assert.throws(() =>
    runSchema.parse({
      ...base,
      load_ms: Number.NaN,
    }),
  )
})

await test('dev-run rejects injected freeze and run without altering gate', async () => {
  const expected = syntheticExpectedRows()
  const specs: RowSpec[] = expected.map(() => ({ outcome_kind: 'unresolved_empty' as const }))
  const { runRoot } = await buildFixtureRun(expected, specs)
  try {
    const baseline = await evaluateH10ClipsegRun({ runRoot, mode: 'dev-run' })
    const injected = await evaluateH10ClipsegRun({
      runRoot,
      mode: 'dev-run',
      freeze: { schema: 'v03-h10-clipseg-freeze-v1', row_count: 12 },
      run: { schema: 'v03-h10-clipseg-run-v1', status: 'completed' },
    })
    assert.equal(injected.gate.cleanPass, false)
    assert.ok(injected.integrityErrors.includes('dev-run-rejects-injected-freeze'))
    assert.ok(injected.integrityErrors.includes('dev-run-rejects-injected-run'))
    assert.equal(injected.gate.positiveSuccesses, baseline.gate.positiveSuccesses)
    assert.equal(injected.gate.falseOutputs, baseline.gate.falseOutputs)
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})
