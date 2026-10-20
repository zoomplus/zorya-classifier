#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ENCODER = {
  bytes: 28_157_093,
  sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
}
const DECODER = {
  bytes: 16_496_559,
  sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
}
const MAX_CASES = 5
const MAX_PIXELS_PER_CASE = 1_048_576
const MAX_UNIQUE_RAW_MASK_BYTES = 256 * 1024 * 1024
const MAX_COMPRESSED_MASK_BYTES = 64 * 1024 * 1024
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const TIMEOUT_MS = 60_000

function usage() {
  return [
    'Usage: node mobilesam-point-proposals.mjs --seeds=<actual model seed manifest> --source-root=<allowed source root>',
    '       --encoder=<pinned mobile_sam_image_encoder.onnx> --decoder=<pinned sam_mask_decoder_multi.onnx>',
    '       --proposals=<new JSON path> --masks=<new gzip path> --report=<new receipt path>',
    'Producer input contains only source paths/hashes, dimensions, ROI, and actual seedRegion; no annotations or target labels.',
  ].join('\n')
}

function parseArgs(argv, internal = false) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const allowed = new Set([
    'seeds',
    'source-root',
    'encoder',
    'decoder',
    'proposals',
    'masks',
    'report',
    ...(internal ? ['temp-root'] : []),
  ])
  const result = {}
  for (const arg of argv) {
    const match = /^--([a-z][a-z0-9-]*)=(.*)$/u.exec(arg)
    if (!match || !allowed.has(match[1])) throw new Error(`Invalid argument: ${arg}`)
    const key = match[1].replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate argument: --${match[1]}`)
    result[key] = match[2]
  }
  for (const key of ['seeds', 'sourceRoot', 'encoder', 'decoder', 'proposals', 'masks', 'report'])
    if (typeof result[key] !== 'string' || result[key].length === 0)
      throw new Error(`Missing --${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`)
  if (internal && !result.tempRoot) throw new Error('Worker is missing its private temp root')
  return result
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function safeOwnedTemp(root) {
  if (typeof root !== 'string') return false
  const base = path.resolve(os.tmpdir())
  const resolved = path.resolve(root)
  const relative = path.relative(base, resolved)
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep) &&
    path.basename(resolved).startsWith('zorya-private-point-proposals-')
  )
}

async function readBounded(pathname, maxBytes) {
  const handle = await fsp.open(pathname, 'r')
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

function checkedRect(value, name, width, height) {
  if (
    !value ||
    !Number.isSafeInteger(value.left) ||
    !Number.isSafeInteger(value.top) ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    value.left < 0 ||
    value.top < 0 ||
    value.width < 1 ||
    value.height < 1 ||
    value.left + value.width > width ||
    value.top + value.height > height
  )
    throw new Error(`${name} must be a positive in-source integer rectangle`)
  return { left: value.left, top: value.top, width: value.width, height: value.height }
}

function pointGrid(rect) {
  return Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3)
    const column = index % 3
    return {
      x: rect.left + Math.round((rect.width - 1) * (column / 2)),
      y: rect.top + Math.round((rect.height - 1) * (row / 2)),
    }
  })
}

function preview(mask, width, height, box) {
  if (!box) return { width: 0, height: 0, encoding: 'base64-u8-0-or-1', data: '' }
  const scale = Math.min(1, 32 / box.width, 32 / box.height)
  const outWidth = Math.max(1, Math.round(box.width * scale))
  const outHeight = Math.max(1, Math.round(box.height * scale))
  const bytes = Buffer.alloc(outWidth * outHeight)
  for (let y = 0; y < outHeight; y++) {
    const sourceY = box.top + Math.min(box.height - 1, Math.floor((y * box.height) / outHeight))
    for (let x = 0; x < outWidth; x++) {
      const sourceX = box.left + Math.min(box.width - 1, Math.floor((x * box.width) / outWidth))
      bytes[y * outWidth + x] = mask[sourceY * width + sourceX]
    }
  }
  return {
    width: outWidth,
    height: outHeight,
    encoding: 'base64-u8-0-or-1',
    data: bytes.toString('base64'),
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

function validateManifest(manifest) {
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.length < 1 ||
    manifest.cases.length > MAX_CASES
  )
    throw new Error('Expected schemaVersion 1 and one to five frozen fresh-call cases')
  const ids = new Set()
  return manifest.cases.map((item) => {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !/^[a-z0-9-]{1,80}$/u.test(item.id) ||
      ids.has(item.id) ||
      typeof item.imagePath !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(item.imageSha256) ||
      !Number.isSafeInteger(item.sourceWidth) ||
      !Number.isSafeInteger(item.sourceHeight) ||
      item.sourceWidth < 1 ||
      item.sourceHeight < 1 ||
      item.sourceWidth * item.sourceHeight > MAX_PIXELS_PER_CASE
    )
      throw new Error('Seed manifest case has invalid identity, source hash, or dimensions')
    ids.add(item.id)
    const seedRegion = checkedRect(
      item.seedRegion,
      `${item.id} seedRegion`,
      item.sourceWidth,
      item.sourceHeight,
    )
    const roi =
      item.roi === undefined
        ? { left: 0, top: 0, width: item.sourceWidth, height: item.sourceHeight }
        : checkedRect(item.roi, `${item.id} ROI`, item.sourceWidth, item.sourceHeight)
    if (
      seedRegion.left < roi.left ||
      seedRegion.top < roi.top ||
      seedRegion.left + seedRegion.width > roi.left + roi.width ||
      seedRegion.top + seedRegion.height > roi.top + roi.height
    )
      throw new Error(`${item.id} seedRegion must be fully inside its traced ROI`)
    return {
      id: item.id,
      imagePath: item.imagePath,
      imageSha256: item.imageSha256,
      sourceWidth: item.sourceWidth,
      sourceHeight: item.sourceHeight,
      seedRegion,
      roi,
    }
  })
}

async function resolveOwnedSource(sourceRoot, relativePath) {
  const root = await fsp.realpath(sourceRoot)
  const resolved = path.resolve(root, relativePath)
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Image path escapes declared source root')
  const real = await fsp.realpath(resolved)
  const realRelative = path.relative(root, real)
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative))
    throw new Error('Image symlink escapes declared source root')
  return real
}

async function readPinnedAsset(file, identity) {
  const bytes = await readBounded(file, identity.bytes)
  if (bytes.byteLength !== identity.bytes || sha256(bytes) !== identity.sha256)
    throw new Error('Pinned MobileSAM model hash/size mismatch')
  return bytes
}

async function runWorker(options) {
  const { gzipSync } = await import('node:zlib')
  const { default: sharp } = await import('sharp')
  const ort = await import('onnxruntime-node')
  const rawManifest = await readBounded(options.seeds, 1024 * 1024)
  const manifest = JSON.parse(rawManifest.toString('utf8'))
  const cases = validateManifest(manifest)
  const encoderBytes = await readPinnedAsset(options.encoder, ENCODER)
  const decoderBytes = await readPinnedAsset(options.decoder, DECODER)
  const sessionOptions = {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: 'sequential',
    enableMemPattern: true,
    graphOptimizationLevel: 'all',
  }
  let encoder
  let decoder
  let sessionFailure
  const rawChunks = []
  const maskIndex = new Map()
  const candidateRows = []
  let rawOffset = 0
  try {
    encoder = await ort.InferenceSession.create(encoderBytes, sessionOptions)
    decoder = await ort.InferenceSession.create(decoderBytes, sessionOptions)
    if (
      !encoder.inputNames.includes('input_image') ||
      !encoder.outputNames.includes('image_embeddings') ||
      !decoder.inputNames.includes('image_embeddings') ||
      !decoder.outputNames.includes('masks') ||
      !decoder.outputNames.includes('iou_predictions')
    )
      throw new Error('Pinned MobileSAM graph tensor names differ from expected schema')

    for (const item of cases) {
      const imagePath = await resolveOwnedSource(options.sourceRoot, item.imagePath)
      const imageBytes = await readBounded(imagePath, MAX_IMAGE_BYTES)
      if (sha256(imageBytes) !== item.imageSha256)
        throw new Error(`${item.id} source image SHA-256 mismatch`)
      const decoded = await sharp(imageBytes, {
        limitInputPixels: MAX_PIXELS_PER_CASE,
        failOn: 'error',
      })
        .rotate()
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const { width, height } = decoded.info
      if (
        width !== item.sourceWidth ||
        height !== item.sourceHeight ||
        width * height > MAX_PIXELS_PER_CASE
      )
        throw new Error(`${item.id} oriented source dimensions differ from seed trace`)
      const sourcePixels = width * height
      const resizedScale = 1024 / Math.max(width, height)
      const resizedWidth = Math.round(width * resizedScale)
      const resizedHeight = Math.round(height * resizedScale)
      const pipeline = sharp(decoded.data, {
        raw: { width, height, channels: 4 },
      })
      let rgb
      try {
        rgb = await pipeline
          .removeAlpha()
          .resize(resizedWidth, resizedHeight, { fit: 'fill', kernel: 'linear' })
          .raw()
          .toBuffer()
      } finally {
        pipeline.destroy()
      }
      if (rgb.length !== resizedWidth * resizedHeight * 3)
        throw new Error(`${item.id} image preprocessing returned wrong RGB dimensions`)
      const imageTensor = new ort.Tensor('float32', Float32Array.from(rgb), [
        resizedHeight,
        resizedWidth,
        3,
      ])
      let embedding
      try {
        const encoded = await encoder.run({ input_image: imageTensor })
        embedding = encoded.image_embeddings
        if (
          !(embedding instanceof ort.Tensor) ||
          embedding.type !== 'float32' ||
          JSON.stringify(embedding.dims) !== '[1,256,64,64]' ||
          !(embedding.data instanceof Float32Array)
        )
          throw new Error(`${item.id} encoder output shape mismatch`)
        const points = pointGrid(item.seedRegion)
        const caseCandidates = []
        for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
          const point = points[pointIndex]
          const pointCoords = new ort.Tensor(
            'float32',
            Float32Array.of(
              (point.x * resizedWidth) / width,
              (point.y * resizedHeight) / height,
              (point.x * resizedWidth) / width,
              (point.y * resizedHeight) / height,
            ),
            [1, 2, 2],
          )
          const pointLabels = new ort.Tensor('float32', Float32Array.of(1, -1), [1, 2])
          const maskInput = new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256])
          const hasMaskInput = new ort.Tensor('float32', Float32Array.of(0), [1])
          const originalSize = new ort.Tensor('float32', Float32Array.of(height, width), [2])
          let decodedMasks
          let scores
          try {
            const output = await decoder.run({
              image_embeddings: embedding,
              point_coords: pointCoords,
              point_labels: pointLabels,
              mask_input: maskInput,
              has_mask_input: hasMaskInput,
              orig_im_size: originalSize,
            })
            decodedMasks = output.masks
            scores = output.iou_predictions
            if (
              !(decodedMasks instanceof ort.Tensor) ||
              decodedMasks.type !== 'float32' ||
              JSON.stringify(decodedMasks.dims) !== JSON.stringify([1, 4, height, width]) ||
              !(decodedMasks.data instanceof Float32Array) ||
              !(scores instanceof ort.Tensor) ||
              scores.type !== 'float32' ||
              JSON.stringify(scores.dims) !== '[1,4]' ||
              !(scores.data instanceof Float32Array) ||
              scores.data.length !== 4 ||
              !scores.data.every(Number.isFinite)
            )
              throw new Error(`${item.id} decoder output schema mismatch`)

            for (let token = 0; token < 4; token++) {
              const mask = new Uint8Array(sourcePixels)
              const logits = decodedMasks.data.subarray(
                token * sourcePixels,
                (token + 1) * sourcePixels,
              )
              for (let index = 0; index < sourcePixels; index++) {
                const value = logits[index]
                if (value === undefined || !Number.isFinite(value))
                  throw new Error(`${item.id} has non-finite decoder mask value`)
                if (value <= 0) continue
                const x = index % width
                const y = Math.floor(index / width)
                if (
                  x >= item.roi.left &&
                  x < item.roi.left + item.roi.width &&
                  y >= item.roi.top &&
                  y < item.roi.top + item.roi.height
                )
                  mask[index] = 1
              }
              const box = tightBox(mask, width, height)
              const maskSha = sha256(mask)
              let maskRecord = maskIndex.get(maskSha)
              if (maskRecord && !Buffer.from(maskRecord.bytes).equals(Buffer.from(mask)))
                maskRecord = undefined
              if (!maskRecord) {
                if (rawOffset + mask.byteLength > MAX_UNIQUE_RAW_MASK_BYTES)
                  throw new Error(`Unique raw masks exceed ${MAX_UNIQUE_RAW_MASK_BYTES} bytes`)
                const id = `mask-${String(maskIndex.size + 1).padStart(4, '0')}`
                maskRecord = {
                  id,
                  offset: rawOffset,
                  bytes: mask,
                  sha256: maskSha,
                  firstCandidateId: null,
                }
                rawChunks.push(mask)
                rawOffset += mask.byteLength
                if (!maskIndex.has(maskSha)) maskIndex.set(maskSha, maskRecord)
              }
              const candidateId = `${item.id}:p${String(pointIndex).padStart(2, '0')}:m${token}`
              const boxKey = box ? `${box.left},${box.top},${box.width},${box.height}` : 'empty'
              const priorBox = caseCandidates.find((candidate) => candidate.boxKey === boxKey)
              const row = {
                id: candidateId,
                pointIndex,
                point,
                decoderToken: token,
                modelQuality: scores.data[token],
                box,
                mask: {
                  id: maskRecord.id,
                  offset: maskRecord.offset,
                  bytes: maskRecord.bytes.byteLength,
                  sha256: maskRecord.sha256,
                },
                identicalMaskAs: maskRecord.firstCandidateId,
                identicalBoxAs: priorBox?.id ?? null,
                preview: preview(mask, width, height, box),
                boxKey,
              }
              if (!maskRecord.firstCandidateId) maskRecord.firstCandidateId = candidateId
              caseCandidates.push(row)
            }
          } finally {
            pointCoords.dispose()
            pointLabels.dispose()
            maskInput.dispose()
            hasMaskInput.dispose()
            originalSize.dispose()
            decodedMasks?.dispose()
            scores?.dispose()
          }
        }
        candidateRows.push({
          id: item.id,
          sourceWidth: width,
          sourceHeight: height,
          sourceImageSha256: item.imageSha256,
          roi: item.roi,
          actualModelSeedRegion: item.seedRegion,
          pointPattern:
            '3x3 source-pixel grid: corners, edge midpoints, center; row-major; no annotation input',
          pointLabelSemantics: 'one positive click and one ignored -1 padding point',
          encoderCalls: 1,
          decoderCalls: 9,
          candidates: caseCandidates,
        })
      } finally {
        imageTensor.dispose()
        embedding?.dispose()
      }
    }
  } finally {
    const releases = await Promise.allSettled([
      ...(encoder ? [encoder.release()] : []),
      ...(decoder ? [decoder.release()] : []),
    ])
    if (releases.some((release) => release.status === 'rejected'))
      sessionFailure = new Error('MobileSAM probe sessions failed to release')
  }
  if (sessionFailure) throw sessionFailure

  const rawMasks = Buffer.concat(rawChunks, rawOffset)
  const compressedMasks = gzipSync(rawMasks, { level: 6 })
  if (compressedMasks.byteLength > MAX_COMPRESSED_MASK_BYTES)
    throw new Error(`Compressed mask output exceeds ${MAX_COMPRESSED_MASK_BYTES} bytes`)
  const proposals = {
    schemaVersion: 1,
    scope:
      'Private component proposal probe. No annotations, target labels, or oracle geometry were provided to the producer.',
    manifestSha256: sha256(rawManifest),
    sourceCommit: typeof manifest.sourceCommit === 'string' ? manifest.sourceCommit : null,
    provider: 'CPU',
    encoder: { bytes: ENCODER.bytes, sha256: ENCODER.sha256 },
    decoder: { bytes: DECODER.bytes, sha256: DECODER.sha256 },
    caps: {
      cases: MAX_CASES,
      pixelsPerCase: MAX_PIXELS_PER_CASE,
      uniqueRawMaskBytes: MAX_UNIQUE_RAW_MASK_BYTES,
      compressedMaskBytes: MAX_COMPRESSED_MASK_BYTES,
    },
    masks: {
      filename: 'masks.gz',
      compression: 'gzip of concatenated unique source-size binary u8 masks',
      rawBytes: rawMasks.length,
      rawSha256: sha256(rawMasks),
      compressedBytes: compressedMasks.length,
      compressedSha256: sha256(compressedMasks),
      uniqueMaskCount: maskIndex.size,
    },
    cases: candidateRows,
  }
  await fsp.writeFile(
    path.join(options.tempRoot, 'proposals.json'),
    `${JSON.stringify(proposals, null, 2)}\n`,
    { flag: 'wx' },
  )
  await fsp.writeFile(path.join(options.tempRoot, 'masks.gz'), compressedMasks, { flag: 'wx' })
  await fsp.writeFile(
    path.join(options.tempRoot, 'worker-result.json'),
    `${JSON.stringify({ status: 'complete', proposalsSha256: sha256(Buffer.from(JSON.stringify(proposals, null, 2) + '\n')), maskSha256: sha256(compressedMasks) })}\n`,
    { flag: 'wx' },
  )
}

async function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

async function runCoordinator(options) {
  const outputs = [options.proposals, options.masks, options.report].map((value) =>
    path.resolve(value),
  )
  if (new Set(outputs).size !== outputs.length)
    throw new Error('Proposal, mask, and report paths must differ')
  for (const output of outputs)
    if (fs.existsSync(output)) throw new Error(`Refusing to overwrite output: ${output}`)

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zorya-private-point-proposals-'))
  const report = {
    schemaVersion: 1,
    status: 'running',
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    ownedWorkerPid: null,
    timeoutMs: TIMEOUT_MS,
    childExit: null,
    workerError: null,
    proposalsPath: outputs[0],
    masksPath: outputs[1],
    tempRoot,
    cleanup: null,
  }
  let child
  let timeout
  try {
    const workerArgs = [
      fileURLToPath(import.meta.url),
      `--seeds=${options.seeds}`,
      `--source-root=${options.sourceRoot}`,
      `--encoder=${options.encoder}`,
      `--decoder=${options.decoder}`,
      `--proposals=${outputs[0]}`,
      `--masks=${outputs[1]}`,
      `--report=${outputs[2]}`,
      `--temp-root=${tempRoot}`,
      '--internal-worker',
    ]
    child = spawn(process.execPath, workerArgs, {
      cwd: process.cwd(),
      env: { ...process.env, ZORYA_PRIVATE_POINT_PROPOSAL_WORKER: randomUUID() },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    report.ownedWorkerPid = child.pid ?? null
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096)
    })
    const closed = waitForClose(child)
    const timeoutPromise = new Promise((resolve) => {
      timeout = globalThis.setTimeout(() => {
        report.status = 'timeout'
        child.kill()
        resolve(null)
      }, TIMEOUT_MS)
    })
    let closeResult = await Promise.race([closed, timeoutPromise])
    if (!closeResult) closeResult = await closed
    globalThis.clearTimeout(timeout)
    report.childExit = closeResult
    report.workerError = stderr || null
    if (report.status !== 'timeout' && closeResult.code === 0) {
      const workerResultBytes = await readBounded(
        path.join(tempRoot, 'worker-result.json'),
        64 * 1024,
      )
      const workerResult = JSON.parse(workerResultBytes.toString('utf8'))
      const proposalBytes = await readBounded(
        path.join(tempRoot, 'proposals.json'),
        16 * 1024 * 1024,
      )
      const maskBytes = await readBounded(
        path.join(tempRoot, 'masks.gz'),
        MAX_COMPRESSED_MASK_BYTES,
      )
      if (
        sha256(proposalBytes) !== workerResult.proposalsSha256 ||
        sha256(maskBytes) !== workerResult.maskSha256
      )
        throw new Error('Worker artifact hash receipt mismatch')
      await Promise.all([
        fsp.mkdir(path.dirname(outputs[0]), { recursive: true }),
        fsp.mkdir(path.dirname(outputs[1]), { recursive: true }),
      ])
      await Promise.all([
        fsp.writeFile(outputs[0], proposalBytes, { flag: 'wx' }),
        fsp.writeFile(outputs[1], maskBytes, { flag: 'wx' }),
      ])
      report.status = 'complete'
      report.proposalsSha256 = sha256(proposalBytes)
      report.masksCompressedSha256 = sha256(maskBytes)
    } else if (report.status !== 'timeout') {
      report.status = 'worker-failed'
    }
  } catch (error) {
    report.status = report.status === 'timeout' ? 'timeout' : 'failed'
    report.workerError = error instanceof Error ? error.message : 'Point proposal worker failed'
  } finally {
    if (timeout) globalThis.clearTimeout(timeout)
    report.endedAt = new Date().toISOString()
    if (safeOwnedTemp(tempRoot)) {
      try {
        await fsp.rm(tempRoot, { recursive: true, force: true })
        report.cleanup = 'removed after owned worker close'
      } catch (error) {
        report.cleanup = error instanceof Error ? `failed: ${error.message}` : 'failed'
      }
    } else report.cleanup = 'refused unsafe temp root'
    report.tempRoot = tempRoot
    await fsp.mkdir(path.dirname(outputs[2]), { recursive: true })
    await fsp.writeFile(outputs[2], `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  }
  if (report.status !== 'complete' || !report.cleanup?.startsWith('removed')) process.exitCode = 1
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

const argv = process.argv.slice(2)
if (argv.at(-1) === '--internal-worker') {
  if (!process.env.ZORYA_PRIVATE_POINT_PROPOSAL_WORKER)
    throw new Error('Internal worker cannot be started directly')
  const options = parseArgs(argv.slice(0, -1), true)
  await runWorker(options)
} else {
  const options = parseArgs(argv)
  if (options.help) process.stdout.write(`${usage()}\n`)
  else await runCoordinator(options)
}
