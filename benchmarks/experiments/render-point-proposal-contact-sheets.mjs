#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { gunzipSync } from 'node:zlib'

const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_RAW_BYTES = 256 * 1024 * 1024
const MAX_PROPOSALS_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_PIXELS = 1_048_576
const CELL_WIDTH = 300
const CELL_HEIGHT = 240
const GRID_COLUMNS = 4
const GRID_ROWS = 3
const PAGE_SIZE = GRID_COLUMNS * GRID_ROWS

function usage() {
  return [
    'Usage: node render-point-proposal-contact-sheets.mjs --proposals=<frozen proposal JSON> --masks=<frozen masks.gz> --seeds=<producer-only seed manifest>',
    '       --source-root=<image root> --out-dir=<new output directory> --manifest=<new A5-ready manifest>',
    'Creates one original source PNG and up to three 12-tile sheets per case. No annotations, target labels, or quality-based filtering.',
  ].join('\n')
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const allowed = new Set(['proposals', 'masks', 'seeds', 'source-root', 'out-dir', 'manifest'])
  const result = {}
  for (const arg of argv) {
    const match = /^--([a-z][a-z0-9-]*)=(.*)$/u.exec(arg)
    if (!match || !allowed.has(match[1])) throw new Error(`Invalid argument: ${arg}`)
    const key = match[1].replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate argument: --${match[1]}`)
    result[key] = match[2]
  }
  for (const key of ['proposals', 'masks', 'seeds', 'sourceRoot', 'outDir', 'manifest'])
    if (typeof result[key] !== 'string' || result[key].length === 0)
      throw new Error(`Missing --${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`)
  return result
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readBounded(filePath, maxBytes) {
  const handle = await fsp.open(filePath, 'r')
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

async function resolveImage(root, relative) {
  const resolvedRoot = await fsp.realpath(root)
  const candidate = path.resolve(resolvedRoot, relative)
  const relativePath = path.relative(resolvedRoot, candidate)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath))
    throw new Error('Source image path escapes source root')
  const actual = await fsp.realpath(candidate)
  const actualRelative = path.relative(resolvedRoot, actual)
  if (actualRelative.startsWith('..') || path.isAbsolute(actualRelative))
    throw new Error('Source image symlink escapes source root')
  return actual
}

function svgPageBackground(width, height, pageIndex) {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex > 2)
    throw new Error('Invalid presentation page index')
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f4f5f7"/><text x="14" y="24" font-family="Arial,sans-serif" font-size="17" font-weight="bold" fill="#182230">Mask proposals · page ${pageIndex + 1}</text></svg>`,
  )
}

function tileSvg(box, aliases) {
  if (!Array.isArray(aliases) || aliases.length < 1 || aliases.length > 36)
    throw new Error('Invalid candidate aliases for presentation')
  if (aliases.some((alias) => !/^C(?:0[0-9]|[12][0-9]|3[0-5])$/u.test(alias)))
    throw new Error('Unsafe candidate alias for presentation')
  if (
    box !== null &&
    (!box ||
      !Number.isSafeInteger(box.left) ||
      !Number.isSafeInteger(box.top) ||
      !Number.isSafeInteger(box.width) ||
      !Number.isSafeInteger(box.height) ||
      box.left < 0 ||
      box.top < 0 ||
      box.width < 1 ||
      box.height < 1)
  )
    throw new Error('Invalid source-coordinate box for presentation')
  const boxLabel = box ? `${box.left},${box.top} ${box.width}×${box.height}` : 'empty mask / no box'
  const aliasRows = []
  for (let start = 0; start < aliases.length; start += 12)
    aliasRows.push(aliases.slice(start, start + 12).join(' '))
  const aliasText = aliasRows
    .map((row, index) => `<tspan x="7" y="${11 + index * 10}">${row}</tspan>`)
    .join('')
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL_WIDTH}" height="${CELL_HEIGHT}"><rect x="1" y="1" width="298" height="238" rx="5" fill="#fff" stroke="#aeb7c2"/><text font-family="Arial,sans-serif" font-size="10" font-weight="bold" fill="#101828">${aliasText}</text><text x="8" y="228" font-family="Arial,sans-serif" font-size="10" fill="#344054">box ${boxLabel}</text></svg>`,
  )
}

function assertPresentationTextIsSafe(forbidden = []) {
  const fixtures = ['photo-dev-present-06', 'source-06.jpg', 'deadbeef', 'cat']
  const svg = Buffer.concat([
    svgPageBackground(1200, 754, 0),
    tileSvg({ left: 1, top: 2, width: 30, height: 40 }, ['C00', 'C01']),
  ]).toString('utf8')
  for (const value of [...fixtures, ...forbidden])
    if (svg.includes(value))
      throw new Error(`Presentation fixture leaked forbidden label text: ${value}`)
  if (!svg.includes('Mask proposals · page 1') || !svg.includes('C00 C01'))
    throw new Error('Presentation fixture omitted the generic header or local aliases')
  let rejected = false
  try {
    tileSvg(null, ['photo-dev-present-06'])
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error('Presentation fixture accepted an untrusted label')
}

function assertPresentationPayloadIsSafe(presentation, forbidden = []) {
  const serialized = JSON.stringify(presentation)
  for (const value of forbidden)
    if (value && serialized.includes(value))
      throw new Error(`Presentation payload leaked internal metadata: ${value}`)
  if (
    presentation.choiceIds.some(
      (id) => id !== 'none' && !/^C(?:0[0-9]|[12][0-9]|3[0-5])$/u.test(id),
    )
  )
    throw new Error('Presentation payload contains a non-alias choice')
}

function createMaskLayers(image, mask, width, height) {
  const overlay = Buffer.alloc(width * height * 4)
  const cutout = Buffer.from(image)
  for (let index = 0; index < mask.length; index++) {
    const pixel = index * 4
    if (mask[index] === 0) {
      cutout.fill(0, pixel, pixel + 4)
      continue
    }
    const x = index % width
    const y = Math.floor(index / width)
    const edge =
      x === 0 ||
      y === 0 ||
      x + 1 === width ||
      y + 1 === height ||
      mask[index - 1] === 0 ||
      mask[index + 1] === 0 ||
      mask[index - width] === 0 ||
      mask[index + width] === 0
    if (edge) {
      overlay[pixel] = 0
      overlay[pixel + 1] = 230
      overlay[pixel + 2] = 255
      overlay[pixel + 3] = 230
    } else {
      overlay[pixel] = 255
      overlay[pixel + 1] = 48
      overlay[pixel + 2] = 45
      overlay[pixel + 3] = 112
    }
  }
  return { overlay, cutout }
}

async function toPng(buffer, raw, resize) {
  let pipeline = sharp(buffer, raw)
  if (resize) pipeline = pipeline.resize(resize.width, resize.height, resize.options)
  pipeline = pipeline.png()
  try {
    return await pipeline.toBuffer()
  } finally {
    pipeline.destroy()
  }
}

async function makeTile(box, aliases, mask, original, width, height) {
  const { overlay, cutout } = createMaskLayers(original, mask, width, height)
  const overlayFull = await toPng(
    Buffer.from(original),
    { raw: { width, height, channels: 4 } },
    undefined,
  )
  const overlayPipeline = sharp(overlayFull).composite([
    { input: overlay, raw: { width, height, channels: 4 }, blend: 'over' },
  ])
  let overlaid
  try {
    overlaid = await overlayPipeline.png().toBuffer()
  } finally {
    overlayPipeline.destroy()
  }
  const overlayPane = await toPng(overlaid, undefined, {
    width: 144,
    height: 176,
    options: { fit: 'contain', background: '#e8edf2' },
  })
  const cutoutPane = await toPng(
    cutout,
    { raw: { width, height, channels: 4 } },
    {
      width: 124,
      height: 176,
      options: { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } },
    },
  )
  const backdrop = svgPageBackground(CELL_WIDTH, CELL_HEIGHT, 0)
  const svg = tileSvg(box, aliases)
  const sheet = sharp({
    create: {
      width: CELL_WIDTH,
      height: CELL_HEIGHT,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  }).composite([
    { input: backdrop, top: 0, left: 0 },
    { input: svg, top: 0, left: 0 },
    { input: overlayPane, top: 43, left: 5 },
    { input: cutoutPane, top: 43, left: 160 },
  ])
  try {
    return await sheet.png().toBuffer()
  } finally {
    sheet.destroy()
  }
}

async function renderCase(sample, seedItem, options, rawMasks, outDir, caseIndex) {
  const sourcePath = await resolveImage(options.sourceRoot, seedItem.imagePath)
  const sourceBytes = await readBounded(sourcePath, MAX_IMAGE_BYTES)
  if (sha256(sourceBytes) !== sample.sourceImageSha256)
    throw new Error(`${sample.id} source image hash differs from frozen proposals`)
  const source = sharp(sourceBytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
  let decoded
  try {
    decoded = await source
      .rotate()
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
  } finally {
    source.destroy()
  }
  const { width, height } = decoded.info
  if (width !== sample.sourceWidth || height !== sample.sourceHeight || width * height > MAX_PIXELS)
    throw new Error(`${sample.id} source dimensions differ from proposal metadata`)
  const caseAlias = `case-${String(caseIndex + 1).padStart(2, '0')}`
  const caseDir = path.join(outDir, caseAlias)
  await fsp.mkdir(caseDir, { recursive: false })
  const originalFilename = 'original.png'
  const originalPath = path.join(caseDir, originalFilename)
  await fsp.writeFile(
    originalPath,
    await toPng(decoded.data, { raw: { width, height, channels: 4 } }),
    { flag: 'wx' },
  )

  const unique = []
  const groupByMask = new Map()
  const candidateAliases = new Map(
    sample.candidates.map((candidate, index) => [
      candidate.id,
      `C${String(index).padStart(2, '0')}`,
    ]),
  )
  for (const candidate of sample.candidates) {
    if (
      !candidate.mask ||
      candidate.mask.bytes !== width * height ||
      !Number.isSafeInteger(candidate.mask.offset) ||
      candidate.mask.offset + candidate.mask.bytes > rawMasks.length
    )
      throw new Error(`${sample.id}/${candidate.id} mask offset is invalid`)
    const mask = rawMasks.subarray(
      candidate.mask.offset,
      candidate.mask.offset + candidate.mask.bytes,
    )
    if (sha256(mask) !== candidate.mask.sha256)
      throw new Error(`${sample.id}/${candidate.id} mask hash mismatch`)
    for (const value of mask)
      if (value !== 0 && value !== 1)
        throw new Error(`${sample.id}/${candidate.id} mask is not binary`)
    let group = groupByMask.get(candidate.mask.sha256)
    if (!group) {
      group = { first: candidate, mask, choiceAliases: [], internalIds: [] }
      groupByMask.set(candidate.mask.sha256, group)
      unique.push(group)
    } else if (!Buffer.from(group.mask).equals(Buffer.from(mask))) {
      throw new Error('SHA-256 collision between distinct proposal masks')
    }
    group.choiceAliases.push(candidateAliases.get(candidate.id))
    group.internalIds.push(candidate.id)
  }
  if (unique.length > 36) throw new Error(`${sample.id} contains more than 36 unique masks`)
  const pageCount = Math.max(1, Math.ceil(unique.length / PAGE_SIZE))
  const sheetFiles = []
  for (let page = 0; page < pageCount; page++) {
    const tileCandidates = unique.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    const comps = [
      {
        input: svgPageBackground(GRID_COLUMNS * CELL_WIDTH, 34 + GRID_ROWS * CELL_HEIGHT, page),
        top: 0,
        left: 0,
      },
    ]
    for (let index = 0; index < tileCandidates.length; index++) {
      const group = tileCandidates[index]
      const tile = await makeTile(
        group.first.box,
        group.choiceAliases,
        group.mask,
        decoded.data,
        width,
        height,
      )
      const row = Math.floor(index / GRID_COLUMNS)
      const column = index % GRID_COLUMNS
      comps.push({
        input: tile,
        top: 34 + row * CELL_HEIGHT,
        left: column * CELL_WIDTH,
      })
    }
    const sheetFilename = `candidates-${String(page + 1).padStart(2, '0')}-of-${String(pageCount).padStart(2, '0')}.png`
    const sheetPath = path.join(caseDir, sheetFilename)
    const sheet = sharp({
      create: {
        width: GRID_COLUMNS * CELL_WIDTH,
        height: 34 + GRID_ROWS * CELL_HEIGHT,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).composite(comps)
    try {
      const bytes = await sheet.png().toBuffer()
      await fsp.writeFile(sheetPath, bytes, { flag: 'wx' })
      sheetFiles.push({
        path: sheetPath,
        sha256: sha256(bytes),
        bytes: bytes.length,
        candidateStart: page * PAGE_SIZE,
        candidateCount: tileCandidates.length,
      })
    } finally {
      sheet.destroy()
    }
  }
  const candidateLocations = new Map()
  unique.forEach((group, uniqueIndex) => {
    const page = Math.floor(uniqueIndex / PAGE_SIZE)
    const tileIndex = uniqueIndex % PAGE_SIZE
    const sheet = sheetFiles[page]
    for (let index = 0; index < group.internalIds.length; index++) {
      const id = group.internalIds[index]
      candidateLocations.set(id, {
        internalCandidateId: id,
        choiceId: group.choiceAliases[index],
        maskSha256: group.first.mask.sha256,
        maskOffset: group.first.mask.offset,
        maskBytes: group.first.mask.bytes,
        box: group.first.box,
        sheetPath: sheet.path,
        sheetSha256: sheet.sha256,
        sheetPage: page,
        tileIndex,
        row: Math.floor(tileIndex / GRID_COLUMNS),
        column: tileIndex % GRID_COLUMNS,
        aliases: [...group.choiceAliases],
      })
    }
  })
  const caseManifest = {
    caseAlias,
    presentation: {
      choiceIds: [
        'none',
        ...sample.candidates.map((candidate) => candidateAliases.get(candidate.id)),
      ],
      originalImagePath: originalPath,
      sheets: sheetFiles.map(({ path: imagePath }) => ({ path: imagePath })),
    },
    internal: {
      caseId: sample.id,
      sourceWidth: width,
      sourceHeight: height,
      sourceImageSha256: sample.sourceImageSha256,
      sheets: sheetFiles,
      candidates: sample.candidates.map((candidate) => {
        const location = candidateLocations.get(candidate.id)
        return {
          choiceId: location.choiceId,
          internalCandidateId: candidate.id,
          pointIndex: candidate.pointIndex,
          point: candidate.point,
          decoderToken: candidate.decoderToken,
          box: location.box,
          binaryMask: {
            artifact: options.masks,
            compression: 'gzip; concatenate unique binary masks then slice by byte offset',
            offset: location.maskOffset,
            bytes: location.maskBytes,
            sha256: location.maskSha256,
          },
          display: {
            sheetPath: location.sheetPath,
            sheetSha256: location.sheetSha256,
            page: location.sheetPage,
            tileIndex: location.tileIndex,
            row: location.row,
            column: location.column,
            aliases: location.aliases,
          },
        }
      }),
    },
  }
  return caseManifest
}

async function main(options) {
  const outputRoot = path.resolve(options.outDir)
  const manifestPath = path.resolve(options.manifest)
  if (outputRoot === manifestPath || outputRoot.startsWith(`${manifestPath}${path.sep}`))
    throw new Error('Manifest output cannot be inside the contact-sheet directory')
  try {
    await fsp.access(outputRoot)
    throw new Error(`Refusing to reuse output directory: ${outputRoot}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing')) throw error
  }
  try {
    await fsp.access(manifestPath)
    throw new Error(`Refusing to overwrite manifest: ${manifestPath}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing')) throw error
  }

  let madeOutput = false
  try {
    const proposalBytes = await readBounded(options.proposals, MAX_PROPOSALS_BYTES)
    const proposals = JSON.parse(proposalBytes.toString('utf8'))
    const seedBytes = await readBounded(options.seeds, 1024 * 1024)
    if (sha256(seedBytes) !== proposals.manifestSha256)
      throw new Error('Seed manifest hash differs from frozen proposal artifact')
    const seedManifest = JSON.parse(seedBytes.toString('utf8'))
    if (!Array.isArray(seedManifest.cases)) throw new Error('Seed manifest cases are missing')
    assertPresentationTextIsSafe([
      ...proposals.cases.flatMap((sample) => [
        sample.id,
        sample.sourceImageSha256,
        ...(sample.candidates ?? []).map((candidate) => candidate.mask?.sha256).filter(Boolean),
      ]),
      ...seedManifest.cases.map((item) => path.basename(item.imagePath)),
    ])
    const seedById = new Map(seedManifest.cases.map((item) => [item.id, item]))
    if (!Array.isArray(proposals.cases) || proposals.cases.length < 1 || proposals.cases.length > 5)
      throw new Error('Expected one to five frozen proposal cases')
    const compressedMasks = await readBounded(options.masks, MAX_COMPRESSED_BYTES)
    if (sha256(compressedMasks) !== proposals.masks?.compressedSha256)
      throw new Error('Frozen mask gzip SHA differs from proposal metadata')
    const rawMasks = gunzipSync(compressedMasks, { maxOutputLength: MAX_RAW_BYTES })
    if (
      rawMasks.length !== proposals.masks?.rawBytes ||
      rawMasks.length > MAX_RAW_BYTES ||
      sha256(rawMasks) !== proposals.masks?.rawSha256
    )
      throw new Error('Frozen raw mask artifact hash or decompression size mismatch')
    await fsp.mkdir(outputRoot, { recursive: false })
    madeOutput = true
    const cases = []
    for (let caseIndex = 0; caseIndex < proposals.cases.length; caseIndex++) {
      const sample = proposals.cases[caseIndex]
      if (sample.candidates?.length < 1 || sample.candidates.length > 36)
        throw new Error(`${sample.id} has invalid candidate count`)
      const seedItem = seedById.get(sample.id)
      if (
        !seedItem ||
        seedItem.imageSha256 !== sample.sourceImageSha256 ||
        seedItem.sourceWidth !== sample.sourceWidth ||
        seedItem.sourceHeight !== sample.sourceHeight
      )
        throw new Error(`${sample.id} source metadata differs from frozen seed manifest`)
      const rendered = await renderCase(sample, seedItem, options, rawMasks, outputRoot, caseIndex)
      assertPresentationPayloadIsSafe(rendered.presentation, [
        sample.id,
        sample.sourceImageSha256,
        path.basename(seedItem.imagePath),
        ...sample.candidates.flatMap((candidate) => [candidate.id, candidate.mask?.sha256]),
      ])
      cases.push(rendered)
    }
    const manifest = {
      schemaVersion: 1,
      scope:
        'A5 selection interface for candidate masks; no target labels, annotations, or model quality scores are present.',
      proposalSha256: sha256(proposalBytes),
      maskArtifactSha256: sha256(compressedMasks),
      seedManifestSha256: sha256(seedBytes),
      sourceCommit: seedManifest.sourceCommit ?? null,
      candidatesPerCaseMaximum: 36,
      choiceSemantics:
        'Choose one candidate ID or `none`; each candidate maps to its exact source-coordinate binary mask and source bbox.',
      cases,
    }
    await fsp.mkdir(path.dirname(manifestPath), { recursive: true })
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    await fsp.writeFile(manifestPath, manifestBytes, { flag: 'wx' })
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'complete',
          manifest: manifestPath,
          manifestSha256: sha256(manifestBytes),
          outputDirectory: outputRoot,
          caseCount: cases.length,
          imageCount: cases.reduce((total, item) => total + 1 + item.presentation.sheets.length, 0),
          candidateCount: cases.reduce((total, item) => total + item.internal.candidates.length, 0),
        },
        null,
        2,
      )}\n`,
    )
  } catch (error) {
    if (madeOutput) await fsp.rm(outputRoot, { recursive: true, force: true })
    throw error
  }
}

const options = parseArgs(process.argv.slice(2))
if (options.help) process.stdout.write(`${usage()}\n`)
else await main(options)
