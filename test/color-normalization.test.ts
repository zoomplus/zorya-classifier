import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildComponentCutout,
  componentBinaryMask,
  compressComponentMap,
  computeComponentIds,
  controlRgbKey,
  decompressComponentMap,
  encodeComponentMap,
  COMPONENT_MAP_MAGIC,
  COMPONENT_MAP_PROFILE_CONTROL_RGB,
  COMPONENT_MAP_PROFILE_HSV12,
  normalizePixelHsv12,
  processColorNormalizationImage,
  rgbToHsv,
} from '../benchmarks/experiments/color-normalization-v1.js'
import {
  COLOR_NORMALIZATION_ACHROMATIC_SATURATION_BELOW,
  COLOR_NORMALIZATION_ACHROMATIC_WHITE_VALUE_AT_LEAST,
  COLOR_NORMALIZATION_BLACK_VALUE_BELOW,
  COLOR_NORMALIZATION_BOX_COVERAGE_GATE,
  COLOR_NORMALIZATION_BOX_IOU_GATE,
  COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS,
  COLOR_NORMALIZATION_MAX_ENCODED_BYTES,
  COLOR_NORMALIZATION_MAX_PIXELS,
  COLOR_NORMALIZATION_PRODUCER_INPUTS_SHA256,
  COLOR_NORMALIZATION_PROFILE_ID,
  COLOR_NORMALIZATION_PROSPECTIVE_FREEZE_SHA256,
  COLOR_NORMALIZATION_RUN_DEADLINE_MS,
  COLOR_NORMALIZATION_RUN_SCHEMA,
  COLOR_NORMALIZATION_SOURCE_COMMIT,
  colorNormalizationProducerInputsSchema,
  colorNormalizationRunManifestSchema,
} from '../benchmarks/v03/color-normalization-contract.js'
import { binaryMaskIoU } from '../benchmarks/v02/metrics.js'
import sharp from 'sharp'
import {
  auditColorNormalizationComponents,
  decodeBinaryMaskFromRaw,
  loadBinaryMask,
  scoreBestActualMaskAmongComponents,
  summarizeProfileBoxAudits,
  verifyEncodedReferenceMaskSha256,
} from '../benchmarks/v03/evaluate-color-normalization.js'
import {
  assertColorNormalizationRunContinues,
  runColorNormalizationProducer,
  writeColorNormalizationCompleteManifest,
  writeColorNormalizationFailureManifest,
} from '../benchmarks/v03/run-color-normalization.js'

function rgba(
  width: number,
  height: number,
  paint: (x: number, y: number, data: Uint8Array, index: number) => void,
): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      paint(x, y, data, index)
    }
  }
  return { data, width, height }
}

await test('hue bin uses circular nearest center with wraparound', () => {
  const hue350 = rgbToHsv(255, 0, 40)
  const hue10 = rgbToHsv(255, 40, 0)
  assert.ok(hue350.hueDegrees > 330)
  assert.ok(hue10.hueDegrees < 20)
  assert.deepEqual(normalizePixelHsv12(255, 0, 40), normalizePixelHsv12(255, 40, 0))
})

await test('achromatic and black thresholds follow the frozen recipe', () => {
  assert.deepEqual(normalizePixelHsv12(10, 10, 10), [0, 0, 0])
  const justAboveBlack = normalizePixelHsv12(30, 28, 40)
  assert.notDeepEqual(justAboveBlack, [0, 0, 0])
  const gray = normalizePixelHsv12(120, 122, 118)
  assert.deepEqual(gray, [128, 128, 128])
  const white = normalizePixelHsv12(240, 242, 250)
  assert.deepEqual(white, [255, 255, 255])
  assert.ok(COLOR_NORMALIZATION_BLACK_VALUE_BELOW === 0.15)
  assert.ok(COLOR_NORMALIZATION_ACHROMATIC_SATURATION_BELOW === 0.2)
  assert.ok(COLOR_NORMALIZATION_ACHROMATIC_WHITE_VALUE_AT_LEAST === 0.75)
})

await test('processColorNormalizationImage does not mutate the caller buffer', () => {
  const view = rgba(3, 2, (x, y, data, index) => {
    const offset = index * 4
    data[offset] = 20 + x * 40
    data[offset + 1] = 30 + y * 20
    data[offset + 2] = 100
    data[offset + 3] = 255
  })
  const before = Uint8Array.from(view.data)
  processColorNormalizationImage(view)
  assert.deepEqual([...view.data], [...before])
})

await test('pixel indices follow y*width+x in portrait and landscape layouts', () => {
  const landscape = rgba(4, 2, (x, y, data, index) => {
    assert.equal(index, y * 4 + x)
    const offset = index * 4
    data[offset] = x === 1 && y === 0 ? 200 : 10
    data[offset + 1] = 10
    data[offset + 2] = 10
    data[offset + 3] = 255
  })
  const portrait = rgba(2, 4, (x, y, data, index) => {
    assert.equal(index, y * 2 + x)
    const offset = index * 4
    data[offset] = x === 0 && y === 3 ? 200 : 10
    data[offset + 1] = 10
    data[offset + 2] = 10
    data[offset + 3] = 255
  })
  const land = processColorNormalizationImage(landscape)
  const port = processColorNormalizationImage(portrait)
  assert.equal(land.controlComponentIds[1], 2)
  assert.equal(port.controlComponentIds[6], 2)
})

await test('alpha zero pixels stay disconnected and preserve alpha in normalized output', () => {
  const view = rgba(3, 1, (x, _y, data, index) => {
    const offset = index * 4
    data[offset] = 200
    data[offset + 1] = 10
    data[offset + 2] = 10
    data[offset + 3] = x === 1 ? 0 : 255
  })
  const processed = processColorNormalizationImage(view)
  assert.equal(processed.controlComponentIds[1], 0)
  assert.ok(processed.controlComponentIds[0]! > 0)
  assert.ok(processed.controlComponentIds[2]! > 0)
  assert.notEqual(
    processed.controlComponentIds[0],
    processed.controlComponentIds[2],
    'alpha=0 must not connect neighboring same-color pixels',
  )
  assert.equal(processed.normalizedRgba[4 * 1 + 3], 0)
  assert.equal(processed.normalizedRgba[4 * 0 + 3], 255)
  assert.equal(processed.normalizedRgba[4 * 1], 200)
  assert.equal(processed.normalizedRgba[4 * 1 + 1], 10)
})

await test('HSV12 merges neighboring shades that stay separate in exact RGB control', () => {
  const view = rgba(2, 1, (x, _y, data, index) => {
    const offset = index * 4
    data[offset] = x === 0 ? 210 : 220
    data[offset + 1] = 10
    data[offset + 2] = 10
    data[offset + 3] = 255
  })
  const processed = processColorNormalizationImage(view)
  assert.equal(processed.stats.controlRgb.componentCount, 2)
  assert.equal(processed.stats.hsv12.componentCount, 1)
  assert.ok(processed.stats.hsv12.changedAdjacentEdgesVsSourceRgb >= 1)
})

function assertCutoutPreservesSource(
  source: Uint8Array,
  cutout: Uint8Array,
  labels: Uint32Array,
  componentId: number,
  width: number,
  height: number,
): void {
  assert.equal(cutout.byteLength, width * height * 4)
  assert.equal(cutout.byteLength, source.byteLength)
  for (let index = 0; index < labels.length; index += 1) {
    const offset = index * 4
    if (labels[index] === componentId) {
      assert.equal(cutout[offset]!, source[offset]!)
      assert.equal(cutout[offset + 1]!, source[offset + 1]!)
      assert.equal(cutout[offset + 2]!, source[offset + 2]!)
      assert.equal(cutout[offset + 3]!, source[offset + 3]!)
    } else {
      assert.equal(cutout[offset + 3], 0)
    }
  }
}

await test('component cutout keeps original RGB and alpha in landscape and portrait', () => {
  const landscape = rgba(4, 2, (x, y, data, index) => {
    const offset = index * 4
    data[offset] = x === 1 && y === 1 ? 90 : 200
    data[offset + 1] = 50 + y * 10
    data[offset + 2] = 120
    data[offset + 3] = 255
  })
  const portrait = rgba(2, 4, (x, y, data, index) => {
    const offset = index * 4
    data[offset] = x === 0 && y === 2 ? 90 : 200
    data[offset + 1] = 50 + y * 10
    data[offset + 2] = 120
    data[offset + 3] = 255
  })
  for (const view of [landscape, portrait]) {
    const processed = processColorNormalizationImage(view)
    const targetId = processed.controlComponentIds[view.width + 1]!
    assert.ok(targetId > 0)
    const cutout = buildComponentCutout(
      view.data,
      view.width,
      view.height,
      processed.controlComponentIds,
      targetId,
    )
    assertCutoutPreservesSource(
      view.data,
      cutout,
      processed.controlComponentIds,
      targetId,
      view.width,
      view.height,
    )
  }
})

await test('component cutout keeps original RGB inside the chosen component only', () => {
  const view = rgba(2, 2, (x, y, data, index) => {
    const offset = index * 4
    data[offset] = x === 0 ? 90 : 200
    data[offset + 1] = y === 0 ? 50 : 180
    data[offset + 2] = 120
    data[offset + 3] = 255
  })
  const processed = processColorNormalizationImage(view)
  const targetId = processed.controlComponentIds[0]!
  assert.ok(targetId > 0)
  const cutout = buildComponentCutout(
    view.data,
    view.width,
    view.height,
    processed.controlComponentIds,
    targetId,
  )
  for (let index = 0; index < 4; index += 1) {
    if (processed.controlComponentIds[index] === targetId) {
      assert.equal(cutout[index * 4]!, view.data[index * 4])
      assert.equal(cutout[index * 4 + 3]!, view.data[index * 4 + 3])
    } else {
      assert.equal(cutout[index * 4 + 3], 0)
    }
  }
})

await test('component map encoding round-trips with portable little-endian layout', () => {
  const view = rgba(2, 2, (x, y, data, index) => {
    const offset = index * 4
    data[offset] = x === y ? 250 : 20
    data[offset + 1] = 30
    data[offset + 2] = 40
    data[offset + 3] = 255
  })
  const processed = processColorNormalizationImage(view)
  const encoded = compressComponentMap(
    encodeComponentMap(
      COMPONENT_MAP_PROFILE_HSV12,
      view.width,
      view.height,
      processed.hsv12ComponentIds,
    ),
  )
  const decoded = decompressComponentMap(encoded)
  assert.equal(decoded.profile, COMPONENT_MAP_PROFILE_HSV12)
  assert.deepEqual([...decoded.labels], [...processed.hsv12ComponentIds])
})

await test('connected components use 4-neighbor connectivity with exact RGB keys', () => {
  const view = rgba(3, 3, (x, y, data, index) => {
    const offset = index * 4
    const red = x === 1 && y === 1 ? 50 : 200
    data[offset] = red
    data[offset + 1] = red
    data[offset + 2] = red
    data[offset + 3] = red === 50 ? 255 : 255
  })
  const labels = computeComponentIds(view, (_index, red, green, blue) =>
    controlRgbKey(red, green, blue),
  )
  assert.equal(labels[4], 2)
  assert.equal(labels[0], 1)
  assert.notEqual(labels[0], labels[4])
})

await test('frozen producer contract pins the expected cohort hash and row count', () => {
  assert.equal(COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS.length, 12)
  const parsed = colorNormalizationProducerInputsSchema.parse(
    COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS,
  )
  assert.equal(parsed.length, 12)
  assert.equal(COLOR_NORMALIZATION_PRODUCER_INPUTS_SHA256.length, 64)
  assert.ok(COLOR_NORMALIZATION_MAX_PIXELS > 0)
  assert.ok(COLOR_NORMALIZATION_MAX_ENCODED_BYTES > 0)
})

function syntheticCompressedComponentMap(
  width: number,
  height: number,
  labelValues: readonly number[],
  profile: typeof COMPONENT_MAP_PROFILE_CONTROL_RGB = COMPONENT_MAP_PROFILE_CONTROL_RGB,
): Uint8Array {
  const body = Buffer.allocUnsafe(COMPONENT_MAP_MAGIC.length + 9 + labelValues.length * 4)
  COMPONENT_MAP_MAGIC.copy(body, 0)
  body[COMPONENT_MAP_MAGIC.length] = profile
  body.writeUInt32LE(width, COMPONENT_MAP_MAGIC.length + 1)
  body.writeUInt32LE(height, COMPONENT_MAP_MAGIC.length + 5)
  for (let index = 0; index < labelValues.length; index += 1) {
    body.writeUInt32LE(labelValues[index]!, COMPONENT_MAP_MAGIC.length + 9 + index * 4)
  }
  return compressComponentMap(new Uint8Array(body))
}

await test('component map rejects malformed dimensions', () => {
  assert.throws(() =>
    encodeComponentMap(COMPONENT_MAP_PROFILE_CONTROL_RGB, 0, 1, new Uint32Array(0)),
  )
  assert.throws(() => decompressComponentMap(new Uint8Array([0, 1, 2, 3])))
})

await test('component map decompress rejects oversized gzip and corrupt payloads', () => {
  const maxDecompressed = COMPONENT_MAP_MAGIC.length + 9 + COLOR_NORMALIZATION_MAX_PIXELS * 4
  const oversizedPlain = Buffer.alloc(maxDecompressed + 1, 0)
  oversizedPlain.set(COMPONENT_MAP_MAGIC, 0)
  oversizedPlain[COMPONENT_MAP_MAGIC.length] = COMPONENT_MAP_PROFILE_CONTROL_RGB
  oversizedPlain.writeUInt32LE(1, COMPONENT_MAP_MAGIC.length + 1)
  oversizedPlain.writeUInt32LE(1, COMPONENT_MAP_MAGIC.length + 5)
  assert.throws(() => decompressComponentMap(new Uint8Array(gzipSync(oversizedPlain))))
  assert.throws(() => decompressComponentMap(new Uint8Array(gzipSync(Buffer.from('not-a-map')))))

  const shortBody = Buffer.alloc(COMPONENT_MAP_MAGIC.length + 9 + 3 * 4)
  COMPONENT_MAP_MAGIC.copy(shortBody, 0)
  shortBody[COMPONENT_MAP_MAGIC.length] = COMPONENT_MAP_PROFILE_CONTROL_RGB
  shortBody.writeUInt32LE(2, COMPONENT_MAP_MAGIC.length + 1)
  shortBody.writeUInt32LE(2, COMPONENT_MAP_MAGIC.length + 5)
  for (let index = 0; index < 3; index += 1) {
    shortBody.writeUInt32LE(index + 1, COMPONENT_MAP_MAGIC.length + 9 + index * 4)
  }
  assert.throws(
    () => decompressComponentMap(compressComponentMap(new Uint8Array(shortBody))),
    (error: unknown) =>
      error instanceof RangeError && error.message === 'component map byte length mismatch',
  )
})

await test('component map rejects out-of-range label values', () => {
  assert.throws(
    () => decompressComponentMap(syntheticCompressedComponentMap(2, 2, [0, 1, 2, 5])),
    (error: unknown) =>
      error instanceof RangeError && error.message === 'component map label out of range',
  )
  const valid = syntheticCompressedComponentMap(2, 2, [0, 1, 2, 4])
  const decoded = decompressComponentMap(valid)
  assert.deepEqual([...decoded.labels], [0, 1, 2, 4])
})

await test('component audits follow label-first order without sorting component ids', () => {
  const width = 4
  const height = 1
  const labels = new Uint32Array(width * height)
  labels[3] = 9
  labels[1] = 3
  labels[0] = 7
  const audits = auditColorNormalizationComponents(labels, width, height, [])
  assert.deepEqual(
    audits.map((audit) => audit.componentId),
    [7, 3, 9],
  )
})

await test('best actual mask IoU is profile-specific with label-order tie breaks', () => {
  const width = 4
  const height = 4
  const referenceMask = new Uint8Array(width * height)
  for (let y = 1; y <= 2; y += 1) {
    for (let x = 1; x <= 2; x += 1) referenceMask[y * width + x] = 1
  }

  const controlLabels = new Uint32Array(width * height)
  for (let y = 1; y <= 2; y += 1) {
    for (let x = 1; x <= 2; x += 1) controlLabels[y * width + x] = 1
  }
  controlLabels[0] = 2
  controlLabels[15] = 2

  const hsvLabels = new Uint32Array(width * height)
  hsvLabels[5] = 1
  hsvLabels[6] = 1
  hsvLabels[5] = 2
  hsvLabels[6] = 2
  hsvLabels[9] = 2
  hsvLabels[0] = 3

  const controlOrder = auditColorNormalizationComponents(controlLabels, width, height, []).map(
    (audit) => audit.componentId,
  )
  const hsvOrder = auditColorNormalizationComponents(hsvLabels, width, height, []).map(
    (audit) => audit.componentId,
  )
  const controlBest = scoreBestActualMaskAmongComponents(
    controlLabels,
    width,
    height,
    referenceMask,
    controlOrder,
  )
  const hsvBest = scoreBestActualMaskAmongComponents(
    hsvLabels,
    width,
    height,
    referenceMask,
    hsvOrder,
  )
  assert.ok(controlBest)
  assert.ok(hsvBest)
  assert.equal(controlBest.componentId, 1)
  assert.equal(hsvBest.componentId, 2)
  assert.ok(controlBest.iou > hsvBest.iou)
  assert.equal(controlBest.iou, 1)
  assert.ok(hsvBest.iou < 1)
  assert.equal(controlBest.matched, controlBest.iou >= 0.8)
  assert.equal(hsvBest.matched, hsvBest.iou >= 0.8)

  const tieLabels = new Uint32Array(width * height)
  tieLabels[5] = 1
  tieLabels[6] = 1
  tieLabels[9] = 2
  tieLabels[10] = 2
  const tieOrder = auditColorNormalizationComponents(tieLabels, width, height, []).map(
    (audit) => audit.componentId,
  )
  const tieBest = scoreBestActualMaskAmongComponents(
    tieLabels,
    width,
    height,
    referenceMask,
    tieOrder,
  )
  assert.ok(tieBest)
  assert.equal(tieBest.componentId, 1)
  const comp1IoU = binaryMaskIoU(
    componentBinaryMask(tieLabels, width, height, 1),
    referenceMask,
  ).iou
  const comp2IoU = binaryMaskIoU(
    componentBinaryMask(tieLabels, width, height, 2),
    referenceMask,
  ).iou
  assert.equal(comp1IoU, comp2IoU)
  assert.equal(tieBest.iou, comp1IoU)
})

await test('verifyEncodedReferenceMaskSha256 rejects bytes that do not match declared digest', () => {
  const bytes = new Uint8Array([137, 80, 78, 71])
  const declared = createHash('sha256').update(bytes).digest('hex')
  verifyEncodedReferenceMaskSha256(bytes, declared)
  assert.throws(
    () => verifyEncodedReferenceMaskSha256(bytes, '0'.repeat(64)),
    (error: unknown) => error instanceof Error && error.message === 'mask-hash-mismatch',
  )
})

await test('scoreBestActualMaskAmongComponents IoU matches binaryMaskIoU per component', () => {
  const width = 3
  const height = 3
  const referenceMask = new Uint8Array(width * height)
  referenceMask[4] = 1
  referenceMask[5] = 1
  const labels = new Uint32Array(width * height)
  labels[3] = 1
  labels[4] = 1
  labels[7] = 2
  const order = auditColorNormalizationComponents(labels, width, height, []).map(
    (audit) => audit.componentId,
  )
  const best = scoreBestActualMaskAmongComponents(labels, width, height, referenceMask, order)
  assert.ok(best)
  const expectedIoU = binaryMaskIoU(
    componentBinaryMask(labels, width, height, best.componentId),
    referenceMask,
  ).iou
  assert.equal(best.iou, expectedIoU)
  assert.equal(best.componentId, 1)
})

await test('box audit pairs IoU and coverage per reference; highest IoU independent of gate pass', () => {
  const width = 5
  const height = 5
  const labels = new Uint32Array(width * height)
  for (let y = 1; y <= 3; y += 1) {
    for (let x = 1; x <= 3; x += 1) labels[y * width + x] = 1
  }
  labels[0] = 2
  labels[4] = 3
  const references = [{ left: 1, top: 1, width: 3, height: 3 }]
  const audits = auditColorNormalizationComponents(labels, width, height, references)
  const summary = summarizeProfileBoxAudits(audits)
  const comp1 = audits.find((audit) => audit.componentId === 1)!
  assert.ok(comp1.boxAvailabilityPass)
  assert.equal(comp1.highestIoUPair?.referenceIndex, 0)
  assert.equal(comp1.highestIoUPair?.iou, comp1.bestPassingPair?.iou)
  assert.equal(comp1.highestIoUPair?.coverage, comp1.bestPassingPair?.coverage)
  assert.equal(summary.bestPassingComponentId, 1)
  assert.equal(summary.highestIoUComponentId, 1)
  assert.ok((summary.highestBoxIoU ?? 0) >= COLOR_NORMALIZATION_BOX_IOU_GATE)
  assert.ok(
    (summary.highestIoUPairedReferenceCoverage ?? 0) >= COLOR_NORMALIZATION_BOX_COVERAGE_GATE,
  )

  const failLabels = new Uint32Array(width * height)
  failLabels[0] = 1
  const failAudits = auditColorNormalizationComponents(failLabels, width, height, references)
  const failSummary = summarizeProfileBoxAudits(failAudits)
  assert.equal(failSummary.boxAvailabilityPass, false)
  assert.equal(failSummary.bestPassingComponentId, null)
  assert.equal(failSummary.highestIoUComponentId, 1)
  assert.ok((failSummary.highestBoxIoU ?? 0) < COLOR_NORMALIZATION_BOX_IOU_GATE)
})

await test('producer refuses a pre-existing output directory without writing into it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcn-producer-'))
  try {
    const outputDirectory = join(root, 'run-out')
    await mkdir(outputDirectory)
    await assert.rejects(
      async () =>
        runColorNormalizationProducer({
          repositoryRoot: process.cwd(),
          inputsPath: join(root, 'missing-inputs.json'),
          dataRoot: root,
          outputDirectory,
        }),
      (error: unknown) => error instanceof Error && error.message === 'output-exists',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('loadBinaryMask decodes 1-channel grayscale PNG into exact 0/1 pixels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcn-mask-'))
  try {
    const width = 3
    const height = 2
    const raw = Buffer.alloc(width * height)
    raw[1] = 255
    raw[3] = 255
    raw[4] = 255
    const pngBytes = new Uint8Array(
      await sharp(raw, { raw: { width, height, channels: 1 } })
        .png()
        .toBuffer(),
    )
    const declaredSha = createHash('sha256').update(pngBytes).digest('hex')
    const maskPath = join(root, 'mask.png')
    await writeFile(maskPath, pngBytes)
    const mask = await loadBinaryMask(maskPath, width, height, declaredSha)
    assert.deepEqual([...mask], [0, 1, 0, 1, 1, 0])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('loadBinaryMask rejects nonbinary grayscale and color RGB masks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcn-mask-'))
  try {
    const width = 2
    const height = 1
    const nonbinary = new Uint8Array(
      await sharp(Buffer.from([0, 128]), { raw: { width, height, channels: 1 } })
        .png()
        .toBuffer(),
    )
    const nonbinarySha = createHash('sha256').update(nonbinary).digest('hex')
    const nonbinaryPath = join(root, 'nonbinary.png')
    await writeFile(nonbinaryPath, nonbinary)
    await assert.rejects(
      () => loadBinaryMask(nonbinaryPath, width, height, nonbinarySha),
      (error: unknown) => error instanceof Error && error.message === 'mask-nonbinary',
    )

    const color = new Uint8Array(
      await sharp(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]), {
        raw: { width, height, channels: 4 },
      })
        .png()
        .toBuffer(),
    )
    const colorSha = createHash('sha256').update(color).digest('hex')
    const colorPath = join(root, 'color.png')
    await writeFile(colorPath, color)
    await assert.rejects(
      () => loadBinaryMask(colorPath, width, height, colorSha),
      (error: unknown) => error instanceof Error && error.message === 'mask-non-grayscale',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('decodeBinaryMaskFromRaw uses grayscale intensity not alpha alone for foreground', () => {
  const width = 2
  const height = 1
  const rgba = Buffer.from([0, 0, 0, 255, 255, 255, 255, 255])
  const mask = decodeBinaryMaskFromRaw(rgba, 4, width, height)
  assert.deepEqual([...mask], [0, 1])
})

await test('assertColorNormalizationRunContinues rejects expired deadline and cancellation', () => {
  const signal = new AbortController().signal
  assert.throws(
    () =>
      assertColorNormalizationRunContinues({
        deadlineAt: 10,
        signal,
        now: () => 11,
      }),
    (error: unknown) => error instanceof Error && error.message === 'deadline-exceeded',
  )
  const aborted = new AbortController()
  aborted.abort()
  assert.throws(
    () =>
      assertColorNormalizationRunContinues({
        deadlineAt: 100,
        signal: aborted.signal,
        now: () => 0,
      }),
    (error: unknown) => error instanceof Error && error.message === 'aborted',
  )
})

await test('complete manifest write fails after physical settle when guard trips post-write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcn-manifest-'))
  try {
    let tick = 0
    const guard = {
      deadlineAt: 100,
      signal: new AbortController().signal,
      now: () => {
        tick += 1
        return tick === 1 ? 50 : 150
      },
    }
    const manifest = colorNormalizationRunManifestSchema.parse({
      schema: COLOR_NORMALIZATION_RUN_SCHEMA,
      status: 'complete',
      profileId: COLOR_NORMALIZATION_PROFILE_ID,
      prospectiveFreezeSha256: COLOR_NORMALIZATION_PROSPECTIVE_FREEZE_SHA256,
      sourceCommit: COLOR_NORMALIZATION_SOURCE_COMMIT,
      producerInputsSha256: COLOR_NORMALIZATION_PRODUCER_INPUTS_SHA256,
      producerCodeSha256: 'c'.repeat(64),
      dataRoot: root,
      deadlineMs: 120_000,
      rows: [],
      uniqueImages: [],
    })
    await assert.rejects(
      () => writeColorNormalizationCompleteManifest(root, manifest, guard),
      (error: unknown) => error instanceof Error && error.message === 'deadline-exceeded',
    )
    const onDiskComplete = JSON.parse(
      (await readFile(join(root, 'run-manifest.json'))).toString('utf8'),
    )
    assert.equal(onDiskComplete.status, 'complete')
    await writeColorNormalizationFailureManifest(root, {
      ...manifest,
      status: 'failed',
      failure: { code: 'producer-failed', message: 'deadline-exceeded' },
    })
    const onDiskFailed = JSON.parse(
      (await readFile(join(root, 'run-manifest.json'))).toString('utf8'),
    )
    assert.equal(onDiskFailed.status, 'failed')
    colorNormalizationRunManifestSchema.parse(onDiskFailed)
    assert.notEqual(onDiskFailed.status, 'complete')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('producer aborts at first image guard without reading corpus when signal is cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcn-producer-abort-'))
  try {
    const inputsPath = join(root, 'producer-inputs.json')
    await writeFile(
      inputsPath,
      `${JSON.stringify(COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS, null, 2)}\n`,
    )
    const outputDirectory = join(root, 'run-out')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      async () =>
        runColorNormalizationProducer({
          repositoryRoot: process.cwd(),
          inputsPath,
          dataRoot: root,
          outputDirectory,
          signal: controller.signal,
          now: () => 0,
        }),
      (error: unknown) => error instanceof Error && error.message === 'aborted',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('producer rejects expired deadline at first image guard without corpus reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcn-producer-deadline-'))
  try {
    const inputsPath = join(root, 'producer-inputs.json')
    await writeFile(
      inputsPath,
      `${JSON.stringify(COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS, null, 2)}\n`,
    )
    const outputDirectory = join(root, 'run-out')
    let nowCalls = 0
    await assert.rejects(
      async () =>
        runColorNormalizationProducer({
          repositoryRoot: process.cwd(),
          inputsPath,
          dataRoot: root,
          outputDirectory,
          now: () => {
            nowCalls += 1
            return nowCalls === 1 ? 0 : COLOR_NORMALIZATION_RUN_DEADLINE_MS + 1
          },
        }),
      (error: unknown) => error instanceof Error && error.message === 'deadline-exceeded',
    )
    const manifestRaw = await readFile(join(outputDirectory, 'run-manifest.json'), 'utf8').catch(
      () => null,
    )
    assert.ok(manifestRaw)
    const manifest = JSON.parse(manifestRaw!)
    assert.equal(manifest.status, 'failed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('run manifest schema rejects wrong freeze or profile identity', () => {
  const base = {
    schema: COLOR_NORMALIZATION_RUN_SCHEMA,
    status: 'complete' as const,
    profileId: COLOR_NORMALIZATION_PROFILE_ID,
    prospectiveFreezeSha256: COLOR_NORMALIZATION_PROSPECTIVE_FREEZE_SHA256,
    sourceCommit: COLOR_NORMALIZATION_SOURCE_COMMIT,
    producerInputsSha256: COLOR_NORMALIZATION_PRODUCER_INPUTS_SHA256,
    producerCodeSha256: 'a'.repeat(64),
    dataRoot: '/tmp/data',
    deadlineMs: 120_000,
    rows: [],
    uniqueImages: [],
  }
  assert.throws(() =>
    colorNormalizationRunManifestSchema.parse({
      ...base,
      prospectiveFreezeSha256: 'b'.repeat(64),
    }),
  )
  assert.throws(() =>
    colorNormalizationRunManifestSchema.parse({
      ...base,
      profileId: 'other-profile',
    }),
  )
})
