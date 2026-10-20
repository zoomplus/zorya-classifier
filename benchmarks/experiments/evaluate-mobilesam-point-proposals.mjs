#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { gunzipSync } from 'node:zlib'

const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_RAW_BYTES = 256 * 1024 * 1024
const MAX_CASES = 5

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const allowed = new Set([
    'proposals',
    'masks',
    'references',
    'reference-base',
    'source-root',
    'report',
  ])
  const parsed = {}
  for (const arg of argv) {
    const match = /^--([a-z][a-z0-9-]*)=(.*)$/u.exec(arg)
    if (!match || !allowed.has(match[1])) throw new Error(`Invalid argument: ${arg}`)
    const key = match[1].replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
    if (Object.hasOwn(parsed, key)) throw new Error(`Duplicate argument: --${match[1]}`)
    parsed[key] = match[2]
  }
  for (const key of ['proposals', 'masks', 'references', 'referenceBase', 'sourceRoot', 'report'])
    if (typeof parsed[key] !== 'string' || parsed[key].length === 0)
      throw new Error(`Missing --${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`)
  return parsed
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readBounded(pathname, maxBytes) {
  const handle = await fs.open(pathname, 'r')
  let stream
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maxBytes)
      throw new Error(`Input exceeds bounded file limit (${maxBytes} bytes)`)
    const chunks = []
    let length = 0
    stream = handle.createReadStream({ autoClose: false })
    for await (const chunk of stream) {
      length += chunk.byteLength
      if (length > maxBytes) throw new Error(`Input grew beyond ${maxBytes} bytes`)
      chunks.push(Buffer.from(chunk))
    }
    const after = await handle.stat()
    if (length !== before.size || after.size !== before.size)
      throw new Error('Input changed size while being read')
    return Buffer.concat(chunks, length)
  } finally {
    stream?.destroy()
    await handle.close()
  }
}

function pixelIoU(a, b) {
  if (a.length !== b.length) throw new Error('Evaluation mask lengths differ')
  let intersection = 0
  let union = 0
  let referencePixels = 0
  let predictedPixels = 0
  for (let index = 0; index < a.length; index++) {
    const predicted = a[index] === 1
    const reference = b[index] === 1
    if (predicted) predictedPixels++
    if (reference) referencePixels++
    if (predicted && reference) intersection++
    if (predicted || reference) union++
  }
  return {
    iou: union ? intersection / union : 1,
    intersection,
    union,
    referencePixels,
    predictedPixels,
    coverage: referencePixels ? intersection / referencePixels : 1,
  }
}

function tightBox(mask, width, height) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (mask[y * width + x] === 1) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
  return maxX < minX
    ? null
    : { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function boxIoU(a, b) {
  if (!a || !b) return 0
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.left + a.width, b.left + b.width)
  const bottom = Math.min(a.top + a.height, b.top + b.height)
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
  const union = a.width * a.height + b.width * b.height - intersection
  return union ? intersection / union : 0
}

function boxCovers(box, x, y) {
  return (
    box !== null &&
    x >= box.left &&
    x < box.left + box.width &&
    y >= box.top &&
    y < box.top + box.height
  )
}

async function main(options) {
  const reportPath = path.resolve(options.report)
  try {
    await fs.access(reportPath)
    throw new Error(`Refusing to overwrite report: ${reportPath}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing')) throw error
  }
  const proposalBytes = await readBounded(options.proposals, 16 * 1024 * 1024)
  const proposals = JSON.parse(proposalBytes.toString('utf8'))
  const compressed = await readBounded(options.masks, MAX_COMPRESSED_BYTES)
  if (
    compressed.length > MAX_COMPRESSED_BYTES ||
    sha256(compressed) !== proposals.masks?.compressedSha256
  )
    throw new Error('Gzip mask artifact exceeds size cap or SHA does not match proposal metadata')
  const raw = gunzipSync(compressed, { maxOutputLength: MAX_RAW_BYTES })
  if (
    raw.length !== proposals.masks?.rawBytes ||
    sha256(raw) !== proposals.masks?.rawSha256 ||
    raw.length > MAX_RAW_BYTES
  )
    throw new Error('Decompressed mask bytes do not match proposal receipt or exceed cap')
  if (
    !Array.isArray(proposals.cases) ||
    proposals.cases.length < 1 ||
    proposals.cases.length > MAX_CASES
  )
    throw new Error('Expected one to five actual-seed proposal cases')
  const referenceManifestBytes = await readBounded(options.references, 1024 * 1024)
  const referenceManifest = JSON.parse(referenceManifestBytes.toString('utf8'))
  const references = Array.isArray(referenceManifest)
    ? referenceManifest
    : referenceManifest?.fixtures
  if (!Array.isArray(references) || references.length !== MAX_CASES)
    throw new Error('Expected five independent reference mask cases')
  const referenceById = new Map(references.map((item) => [item.id, item]))
  const root = await fs.realpath(options.sourceRoot)
  const maskPathFor = async (item) => {
    const relative = path.relative(
      root,
      path.resolve(options.referenceBase, item.referenceMaskPath),
    )
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(`${item.id} reference mask escapes source root`)
    const actual = await fs.realpath(path.resolve(options.referenceBase, item.referenceMaskPath))
    const actualRelative = path.relative(root, actual)
    if (actualRelative.startsWith('..') || path.isAbsolute(actualRelative))
      throw new Error(`${item.id} reference mask symlink escapes source root`)
    return actual
  }
  const results = []
  for (const sample of proposals.cases) {
    const item = referenceById.get(sample.id)
    if (!item || sample.candidates?.length !== 36)
      throw new Error(`${sample.id} is missing an independent reference or 36 proposals`)
    const referenceFile = await maskPathFor(item)
    const referenceBytes = await readBounded(referenceFile, MAX_RAW_BYTES)
    if (sha256(referenceBytes) !== item.referenceMaskSha256)
      throw new Error(`${sample.id} reference mask hash mismatch`)
    const decodedReference = await sharp(referenceBytes, {
      limitInputPixels: 1_048_576,
      failOn: 'error',
    })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (
      decodedReference.info.width !== sample.sourceWidth ||
      decodedReference.info.height !== sample.sourceHeight
    )
      throw new Error(`${sample.id} annotation/source coordinate dimensions differ`)
    const reference = new Uint8Array(decodedReference.data.length)
    for (let index = 0; index < reference.length; index++) {
      const value = decodedReference.data[index]
      if (value !== 0 && value !== 255) throw new Error(`${sample.id} reference mask is not binary`)
      reference[index] = value === 255 ? 1 : 0
    }
    const width = sample.sourceWidth
    const height = sample.sourceHeight
    const gtBox = tightBox(reference, width, height)
    if (!gtBox) throw new Error(`${sample.id} reference annotation is empty`)
    const unionMask = new Uint8Array(reference.length)
    const details = []
    for (const candidate of sample.candidates) {
      if (
        !candidate.mask ||
        !Number.isSafeInteger(candidate.mask.offset) ||
        !Number.isSafeInteger(candidate.mask.bytes) ||
        candidate.mask.bytes !== reference.length ||
        !/^[a-f0-9]{64}$/u.test(candidate.mask.sha256) ||
        !Number.isFinite(candidate.modelQuality)
      )
        throw new Error(`${sample.id}/${candidate.id} has invalid proposal metadata`)
      const mask = raw.subarray(candidate.mask.offset, candidate.mask.offset + candidate.mask.bytes)
      if (mask.length !== reference.length || sha256(mask) !== candidate.mask.sha256)
        throw new Error(`${sample.id}/${candidate.id} mask offset/hash mismatch`)
      for (let index = 0; index < mask.length; index++) {
        if (mask[index] !== 0 && mask[index] !== 1)
          throw new Error(`${sample.id}/${candidate.id} proposal mask is not binary`)
        if (mask[index]) unionMask[index] = 1
      }
      const score = pixelIoU(mask, reference)
      const candidateBoxIoU = boxIoU(candidate.box, gtBox)
      details.push({
        id: candidate.id,
        pointIndex: candidate.pointIndex,
        point: candidate.point,
        decoderToken: candidate.decoderToken,
        modelQuality: candidate.modelQuality,
        box: candidate.box,
        boxIoU: candidateBoxIoU,
        maskIoU: score.iou,
        maskCoverage: score.coverage,
        maskSha256: candidate.mask.sha256,
        identicalMaskAs: candidate.identicalMaskAs,
        identicalBoxAs: candidate.identicalBoxAs,
      })
    }
    const stableQualityOrder = [...details].sort(
      (a, b) =>
        b.modelQuality - a.modelQuality ||
        a.pointIndex - b.pointIndex ||
        a.decoderToken - b.decoderToken,
    )
    let unionBoxPixels = 0
    let gtPixels = 0
    let maskCoveredGt = 0
    let boxCoveredGt = 0
    const uniqueBoxes = new Map()
    for (const detail of details)
      if (detail.box)
        uniqueBoxes.set(
          `${detail.box.left},${detail.box.top},${detail.box.width},${detail.box.height}`,
          detail.box,
        )
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const index = y * width + x
        const isGt = reference[index] === 1
        if (isGt) gtPixels++
        const anyMask = unionMask[index] === 1
        if (isGt && anyMask) maskCoveredGt++
        let anyBox = false
        for (const box of uniqueBoxes.values()) {
          if (boxCovers(box, x, y)) {
            anyBox = true
            break
          }
        }
        if (anyBox) {
          unionBoxPixels++
          if (isGt) boxCoveredGt++
        }
      }
    let unionMaskIntersection = 0
    let unionMaskCount = 0
    for (let index = 0; index < reference.length; index++) {
      if (unionMask[index]) unionMaskCount++
      if (unionMask[index] && reference[index]) unionMaskIntersection++
    }
    const unionMaskIoU =
      unionMaskCount + gtPixels - unionMaskIntersection
        ? unionMaskIntersection / (unionMaskCount + gtPixels - unionMaskIntersection)
        : 1
    const topQuality = stableQualityOrder[0]
    const oracleBestMask = [...details].sort(
      (a, b) =>
        b.maskIoU - a.maskIoU || a.pointIndex - b.pointIndex || a.decoderToken - b.decoderToken,
    )[0]
    const bestBox = [...details].sort(
      (a, b) =>
        b.boxIoU - a.boxIoU || a.pointIndex - b.pointIndex || a.decoderToken - b.decoderToken,
    )[0]
    results.push({
      id: sample.id,
      sourceWidth: width,
      sourceHeight: height,
      actualModelSeedRegion: sample.actualModelSeedRegion,
      gridPoints: sample.candidates
        .filter(
          (candidate, index, rows) =>
            rows.findIndex((row) => row.pointIndex === candidate.pointIndex) === index,
        )
        .map((candidate) => candidate.point),
      annotationMaskSha256: item.referenceMaskSha256,
      foregroundHitPoints: sample.candidates
        .filter(
          (candidate, index, rows) =>
            rows.findIndex((row) => row.pointIndex === candidate.pointIndex) === index,
        )
        .filter((candidate) => reference[candidate.point.y * width + candidate.point.x] === 1)
        .length,
      annotationBox: gtBox,
      proposalCount: details.length,
      uniqueMaskCount: new Set(details.map((item) => item.maskSha256)).size,
      uniqueBoxCount: uniqueBoxes.size,
      nativeQualityBaseline: {
        candidateId: topQuality.id,
        modelQuality: topQuality.modelQuality,
        maskIoU: topQuality.maskIoU,
        boxIoU: topQuality.boxIoU,
      },
      oracleBestCandidateUpperBound: {
        candidateId: oracleBestMask.id,
        modelQuality: oracleBestMask.modelQuality,
        maskIoU: oracleBestMask.maskIoU,
        boxIoU: oracleBestMask.boxIoU,
      },
      bestProposalBoxIoU: bestBox.boxIoU,
      candidateUnionCoverage: {
        referencePixels: gtPixels,
        unionMaskCoverage: maskCoveredGt / gtPixels,
        unionMaskIoU,
        unionBoxCoverage: boxCoveredGt / gtPixels,
        unionBoxPixels,
        candidateBoxCount: uniqueBoxes.size,
      },
      candidates: details,
    })
  }
  const report = {
    schemaVersion: 1,
    scope:
      'component-only: model-quality baseline and oracle candidate upper bounds; actual-seed point proposals, no end-to-end selection claim',
    modelQualitySemantics:
      'Raw decoder quality values are retained for ranking only; they are not calibrated probabilities or semantic truth.',
    caps: {
      compressedMasksBytes: MAX_COMPRESSED_BYTES,
      decompressedUniqueMasksBytes: MAX_RAW_BYTES,
      cases: MAX_CASES,
      sourcePixelsPerCase: 1_048_576,
    },
    producerProposalSha256: sha256(proposalBytes),
    producerMaskSha256: sha256(compressed),
    referenceManifestSha256: sha256(referenceManifestBytes),
    metrics: results,
  }
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
}

const options = parseArgs(process.argv.slice(2))
if (options.help)
  process.stdout.write(
    'Usage: node evaluate-mobilesam-point-proposals.mjs --proposals=<durable proposal JSON> --masks=<durable gzip masks> --references=<independent corrected mask manifest> --reference-base=<relative-path base> --source-root=<allowed reference root> --report=<new report path>\n',
  )
else await main(options)
