import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { z } from 'zod'
import { wholeObjectMatch } from '../v02/metrics.js'
import type { Box } from '../v02/metrics.js'
import {
  buildComponentCutout,
  COMPONENT_MAP_PROFILE_CONTROL_RGB,
  COMPONENT_MAP_PROFILE_HSV12,
  decompressComponentMap,
} from '../experiments/color-normalization-v1.js'
import {
  COLOR_NORMALIZATION_BOX_COVERAGE_GATE,
  COLOR_NORMALIZATION_BOX_IOU_GATE,
  COLOR_NORMALIZATION_EVALUATION_SCHEMA,
  COLOR_NORMALIZATION_EVALUATOR_LABEL_EN,
  COLOR_NORMALIZATION_EVALUATOR_LABEL_RU,
  COLOR_NORMALIZATION_EVALUATOR_TRUTH_SHA256,
  COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS,
  COLOR_NORMALIZATION_MAX_ENCODED_BYTES,
  COLOR_NORMALIZATION_MASK_IOU_GATE,
  COLOR_NORMALIZATION_MONTAGE_CASE_IDS,
  COLOR_NORMALIZATION_PRODUCER_INPUTS_SHA256,
  COLOR_NORMALIZATION_PROFILE_ID,
  COLOR_NORMALIZATION_PROSPECTIVE_FREEZE_SHA256,
  COLOR_NORMALIZATION_SOURCE_COMMIT,
  colorNormalizationRunManifestSchema,
  type ColorNormalizationRunManifest,
} from './color-normalization-contract.js'

function configureSharpForColorNormalizationRun(): void {
  sharp.cache({ memory: 32, files: 0, items: 0 })
  sharp.concurrency(1)
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const boxSchema = z
  .object({
    left: z.number().finite(),
    top: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite(),
  })
  .strict()

const truthRowSchema = z
  .object({
    caseId: z.string().min(1),
    sourceCaseId: z.string().min(1),
    stratum: z.enum(['photo', 'ui', 'map']),
    presence: z.enum(['present', 'absent']),
    imageSha256: digestSchema,
    sourceWidth: z.number().int().positive(),
    sourceHeight: z.number().int().positive(),
    boxes: z.array(boxSchema),
    referenceMasks: z.array(
      z
        .object({
          path: z.string().min(1),
          sha256: digestSchema,
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          resampling: z.string(),
        })
        .strict(),
    ),
  })
  .strict()

export type ColorNormalizationTruthRow = z.infer<typeof truthRowSchema>

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  if (!('code' in error)) return false
  return error.code === code
}

function frozenRowsMatchManifest(manifest: ColorNormalizationRunManifest): void {
  if (manifest.rows.length !== COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS.length)
    throw new Error('manifest-row-count-mismatch')
  for (let index = 0; index < manifest.rows.length; index += 1) {
    const frozen = COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS[index]!
    const row = manifest.rows[index]!
    if (
      row.caseId !== frozen.caseId ||
      row.imageSha256 !== frozen.image.sha256 ||
      row.imagePath !== frozen.image.path ||
      row.sourceWidth !== frozen.image.width ||
      row.sourceHeight !== frozen.image.height
    )
      throw new Error('manifest-row-freeze-mismatch')
  }
}

function expectedUniqueImagesFromFreeze(): Array<{
  key: string
  sha256: string
  width: number
  height: number
  path: string
}> {
  const bySha = new Map<string, { sha256: string; width: number; height: number; path: string }>()
  for (const row of COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS) {
    const prior = bySha.get(row.image.sha256)
    if (
      prior &&
      (prior.path !== row.image.path ||
        prior.width !== row.image.width ||
        prior.height !== row.image.height)
    )
      throw new Error('freeze-unique-image-conflict')
    bySha.set(row.image.sha256, row.image)
  }
  return [...bySha.entries()].map(([key, image]) => ({
    key,
    sha256: key,
    width: image.width,
    height: image.height,
    path: image.path,
  }))
}

async function verifyOrientedSourceImage(
  dataRoot: string,
  image: { path: string; sha256: string; width: number; height: number },
): Promise<void> {
  const sourcePath = resolveContained(dataRoot, image.path)
  const sourceStat = await stat(sourcePath)
  if (sourceStat.size > COLOR_NORMALIZATION_MAX_ENCODED_BYTES)
    throw new Error('source-encoded-bytes-limit')
  const sourceBytes = new Uint8Array(await readFile(sourcePath))
  if (sha256Bytes(sourceBytes) !== image.sha256) throw new Error('source-hash-mismatch')
  const pipeline = sharp(sourceBytes, { limitInputPixels: false }).rotate().ensureAlpha()
  try {
    const decoded = await pipeline.raw().toBuffer({ resolveWithObject: true })
    if (
      decoded.info.width !== image.width ||
      decoded.info.height !== image.height ||
      decoded.info.channels !== 4
    )
      throw new Error('source-oriented-dimensions-mismatch')
  } finally {
    pipeline.destroy()
  }
}

function validateTruthMatchesManifest(
  truth: ColorNormalizationTruthRow[],
  manifest: ColorNormalizationRunManifest,
): void {
  if (truth.length !== manifest.rows.length) throw new Error('truth-row-count-mismatch')
  for (let index = 0; index < manifest.rows.length; index += 1) {
    const row = manifest.rows[index]!
    const truthRow = truth[index]
    if (!truthRow || truthRow.caseId !== row.caseId) throw new Error('truth-case-order-mismatch')
    if (
      truthRow.imageSha256 !== row.imageSha256 ||
      truthRow.sourceWidth !== row.sourceWidth ||
      truthRow.sourceHeight !== row.sourceHeight
    )
      throw new Error('truth-image-identity-mismatch')
  }
}

async function validateRunArtifacts(
  runDirectory: string,
  dataRoot: string,
  manifest: ColorNormalizationRunManifest,
): Promise<void> {
  if (manifest.sourceCommit !== COLOR_NORMALIZATION_SOURCE_COMMIT)
    throw new Error('source-commit-mismatch')
  if (manifest.producerInputsSha256 !== COLOR_NORMALIZATION_PRODUCER_INPUTS_SHA256)
    throw new Error('producer-inputs-sha-mismatch')
  frozenRowsMatchManifest(manifest)

  const expectedUnique = expectedUniqueImagesFromFreeze()
  if (manifest.uniqueImages.length !== expectedUnique.length)
    throw new Error('unique-image-count-mismatch')
  const expectedByKey = new Map(expectedUnique.map((item) => [item.key, item]))
  for (const unique of manifest.uniqueImages) {
    const expected = expectedByKey.get(unique.key)
    if (
      !expected ||
      unique.sha256 !== expected.sha256 ||
      unique.width !== expected.width ||
      unique.height !== expected.height ||
      unique.path !== expected.path
    )
      throw new Error('unique-image-freeze-mismatch')
  }

  for (const unique of manifest.uniqueImages) {
    await verifyOrientedSourceImage(dataRoot, unique)
  }

  for (const row of manifest.rows) {
    const normalizedPath = resolveContained(runDirectory, row.artifacts.normalizedHsv12Png)
    const normalizedBytes = new Uint8Array(await readFile(normalizedPath))
    if (sha256Bytes(normalizedBytes) !== row.artifacts.normalizedHsv12Sha256)
      throw new Error('normalized-png-hash-mismatch')

    const rgbMapPath = resolveContained(runDirectory, row.artifacts.componentMapRgb)
    const hsvMapPath = resolveContained(runDirectory, row.artifacts.componentMapHsv12)
    const rgbCompressed = new Uint8Array(await readFile(rgbMapPath))
    const hsvCompressed = new Uint8Array(await readFile(hsvMapPath))
    if (sha256Bytes(rgbCompressed) !== row.artifacts.componentMapRgbSha256)
      throw new Error('rgb-map-hash-mismatch')
    if (sha256Bytes(hsvCompressed) !== row.artifacts.componentMapHsv12Sha256)
      throw new Error('hsv-map-hash-mismatch')
    const rgbMap = decompressComponentMap(rgbCompressed)
    const hsvMap = decompressComponentMap(hsvCompressed)
    if (rgbMap.profile !== COMPONENT_MAP_PROFILE_CONTROL_RGB)
      throw new Error('rgb-map-profile-mismatch')
    if (hsvMap.profile !== COMPONENT_MAP_PROFILE_HSV12) throw new Error('hsv-map-profile-mismatch')
    if (
      rgbMap.width !== row.sourceWidth ||
      rgbMap.height !== row.sourceHeight ||
      hsvMap.width !== row.sourceWidth ||
      hsvMap.height !== row.sourceHeight
    )
      throw new Error('component-map-dimensions-mismatch')
  }
}

function resolveContained(root: string, candidatePath: string): string {
  if (isAbsolute(candidatePath)) throw new Error('artifact-path-absolute')
  const resolved = resolve(root, candidatePath)
  const part = relative(root, resolved)
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))
    throw new Error('artifact-path-outside-run')
  return resolved
}

export async function loadColorNormalizationTruth(
  path: string,
): Promise<ColorNormalizationTruthRow[]> {
  const bytes = await readFile(path)
  if (sha256Bytes(bytes) !== COLOR_NORMALIZATION_EVALUATOR_TRUTH_SHA256)
    throw new Error('truth-hash-mismatch')
  return z
    .array(truthRowSchema)
    .length(12)
    .parse(JSON.parse(bytes.toString('utf8')))
}

export interface PairedReferenceScore {
  referenceIndex: number
  iou: number
  coverage: number
  passesGates: boolean
}

export interface ComponentAudit {
  componentId: number
  box: Box | null
  pixelCount: number
  /** Highest IoU reference instance; coverage is from that same instance only. */
  highestIoUPair: PairedReferenceScore | null
  /** True when some reference instance meets both frozen box gates for this component. */
  boxAvailabilityPass: boolean
  /** Best gate-passing reference instance for this component (max IoU among passing pairs). */
  bestPassingPair: PairedReferenceScore | null
}

interface ProfileBoxSummary {
  componentCount: number
  boxAvailabilityPass: boolean
  bestPassingComponentId: number | null
  bestPassingBoxIoU: number | null
  bestPassingReferenceCoverage: number | null
  bestPassingReferenceIndex: number | null
  highestIoUComponentId: number | null
  highestBoxIoU: number | null
  highestIoUPairedReferenceCoverage: number | null
  highestIoUReferenceIndex: number | null
  gates: { iou: number; referenceCoverage: number }
}

/** Single-pass component aggregates; scores use paired IoU/coverage per reference instance. */
export function auditColorNormalizationComponents(
  labels: Uint32Array,
  width: number,
  height: number,
  references: readonly Box[],
): ComponentAudit[] {
  const aggregates = new Map<
    number,
    { minX: number; minY: number; maxX: number; maxY: number; count: number }
  >()
  const componentIdsInLabelOrder: number[] = []
  for (let index = 0; index < labels.length; index += 1) {
    const componentId = labels[index]!
    if (componentId <= 0) continue
    const x = index % width
    const y = Math.floor(index / width)
    const prior = aggregates.get(componentId)
    if (!prior) {
      componentIdsInLabelOrder.push(componentId)
      aggregates.set(componentId, { minX: x, minY: y, maxX: x, maxY: y, count: 1 })
      continue
    }
    prior.minX = Math.min(prior.minX, x)
    prior.minY = Math.min(prior.minY, y)
    prior.maxX = Math.max(prior.maxX, x)
    prior.maxY = Math.max(prior.maxY, y)
    prior.count += 1
  }

  const audits: ComponentAudit[] = []
  for (const componentId of componentIdsInLabelOrder) {
    const aggregate = aggregates.get(componentId)!
    const box: Box = {
      left: aggregate.minX,
      top: aggregate.minY,
      width: aggregate.maxX - aggregate.minX + 1,
      height: aggregate.maxY - aggregate.minY + 1,
    }
    let highestIoUPair: PairedReferenceScore | null = null
    let bestPassingPair: PairedReferenceScore | null = null
    let boxAvailabilityPass = false
    if (references.length > 0) {
      const match = wholeObjectMatch(box, references)
      boxAvailabilityPass = match.matched
      for (const instance of match.instances) {
        const pair: PairedReferenceScore = {
          referenceIndex: instance.index,
          iou: instance.iou,
          coverage: instance.coverage,
          passesGates: instance.matched,
        }
        if (!highestIoUPair || pair.iou > highestIoUPair.iou) highestIoUPair = pair
        if (pair.passesGates && (!bestPassingPair || pair.iou > bestPassingPair.iou))
          bestPassingPair = pair
      }
    }
    audits.push({
      componentId,
      box,
      pixelCount: aggregate.count,
      highestIoUPair,
      boxAvailabilityPass,
      bestPassingPair,
    })
  }
  return audits
}

function betterAuditByPairedIoU(
  left: ComponentAudit,
  right: ComponentAudit,
  pick: (audit: ComponentAudit) => PairedReferenceScore | null,
): ComponentAudit {
  const leftIou = pick(left)?.iou ?? 0
  const rightIou = pick(right)?.iou ?? 0
  if (leftIou !== rightIou) return leftIou > rightIou ? left : right
  return left
}

export function summarizeProfileBoxAudits(audits: ComponentAudit[]): ProfileBoxSummary {
  const passing = audits.filter((audit) => audit.boxAvailabilityPass)
  let bestPassing: ComponentAudit | null = null
  for (const audit of passing) {
    if (!bestPassing) bestPassing = audit
    else bestPassing = betterAuditByPairedIoU(bestPassing, audit, (item) => item.bestPassingPair)
  }
  let highestIoU: ComponentAudit | null = null
  for (const audit of audits) {
    if (!highestIoU) highestIoU = audit
    else highestIoU = betterAuditByPairedIoU(highestIoU, audit, (item) => item.highestIoUPair)
  }
  return {
    componentCount: audits.length,
    boxAvailabilityPass: passing.length > 0,
    bestPassingComponentId: bestPassing?.componentId ?? null,
    bestPassingBoxIoU: bestPassing?.bestPassingPair?.iou ?? null,
    bestPassingReferenceCoverage: bestPassing?.bestPassingPair?.coverage ?? null,
    bestPassingReferenceIndex: bestPassing?.bestPassingPair?.referenceIndex ?? null,
    highestIoUComponentId: highestIoU?.componentId ?? null,
    highestBoxIoU: highestIoU?.highestIoUPair?.iou ?? null,
    highestIoUPairedReferenceCoverage: highestIoU?.highestIoUPair?.coverage ?? null,
    highestIoUReferenceIndex: highestIoU?.highestIoUPair?.referenceIndex ?? null,
    gates: {
      iou: COLOR_NORMALIZATION_BOX_IOU_GATE,
      referenceCoverage: COLOR_NORMALIZATION_BOX_COVERAGE_GATE,
    },
  }
}

export interface BestActualMaskScore {
  componentId: number
  iou: number
  matched: boolean
  gate: typeof COLOR_NORMALIZATION_MASK_IOU_GATE
}

/** Best mask IoU over all components; ties keep earlier component in label-first order. */
export function scoreBestActualMaskAmongComponents(
  labels: Uint32Array,
  width: number,
  height: number,
  referenceMask: Uint8Array,
  componentIdsInLabelOrder: readonly number[],
): BestActualMaskScore | null {
  if (componentIdsInLabelOrder.length === 0) return null
  if (labels.length === 0 || labels.length !== referenceMask.length)
    throw new RangeError('Masks must have equal nonempty dimensions')

  let referenceForeground = 0
  const intersectionByComponent = new Map<number, number>()
  const pixelCountByComponent = new Map<number, number>()
  for (let index = 0; index < labels.length; index += 1) {
    const expected = referenceMask[index]!
    if (expected !== 0 && expected !== 1)
      throw new RangeError('Masks must contain binary 0/1 values')
    const referenceOn = expected === 1
    if (referenceOn) referenceForeground += 1
    const componentId = labels[index]!
    if (componentId <= 0) continue
    pixelCountByComponent.set(componentId, (pixelCountByComponent.get(componentId) ?? 0) + 1)
    if (referenceOn) {
      intersectionByComponent.set(componentId, (intersectionByComponent.get(componentId) ?? 0) + 1)
    }
  }
  if (referenceForeground === 0) throw new RangeError('Positive mask ground truth cannot be empty')

  let best: BestActualMaskScore | null = null
  for (const componentId of componentIdsInLabelOrder) {
    const pixelCount = pixelCountByComponent.get(componentId) ?? 0
    const intersection = intersectionByComponent.get(componentId) ?? 0
    const union = pixelCount + referenceForeground - intersection
    const iou = intersection / union
    const candidate: BestActualMaskScore = {
      componentId,
      iou,
      matched: iou >= COLOR_NORMALIZATION_MASK_IOU_GATE,
      gate: COLOR_NORMALIZATION_MASK_IOU_GATE,
    }
    if (!best || candidate.iou > best.iou) best = candidate
  }
  return best
}

async function writeEvaluatorCutoutPng(
  outputPath: string,
  sourceRgba: Uint8Array,
  width: number,
  height: number,
  labels: Uint32Array,
  componentId: number,
): Promise<void> {
  const cutout = buildComponentCutout(sourceRgba, width, height, labels, componentId)
  const png = await sharp(cutout, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer()
  await writeFile(outputPath, png)
}

export function verifyEncodedReferenceMaskSha256(
  encodedBytes: Uint8Array,
  expectedSha256: string,
): void {
  if (sha256Bytes(encodedBytes) !== expectedSha256) throw new Error('mask-hash-mismatch')
}

/** Decode EXIF-oriented raw mask pixels into binary 0/1 (grayscale intensity 0/255; optional alpha). */
export function decodeBinaryMaskFromRaw(
  data: Buffer | Uint8Array,
  channels: number,
  width: number,
  height: number,
): Uint8Array {
  if (channels !== 1 && channels !== 2 && channels !== 3 && channels !== 4)
    throw new Error('mask-unsupported-channels')
  const pixelCount = width * height
  if (data.length !== pixelCount * channels) throw new Error('mask-dimensions')
  const mask = new Uint8Array(pixelCount)
  for (let index = 0; index < pixelCount; index += 1) {
    const base = index * channels
    let intensity: number
    let alpha = 255
    if (channels === 1) {
      intensity = data[base]!
    } else if (channels === 2) {
      intensity = data[base]!
      alpha = data[base + 1]!
    } else {
      const red = data[base]!
      const green = data[base + 1]!
      const blue = data[base + 2]!
      if (red !== green || green !== blue) throw new Error('mask-non-grayscale')
      intensity = red
      if (channels === 4) alpha = data[base + 3]!
    }
    if (intensity !== 0 && intensity !== 255) throw new Error('mask-nonbinary')
    if (alpha !== 0 && alpha !== 255) throw new Error('mask-nonbinary-alpha')
    if (alpha === 0) {
      if (intensity !== 0) throw new Error('mask-alpha-intensity-inconsistent')
      mask[index] = 0
    } else {
      mask[index] = intensity === 255 ? 1 : 0
    }
  }
  return mask
}

export async function loadBinaryMask(
  path: string,
  width: number,
  height: number,
  expectedSha256: string,
): Promise<Uint8Array> {
  const encodedBytes = new Uint8Array(await readFile(path))
  verifyEncodedReferenceMaskSha256(encodedBytes, expectedSha256)
  const pipeline = sharp(encodedBytes, { limitInputPixels: false }).rotate()
  try {
    const decoded = await pipeline.raw().toBuffer({ resolveWithObject: true })
    if (decoded.info.width !== width || decoded.info.height !== height)
      throw new Error('mask-dimensions')
    return decodeBinaryMaskFromRaw(decoded.data, decoded.info.channels, width, height)
  } finally {
    pipeline.destroy()
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&apos;'
    }
  })
}

async function buildMontagePanel(
  title: string,
  subtitle: string,
  images: Array<{ label: string; png: Buffer }>,
  width: number,
): Promise<Buffer> {
  const tileWidth = Math.max(160, Math.floor(width / images.length))
  const tileHeight = 160
  const header = 72
  const composites: sharp.OverlayOptions[] = []
  for (let index = 0; index < images.length; index += 1) {
    const tile = await sharp(images[index]!.png)
      .resize(tileWidth, tileHeight, {
        fit: 'inside',
        background: { r: 24, g: 24, b: 24, alpha: 1 },
      })
      .png()
      .toBuffer()
    composites.push({ input: tile, left: index * tileWidth, top: header })
  }
  const svg = Buffer.from(
    `<svg width="${tileWidth * images.length}" height="${header}">
      <rect width="100%" height="100%" fill="#181818"/>
      <text x="12" y="24" fill="#ffffff" font-size="16" font-family="sans-serif">${escapeXml(title)}</text>
      <text x="12" y="48" fill="#cccccc" font-size="12" font-family="sans-serif">${escapeXml(subtitle)}</text>
      <text x="12" y="66" fill="#ffcc66" font-size="11" font-family="sans-serif">${escapeXml(COLOR_NORMALIZATION_EVALUATOR_LABEL_EN)} / ${escapeXml(COLOR_NORMALIZATION_EVALUATOR_LABEL_RU)}</text>
    </svg>`,
  )
  composites.unshift({ input: svg, left: 0, top: 0 })
  for (let index = 0; index < images.length; index += 1) {
    const labelSvg = Buffer.from(
      `<svg width="${tileWidth}" height="18">
        <text x="4" y="14" fill="#dddddd" font-size="11" font-family="sans-serif">${escapeXml(images[index]!.label)}</text>
      </svg>`,
    )
    composites.push({ input: labelSvg, left: index * tileWidth, top: header + tileHeight })
  }
  const canvasHeight = header + tileHeight + 20
  return sharp({
    create: {
      width: tileWidth * images.length,
      height: canvasHeight,
      channels: 4,
      background: { r: 24, g: 24, b: 24, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer()
}

export interface EvaluateColorNormalizationOptions {
  runDirectory: string
  truthPath: string
  dataRoot: string
  outputDirectory: string
}

export async function evaluateColorNormalizationRun(
  options: EvaluateColorNormalizationOptions,
): Promise<Record<string, unknown>> {
  configureSharpForColorNormalizationRun()
  const runDirectory = resolve(options.runDirectory)
  const outputDirectory = resolve(options.outputDirectory)
  const dataRoot = resolve(options.dataRoot)

  try {
    await mkdir(outputDirectory, { recursive: false })
  } catch (error) {
    if (isNodeErrorCode(error, 'EEXIST')) throw new Error('output-exists')
    throw error
  }
  await mkdir(join(outputDirectory, 'cutouts'), { recursive: true })
  await mkdir(join(outputDirectory, 'montages'), { recursive: true })

  const manifestBytes = await readFile(join(runDirectory, 'run-manifest.json'))
  const manifest = colorNormalizationRunManifestSchema.parse(
    JSON.parse(manifestBytes.toString('utf8')),
  )
  if (manifest.prospectiveFreezeSha256 !== COLOR_NORMALIZATION_PROSPECTIVE_FREEZE_SHA256)
    throw new Error('freeze-identity-mismatch')
  if (manifest.profileId !== COLOR_NORMALIZATION_PROFILE_ID)
    throw new Error('profile-identity-mismatch')
  if (manifest.status !== 'complete') throw new Error('run-not-complete')

  await validateRunArtifacts(runDirectory, dataRoot, manifest)

  const truth = await loadColorNormalizationTruth(resolve(options.truthPath))
  validateTruthMatchesManifest(truth, manifest)
  const truthByCase = new Map(truth.map((row) => [row.caseId, row]))

  const evaluatedRows: Array<Record<string, unknown>> = []
  const uniqueSummaries = new Map<
    string,
    {
      imageSha256: string
      profiles: (typeof manifest.rows)[number]['profiles']
    }
  >()

  const sourceRgbaBySha = new Map<string, Uint8Array>()

  for (const row of manifest.rows) {
    const truthRow = truthByCase.get(row.caseId)
    if (!truthRow) throw new Error(`missing-truth-${row.caseId}`)

    const rgbMapPath = resolveContained(runDirectory, row.artifacts.componentMapRgb)
    const hsvMapPath = resolveContained(runDirectory, row.artifacts.componentMapHsv12)
    const rgbCompressed = new Uint8Array(await readFile(rgbMapPath))
    const hsvCompressed = new Uint8Array(await readFile(hsvMapPath))
    const rgbMap = decompressComponentMap(rgbCompressed)
    const hsvMap = decompressComponentMap(hsvCompressed)

    const references = truthRow.presence === 'present' ? truthRow.boxes : []
    const controlAudits = auditColorNormalizationComponents(
      rgbMap.labels,
      row.sourceWidth,
      row.sourceHeight,
      references,
    )
    const hsvAudits = auditColorNormalizationComponents(
      hsvMap.labels,
      row.sourceWidth,
      row.sourceHeight,
      references,
    )
    const controlSummary = summarizeProfileBoxAudits(controlAudits)
    const hsvSummary = summarizeProfileBoxAudits(hsvAudits)

    const controlComponentOrder = controlAudits.map((audit) => audit.componentId)
    const hsvComponentOrder = hsvAudits.map((audit) => audit.componentId)

    let referenceMaskAudit: Record<string, unknown> | null = null
    let controlBestMask: BestActualMaskScore | null = null
    let hsvBestMask: BestActualMaskScore | null = null
    if (truthRow.referenceMasks.length > 0) {
      if (truthRow.referenceMasks.length !== 1) throw new Error('unexpected-reference-mask-count')
      const reference = truthRow.referenceMasks[0]!
      const maskPath = resolveContained(dataRoot, reference.path)
      const referenceMask = await loadBinaryMask(
        maskPath,
        row.sourceWidth,
        row.sourceHeight,
        reference.sha256,
      )

      controlBestMask = scoreBestActualMaskAmongComponents(
        rgbMap.labels,
        row.sourceWidth,
        row.sourceHeight,
        referenceMask,
        controlComponentOrder,
      )
      hsvBestMask = scoreBestActualMaskAmongComponents(
        hsvMap.labels,
        row.sourceWidth,
        row.sourceHeight,
        referenceMask,
        hsvComponentOrder,
      )

      referenceMaskAudit = {
        status: 'evaluated',
        referencePath: reference.path,
        referenceSha256: reference.sha256,
        interpretation: 'candidate mask availability upper bound only; not box-selected proxy',
        profiles: {
          controlRgb: controlBestMask,
          hsv12: hsvBestMask,
        },
        note: 'actual reference mask only; not synthesized from GT boxes',
      }
    }

    let sourceRgba = sourceRgbaBySha.get(row.imageSha256)
    if (!sourceRgba) {
      const sourcePath = resolveContained(dataRoot, row.imagePath)
      const sourceBytes = await readFile(sourcePath)
      sourceRgba = new Uint8Array(await sharp(sourceBytes).rotate().ensureAlpha().raw().toBuffer())
      sourceRgbaBySha.set(row.imageSha256, sourceRgba)
    }

    const cutoutComponentForProfile = (
      summary: ProfileBoxSummary,
      audits: ComponentAudit[],
    ): number | null => {
      if (summary.bestPassingComponentId !== null) return summary.bestPassingComponentId
      if (summary.highestIoUComponentId !== null) return summary.highestIoUComponentId
      return audits[0]?.componentId ?? null
    }

    const controlCutoutId = cutoutComponentForProfile(controlSummary, controlAudits)
    if (controlCutoutId !== null) {
      await writeEvaluatorCutoutPng(
        join(
          outputDirectory,
          'cutouts',
          `${row.caseId}-controlRgb-evaluator-cutout-c${controlCutoutId}.png`,
        ),
        sourceRgba,
        row.sourceWidth,
        row.sourceHeight,
        rgbMap.labels,
        controlCutoutId,
      )
    }
    const hsvCutoutId = cutoutComponentForProfile(hsvSummary, hsvAudits)
    if (hsvCutoutId !== null) {
      await writeEvaluatorCutoutPng(
        join(
          outputDirectory,
          'cutouts',
          `${row.caseId}-hsv12-evaluator-cutout-c${hsvCutoutId}.png`,
        ),
        sourceRgba,
        row.sourceWidth,
        row.sourceHeight,
        hsvMap.labels,
        hsvCutoutId,
      )
    }
    if (controlBestMask !== null) {
      await writeEvaluatorCutoutPng(
        join(
          outputDirectory,
          'cutouts',
          `${row.caseId}-controlRgb-mask-best-iou-c${controlBestMask.componentId}.png`,
        ),
        sourceRgba,
        row.sourceWidth,
        row.sourceHeight,
        rgbMap.labels,
        controlBestMask.componentId,
      )
    }
    if (hsvBestMask !== null) {
      await writeEvaluatorCutoutPng(
        join(
          outputDirectory,
          'cutouts',
          `${row.caseId}-hsv12-mask-best-iou-c${hsvBestMask.componentId}.png`,
        ),
        sourceRgba,
        row.sourceWidth,
        row.sourceHeight,
        hsvMap.labels,
        hsvBestMask.componentId,
      )
    }

    const rowRecord: Record<string, unknown> = {
      caseId: row.caseId,
      stratum: truthRow.stratum,
      presence: truthRow.presence,
      imageSha256: row.imageSha256,
      sourceWidth: row.sourceWidth,
      sourceHeight: row.sourceHeight,
      profiles: {
        controlRgb: controlSummary,
        hsv12: hsvSummary,
      },
      negativeGeometry:
        truthRow.presence === 'absent'
          ? {
              controlComponents: controlAudits.length,
              hsv12Components: hsvAudits.length,
              note: 'geometry only; no measured semantic absence claim',
            }
          : null,
      referenceMaskAudit,
    }
    evaluatedRows.push(rowRecord)

    if (!uniqueSummaries.has(row.imageSha256)) {
      uniqueSummaries.set(row.imageSha256, {
        imageSha256: row.imageSha256,
        profiles: row.profiles,
      })
    }
  }

  for (const row of manifest.rows) {
    if (
      !COLOR_NORMALIZATION_MONTAGE_CASE_IDS.includes(
        row.caseId as (typeof COLOR_NORMALIZATION_MONTAGE_CASE_IDS)[number],
      )
    )
      continue
    const truthRow = truthByCase.get(row.caseId)!
    const sourceRgba =
      sourceRgbaBySha.get(row.imageSha256) ??
      new Uint8Array(
        await sharp(await readFile(resolveContained(dataRoot, row.imagePath)))
          .rotate()
          .ensureAlpha()
          .raw()
          .toBuffer(),
      )
    const hsvMap = decompressComponentMap(
      new Uint8Array(
        await readFile(resolveContained(runDirectory, row.artifacts.componentMapHsv12)),
      ),
    )
    const references = truthRow.presence === 'present' ? truthRow.boxes : []
    const hsvSummaryMontage = summarizeProfileBoxAudits(
      auditColorNormalizationComponents(
        hsvMap.labels,
        row.sourceWidth,
        row.sourceHeight,
        references,
      ),
    )
    const montageCutoutId =
      hsvSummaryMontage.bestPassingComponentId ?? hsvSummaryMontage.highestIoUComponentId
    const normalizedPng = await readFile(
      resolveContained(runDirectory, row.artifacts.normalizedHsv12Png),
    )
    const originalPng = await sharp(sourceRgba, {
      raw: { width: row.sourceWidth, height: row.sourceHeight, channels: 4 },
    })
      .png()
      .toBuffer()
    const panels: Array<{ label: string; png: Buffer }> = [
      { label: 'original', png: originalPng },
      { label: 'normalized-hsv12', png: normalizedPng },
    ]
    if (montageCutoutId !== null) {
      const cutout = buildComponentCutout(
        sourceRgba,
        row.sourceWidth,
        row.sourceHeight,
        hsvMap.labels,
        montageCutoutId,
      )
      panels.push({
        label: `evaluator-cutout-c${montageCutoutId}`,
        png: await sharp(cutout, {
          raw: { width: row.sourceWidth, height: row.sourceHeight, channels: 4 },
        })
          .png()
          .toBuffer(),
      })
    }
    if (truthRow.referenceMasks.length === 1) {
      const reference = truthRow.referenceMasks[0]!
      panels.push({
        label: 'actual-reference-mask',
        png: await readFile(resolveContained(dataRoot, reference.path)),
      })
    }
    const montage = await buildMontagePanel(
      row.caseId,
      `${COLOR_NORMALIZATION_EVALUATOR_LABEL_EN}`,
      panels,
      960,
    )
    await writeFile(join(outputDirectory, 'montages', `${row.caseId}.png`), montage)
  }

  const report = {
    schema: COLOR_NORMALIZATION_EVALUATION_SCHEMA,
    profileId: COLOR_NORMALIZATION_PROFILE_ID,
    prospectiveFreezeSha256: COLOR_NORMALIZATION_PROSPECTIVE_FREEZE_SHA256,
    runManifestSha256: sha256Bytes(manifestBytes),
    truthSha256: COLOR_NORMALIZATION_EVALUATOR_TRUTH_SHA256,
    interpretation:
      'candidate availability upper bound only; evaluator-selected components are not automatic detection',
    uniqueImageSummaries: [...uniqueSummaries.values()],
    rows: evaluatedRows,
  }

  await writeFile(join(outputDirectory, 'evaluation-report.json'), JSON.stringify(report, null, 2))
  return report
}

function usage(): never {
  console.error(
    'Usage: node --import tsx benchmarks/v03/evaluate-color-normalization.ts --run <directory> --truth <path> --data-root <path> --output <new-directory>',
  )
  process.exitCode = 1
  throw new Error('cli-usage')
}

async function main(argv: string[]): Promise<void> {
  let parsed: { run: string; truth: string; dataRoot: string; output: string }
  try {
    const args = parseArgs({
      args: argv,
      options: {
        run: { type: 'string' },
        truth: { type: 'string' },
        'data-root': { type: 'string' },
        output: { type: 'string' },
      },
      strict: true,
    })
    if (!args.values.run || !args.values.truth || !args.values['data-root'] || !args.values.output)
      usage()
    parsed = {
      run: args.values.run,
      truth: args.values.truth,
      dataRoot: args.values['data-root'],
      output: args.values.output,
    }
  } catch {
    usage()
  }

  await evaluateColorNormalizationRun({
    runDirectory: resolve(parsed!.run),
    truthPath: resolve(parsed!.truth),
    dataRoot: resolve(parsed!.dataRoot),
    outputDirectory: resolve(parsed!.output),
  })
}

function logCliFailure(error: unknown): void {
  if (error instanceof Error && error.message === 'cli-usage') return
  const message =
    error instanceof AggregateError
      ? error.errors.map((item) => (item instanceof Error ? item.message : String(item))).join('; ')
      : error instanceof Error
        ? error.message
        : 'evaluation-failed'
  console.error(message)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    logCliFailure(error)
    process.exitCode = 1
  })
}
