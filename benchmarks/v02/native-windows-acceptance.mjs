#!/usr/bin/env node
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_NAME = 'zorya-classifier'
const ORT_VERSION = '1.23.2'
const TS_VERSION = '5.9.2'
const NODE_TYPES_VERSION = '24.3.0'
const encoderAsset = {
  name: 'mobile_sam_image_encoder.onnx',
  bytes: 28_157_093,
  sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
}
const decoderAsset = {
  name: 'sam_mask_decoder_multi.onnx',
  bytes: 16_496_559,
  sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
}
const childChannel = channel('zorya.segmentation.child-resource')

function usage() {
  return [
    'Usage: node native-windows-acceptance.mjs --archive=<.tgz> --sha256=<64 hex>',
    '       --encoder=<verified encoder.onnx> --decoder=<verified multi decoder.onnx>',
    '       --fixtures=<five-case dev manifest> --report=<new report path> [--linux-soak-concurrent]',
  ].join('\n')
}

function parseArgs(argv) {
  const options = {}
  const valueFlags = new Set(['archive', 'sha256', 'encoder', 'decoder', 'fixtures', 'report'])
  if (argv.includes('--help')) {
    if (argv.length !== 1) throw new Error('--help cannot be combined with other arguments')
    return { help: true }
  }
  for (const arg of argv) {
    if (arg === '--linux-soak-concurrent') {
      if (Object.hasOwn(options, 'linuxSoakConcurrent'))
        throw new Error('Duplicate argument: --linux-soak-concurrent')
      options.linuxSoakConcurrent = true
      continue
    }
    const match = /^--([a-z][a-z0-9-]*)=(.*)$/u.exec(arg)
    if (!match) throw new Error(`Invalid argument: ${arg}`)
    if (!valueFlags.has(match[1])) throw new Error(`Unknown argument: --${match[1]}`)
    const key = match[1].replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate argument: --${match[1]}`)
    options[key] = match[2]
  }
  for (const required of ['archive', 'sha256', 'encoder', 'decoder', 'fixtures', 'report'])
    if (typeof options[required] !== 'string' || options[required].length === 0)
      throw new Error(`Missing --${required}`)
  if (!/^[a-f0-9]{64}$/u.test(options.sha256)) throw new Error('--sha256 must be lowercase SHA-256')
  return options
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertFile(pathname, expected, description) {
  const stat = fs.statSync(pathname)
  if (!stat.isFile() || stat.size !== expected.bytes)
    throw new Error(`${description} has an unexpected file size`)
  const actual = digest(fs.readFileSync(pathname))
  if (actual !== expected.sha256) throw new Error(`${description} SHA-256 does not match`)
  return actual
}

function winTemp() {
  const base = os.tmpdir()
  if (!path.win32.isAbsolute(base) || !/^win32$/u.test(process.platform))
    throw new Error('This acceptance runner requires native Windows Node.js')
  const root = fs.mkdtempSync(path.join(base, 'zorya-classifier-v02-native-'))
  for (const folder of ['profile', 'weights', 'fixtures', 'npm-cache'])
    fs.mkdirSync(path.join(root, folder), { recursive: true })
  return root
}

function freeBytesAt(pathname) {
  try {
    const stat = fs.statfsSync(pathname)
    return stat.bavail * stat.bsize
  } catch {
    return null
  }
}

function cleanChildEnvironment(userConfig, globalConfig, cache) {
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (
      /^npm_config_/iu.test(key) ||
      /npm.*(token|auth|password)|(^|_)auth(token|key)?$/iu.test(key)
    )
      delete env[key]
  env.NPM_CONFIG_USERCONFIG = userConfig
  env.NPM_CONFIG_GLOBALCONFIG = globalConfig
  env.NPM_CONFIG_CACHE = cache
  env.NPM_CONFIG_AUDIT = 'false'
  env.NPM_CONFIG_FUND = 'false'
  return env
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 600_000,
    maxBuffer: 24 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error) throw new Error(`${options.label ?? 'Command'} failed to start`)
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`
      .replace(/https?:\/\/[^\s]+/gu, '[registry output omitted]')
      .slice(-1600)
    throw new Error(`${options.label ?? 'Command'} failed (${String(result.status)}): ${detail}`)
  }
  return result.stdout ?? ''
}

function npmInstall(root, env, packages) {
  const npmCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  )
  if (!fs.existsSync(npmCli)) throw new Error('npm-cli.js is missing beside Windows Node.js')
  run(
    process.execPath,
    [
      npmCli,
      'install',
      '--ignore-scripts',
      '--no-save',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      '--legacy-peer-deps',
      ...packages,
    ],
    {
      cwd: root,
      env,
      label: 'npm install with scripts disabled',
    },
  )
}

async function stageVerifiedArchive(sourcePath, destination, expectedHash) {
  const before = await fsp.stat(sourcePath)
  if (!before.isFile()) throw new Error('Package archive path is not a regular file')
  if (before.size > 512 * 1024 * 1024)
    throw new Error('Package archive exceeds the 512 MiB acceptance input limit')
  const hash = createHash('sha256')
  let bytesSeen = 0
  const tally = new Transform({
    transform(chunk, _encoding, callback) {
      bytesSeen += chunk.byteLength
      if (bytesSeen > 512 * 1024 * 1024) {
        callback(new Error('Package archive exceeds the 512 MiB acceptance input limit'))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(
    fs.createReadStream(sourcePath),
    tally,
    fs.createWriteStream(destination, { flags: 'wx' }),
  )
  const actualHash = hash.digest('hex')
  if (actualHash !== expectedHash) throw new Error('Package archive SHA-256 does not match')
  const after = await fsp.stat(sourcePath)
  if (after.size !== before.size) throw new Error('Package archive changed while being staged')
  return actualHash
}

async function writeDeclarationProbe(profile) {
  await fsp.writeFile(
    path.join(profile, 'declaration-probe.ts'),
    [
      "import { createClassifier } from 'zorya-classifier'",
      "import { createMobileSamSegmenter, type BinaryMask, type SegmentationInput } from 'zorya-classifier/segmentation'",
      'const coreFactory: typeof createClassifier = createClassifier',
      'const segmenterFactory: typeof createMobileSamSegmenter = createMobileSamSegmenter',
      'const input: SegmentationInput | undefined = undefined',
      'const mask: BinaryMask | undefined = undefined',
      'void [coreFactory, segmenterFactory, input, mask]',
      '',
    ].join('\n'),
  )
  await fsp.writeFile(
    path.join(profile, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ['node'],
        },
        files: ['declaration-probe.ts'],
      },
      null,
      2,
    ),
  )
  const tsc = path.join(profile, 'node_modules', 'typescript', 'bin', 'tsc')
  run(process.execPath, [tsc, '--project', path.join(profile, 'tsconfig.json')], {
    cwd: profile,
    timeout: 120_000,
    label: 'Windows declaration consumer probe',
  })
}

function boundsFromRect(rect) {
  return {
    left: { start: rect.left, endExclusive: rect.left + 1 },
    right: { start: rect.left + rect.width - 1, endExclusive: rect.left + rect.width },
    top: { start: rect.top, endExclusive: rect.top + 1 },
    bottom: { start: rect.top + rect.height - 1, endExclusive: rect.top + rect.height },
  }
}

function syntheticCase() {
  const width = 256
  const height = 256
  const data = new Uint8Array(width * height * 4)
  const referenceMask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const foreground = x >= 90 && x < 164 && y >= 54 && y < 206
      data.set(foreground ? [226, 36, 42, 255] : [228, 228, 228, 255], index * 4)
      if (foreground) referenceMask[index] = 1
    }
  }
  const wholeRegion = { left: 76, top: 40, width: 100, height: 180 }
  return {
    id: 'synthetic-red-panel-v1',
    target: 'red rectangle',
    image: { data, width, height, format: 'rgba8' },
    seedRegion: { left: 111, top: 90, width: 30, height: 30 },
    wholeRegion,
    roi: { left: 0, top: 0, width, height },
    bounds: boundsFromRect(wholeRegion),
    referenceMask,
    provenance: 'authored synthetic control',
  }
}

async function stageDevFixtures(sourceManifest, destination) {
  await fsp.mkdir(path.join(destination, 'images'), { recursive: true })
  await fsp.mkdir(path.join(destination, 'masks'), { recursive: true })
  const input = JSON.parse(await fsp.readFile(sourceManifest, 'utf8'))
  if (!Array.isArray(input) || input.length !== 5)
    throw new Error('Expected exactly five dev photo cases')
  const sourceRoot = path.dirname(sourceManifest)
  const staged = []
  const ids = new Set()
  for (const fixture of input) {
    if (!fixture || !/^photo-dev-present-[0-9]{2}$/u.test(fixture.id) || ids.has(fixture.id))
      throw new Error('Fixture manifest must contain unique dev-present photo IDs only')
    ids.add(fixture.id)
    if (!fixture.imagePath || !/^[a-f0-9]{64}$/u.test(fixture.sha256))
      throw new Error(`Fixture ${fixture.id} has incomplete source provenance`)
    const sourcePath = path.resolve(sourceRoot, fixture.imagePath)
    const sourceBytes = await fsp.readFile(sourcePath)
    if (digest(sourceBytes) !== fixture.sha256)
      throw new Error(`Photo hash mismatch: ${fixture.id}`)
    const extension = path.extname(sourcePath).toLowerCase() || '.img'
    const imageRelative = path.join('images', `${fixture.id}${extension}`)
    await fsp.writeFile(path.join(destination, imageRelative), sourceBytes)
    const item = { ...fixture, imagePath: imageRelative }
    if (
      fixture.referenceMaskPath &&
      fixture.referenceMaskSha256 &&
      fixture.referenceMaskFormat === 'png-binary'
    ) {
      const maskSource = path.resolve(sourceRoot, fixture.referenceMaskPath)
      const maskBytes = await fsp.readFile(maskSource)
      if (digest(maskBytes) !== fixture.referenceMaskSha256)
        throw new Error(`Mask hash mismatch: ${fixture.id}`)
      const maskRelative = path.join('masks', `${fixture.id}.png`)
      await fsp.writeFile(path.join(destination, maskRelative), maskBytes)
      item.referenceMaskPath = maskRelative
    } else {
      throw new Error(`Fixture ${fixture.id} is missing the independent PNG reference mask`)
    }
    staged.push(item)
  }
  const manifestPath = path.join(destination, 'manifest.json')
  await fsp.writeFile(manifestPath, `${JSON.stringify(staged, null, 2)}\n`)
  return manifestPath
}

async function readDevFixtures(manifestPath, profile) {
  const sharp = createRequire(path.join(profile, 'package.json'))('sharp')
  const raw = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
  if (!Array.isArray(raw) || raw.length !== 5)
    throw new Error('Expected exactly five dev photo cases')
  const ids = new Set()
  const cases = []
  for (const [index, fixture] of raw.entries()) {
    if (!fixture || !/^photo-dev-present-[0-9]{2}$/u.test(fixture.id) || ids.has(fixture.id))
      throw new Error('Fixture manifest must contain unique dev-present photo IDs only')
    ids.add(fixture.id)
    if (!fixture.imagePath || !/^[a-f0-9]{64}$/u.test(fixture.sha256))
      throw new Error(`Fixture ${fixture.id} has incomplete source provenance`)
    const sourcePath = path.resolve(path.dirname(manifestPath), fixture.imagePath)
    const sourceBytes = await fsp.readFile(sourcePath)
    if (digest(sourceBytes) !== fixture.sha256)
      throw new Error(`Photo hash mismatch: ${fixture.id}`)
    const decoded = await sharp(sourceBytes, { limitInputPixels: 16_777_216, failOn: 'error' })
      .rotate()
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const image = {
      data: new Uint8Array(decoded.data),
      width: decoded.info.width,
      height: decoded.info.height,
      format: 'rgba8',
    }
    let referenceMask
    if (
      fixture.referenceMaskPath &&
      fixture.referenceMaskSha256 &&
      fixture.referenceMaskFormat === 'png-binary'
    ) {
      const maskPath = path.resolve(path.dirname(manifestPath), fixture.referenceMaskPath)
      const maskBytes = await fsp.readFile(maskPath)
      if (digest(maskBytes) !== fixture.referenceMaskSha256)
        throw new Error(`Mask hash mismatch: ${fixture.id}`)
      const decodedMask = await sharp(maskBytes, { limitInputPixels: 16_777_216, failOn: 'error' })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true })
      if (decodedMask.info.width !== image.width || decodedMask.info.height !== image.height)
        throw new Error(`Mask dimensions mismatch: ${fixture.id}`)
      referenceMask = new Uint8Array(decodedMask.data.length)
      for (let pixel = 0; pixel < decodedMask.data.length; pixel++) {
        const value = decodedMask.data[pixel]
        if (value !== 0 && value !== 255) throw new Error(`Mask is not binary: ${fixture.id}`)
        referenceMask[pixel] = value === 255 ? 1 : 0
      }
    } else {
      throw new Error(`Fixture ${fixture.id} is missing the independent PNG reference mask`)
    }
    const regions = [
      fixture.seedRegion,
      fixture.wholeRegion,
      fixture.roi ?? { left: 0, top: 0, width: image.width, height: image.height },
    ]
    if (
      regions.some(
        (rect) =>
          rect.left < 0 ||
          rect.top < 0 ||
          rect.width < 1 ||
          rect.height < 1 ||
          rect.left + rect.width > image.width ||
          rect.top + rect.height > image.height,
      )
    )
      throw new Error(`Fixture geometry lies outside photo: ${fixture.id}`)
    cases.push({
      id: fixture.id,
      target: fixture.target,
      image,
      seedRegion: fixture.seedRegion,
      wholeRegion: fixture.wholeRegion,
      roi: fixture.roi ?? { left: 0, top: 0, width: image.width, height: image.height },
      bounds: boundsFromRect(fixture.wholeRegion),
      referenceMask,
      provenance: {
        sourceUrl: fixture.sourceUrl,
        license: fixture.license,
        photoSha256: fixture.sha256,
        maskSha256: fixture.referenceMaskSha256,
        order: index,
      },
    })
  }
  return cases
}

function inputFor(item, signal) {
  return {
    image: { ...item.image, data: new Uint8Array(item.image.data) },
    seedRegion: { ...item.seedRegion },
    wholeRegion: { ...item.wholeRegion },
    bounds: item.bounds,
    roi: { ...item.roi },
    target: item.target,
    exclusions: [],
    completeness: 'visible-object',
    signal,
  }
}

function maskMetrics(predicted, reference, width, height) {
  if (predicted.length !== reference.length || predicted.length !== width * height)
    throw new Error('Native mask dimensions do not match the source mask')
  let intersection = 0
  let union = 0
  let predictedPixels = 0
  for (let i = 0; i < predicted.length; i++) {
    const a = predicted[i]
    const b = reference[i]
    if ((a !== 0 && a !== 1) || (b !== 0 && b !== 1)) throw new Error('Mask is not binary')
    predictedPixels += a
    if (a || b) union++
    if (a && b) intersection++
  }
  return { predictedPixels, iou: union === 0 ? 0 : intersection / union }
}

async function runOne(segmenter, item) {
  const started = Date.now()
  try {
    const result = await segmenter.segment(inputFor(item, new globalThis.AbortController().signal))
    if (result.status === 'unknown')
      return { caseId: item.id, status: 'unknown', durationMs: Date.now() - started }
    const metrics = item.referenceMask
      ? maskMetrics(result.mask.data, item.referenceMask, item.image.width, item.image.height)
      : undefined
    return {
      caseId: item.id,
      status: 'segmented',
      durationMs: Date.now() - started,
      ...(metrics ?? {}),
      metadata: result.metadata,
    }
  } catch (error) {
    return {
      caseId: item.id,
      status: 'failed',
      durationMs: Date.now() - started,
      errorCode:
        typeof error === 'object' && error !== null && 'code' in error ? error.code : 'UNEXPECTED',
    }
  }
}

async function runWorker(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error(`Expected native Windows x64 Node, got ${process.platform}/${process.arch}`)
  const reportPath = path.resolve(options.report)
  const freeBytes = freeBytesAt(os.tmpdir())
  let root
  let segmenter
  const ownedPids = new Set()
  let childStarts = 0
  let childCloses = 0
  const report = {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    osRelease: os.release(),
    osVersion: typeof os.version === 'function' ? os.version() : null,
    npm: null,
    dependencies: { [PACKAGE_NAME]: null, 'onnxruntime-node': null, sharp: null },
    executionProvider: 'cpu',
    intraOpThreads: 1,
    latencyTag: options.linuxSoakConcurrent
      ? 'concurrent-with-linux-soak'
      : 'not-declared-concurrent',
    scope: 'native-segmentation-component; no classifier or vision locator calls',
    tempRoot: null,
    freeBytesBeforeInstall: freeBytes,
    packageArchiveSha256: null,
    runtimeImport: 'not-run',
    declarationProbe: 'not-run',
    cpuSessionProbe: 'not-run',
    modelAssets: {},
    photoCases: [],
    fixtureProvenance: [],
    syntheticCase: null,
    lifecycle: null,
    processOwnership: null,
    cleanupErrors: [],
    checks: {},
    photoQuality: null,
    acceptance: false,
  }
  const onChild = (event) => {
    if (!event || typeof event !== 'object') return
    if (event.type === 'start' && Number.isInteger(event.pid)) {
      ownedPids.add(event.pid)
      childStarts++
    }
    if (event.type === 'close' && Number.isInteger(event.pid)) {
      ownedPids.delete(event.pid)
      childCloses++
    }
  }
  childChannel.subscribe(onChild)
  try {
    if (freeBytes !== null && freeBytes < 2 * 1024 ** 3)
      throw new Error(
        'Windows temp drive has less than 2 GiB free; refusing dependency installation',
      )
    root = winTemp()
    report.tempRoot = root
    const profile = path.join(root, 'profile')
    const weights = path.join(root, 'weights')
    const fixturesDir = path.join(root, 'fixtures')
    const copiedArchive = path.join(root, 'verified-package.tgz')
    const userConfig = path.join(root, 'user.npmrc')
    const globalConfig = path.join(root, 'global.npmrc')
    await fsp.writeFile(userConfig, '# isolated user npm configuration\n', { flag: 'wx' })
    await fsp.writeFile(globalConfig, '# isolated global npm configuration\n', { flag: 'wx' })
    report.packageArchiveSha256 = await stageVerifiedArchive(
      options.archive,
      copiedArchive,
      options.sha256,
    )
    assertFile(options.encoder, encoderAsset, 'MobileSAM encoder')
    assertFile(options.decoder, decoderAsset, 'MobileSAM multi decoder')
    const encoderPath = path.join(weights, encoderAsset.name)
    const decoderPath = path.join(weights, decoderAsset.name)
    await fsp.copyFile(options.encoder, encoderPath)
    await fsp.copyFile(options.decoder, decoderPath)
    report.modelAssets.encoder = { ...encoderAsset }
    report.modelAssets.decoder = { ...decoderAsset }
    const stagedManifest = await stageDevFixtures(options.fixtures, fixturesDir)
    const packageJson = {
      name: 'zorya-v02-native-windows-profile',
      private: true,
      type: 'module',
      dependencies: {
        [PACKAGE_NAME]: 'file:../verified-package.tgz',
        'onnxruntime-node': ORT_VERSION,
        typescript: TS_VERSION,
        '@types/node': NODE_TYPES_VERSION,
      },
    }
    await fsp.writeFile(
      path.join(profile, 'package.json'),
      `${JSON.stringify(packageJson, null, 2)}\n`,
      { flag: 'wx' },
    )
    const env = cleanChildEnvironment(userConfig, globalConfig, path.join(root, 'npm-cache'))
    const npmCli = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    )
    report.npm = run(process.execPath, [npmCli, '--version'], {
      cwd: profile,
      env,
      label: 'Windows npm version probe',
    }).trim()
    npmInstall(profile, env, [])
    await writeDeclarationProbe(profile)
    const fixtureItems = await readDevFixtures(stagedManifest, profile)
    const photoIds = fixtureItems.map((item) => item.id)
    if (new Set(photoIds).size !== 5 || photoIds.some((id) => !id.startsWith('photo-dev-present-')))
      throw new Error('Acceptance inputs must remain exactly the five heldout-disjoint dev photos')
    report.fixtureProvenance = fixtureItems.map(({ id, provenance }) => ({ id, ...provenance }))

    const runtimeProbe = path.join(profile, 'runtime-probe.mjs')
    await fsp.writeFile(
      runtimeProbe,
      [
        "import * as core from 'zorya-classifier'",
        "import * as segmentation from 'zorya-classifier/segmentation'",
        'export { core, segmentation }',
        '',
      ].join('\n'),
      { flag: 'wx' },
    )
    process.chdir(profile)
    const { core, segmentation } = await import(pathToFileURL(runtimeProbe).href)
    if (
      typeof core.createClassifier !== 'function' ||
      typeof segmentation.createMobileSamSegmenter !== 'function'
    )
      throw new Error('Public core or segmentation runtime exports are missing')
    report.runtimeImport = 'passed'
    for (const dependency of [PACKAGE_NAME, 'onnxruntime-node', 'sharp']) {
      const metadata = JSON.parse(
        await fsp.readFile(path.join(profile, 'node_modules', dependency, 'package.json'), 'utf8'),
      )
      report.dependencies[dependency] = metadata.version
    }
    const ort = createRequire(path.join(profile, 'package.json'))('onnxruntime-node')
    if (!ort.InferenceSession?.create)
      throw new Error('onnxruntime-node has no InferenceSession.create export')
    const cpuProbe = await ort.InferenceSession.create(encoderPath, {
      executionProviders: ['cpu'],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    })
    await cpuProbe.release()
    report.cpuSessionProbe = 'passed-cpu-only'
    report.declarationProbe = 'passed'

    segmenter = await segmentation.createMobileSamSegmenter({
      encoderPath,
      decoderPath,
      executionProvider: 'cpu',
      threads: 1,
    })
    const samples = [syntheticCase(), ...fixtureItems]
    const records = []
    for (const sample of samples) records.push(await runOne(segmenter, sample))
    report.syntheticCase = records[0]
    report.photoCases = records.slice(1)

    const cancelController = new globalThis.AbortController()
    const cancelPromise = segmenter.segment(inputFor(samples[0], cancelController.signal))
    const cancelTimer = globalThis.setTimeout(
      () => cancelController.abort(new Error('Windows acceptance cancellation')),
      50,
    )
    let cancellationCode = 'NOT_CANCELLED'
    try {
      await cancelPromise
    } catch (error) {
      cancellationCode =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : 'UNEXPECTED'
    } finally {
      globalThis.clearTimeout(cancelTimer)
    }
    await segmenter.settle()

    const queued = Array.from({ length: 4 }, () =>
      segmenter.segment(inputFor(samples[0], new globalThis.AbortController().signal)),
    )
    const queuedResults = await Promise.allSettled(queued)
    const capacityRejected = queuedResults.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason &&
        typeof result.reason === 'object' &&
        result.reason.code === 'CAPACITY',
    ).length
    await segmenter.settle()
    await segmenter.dispose()
    await segmenter.dispose()
    let disposedCode = 'NOT_REJECTED'
    try {
      await segmenter.segment(inputFor(samples[0], new globalThis.AbortController().signal))
    } catch (error) {
      disposedCode =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : 'UNEXPECTED'
    }
    report.lifecycle = {
      cancellationCode,
      queueCapacityRejected: capacityRejected,
      queueSettled: queuedResults.length,
      queueFulfilled: queuedResults.filter((result) => result.status === 'fulfilled').length,
      disposedIdempotently: true,
      afterDisposeCode: disposedCode,
    }
  } catch (error) {
    report.failure = error instanceof Error ? error.message : 'Native Windows acceptance failed'
  } finally {
    const cleanupErrors = []
    if (segmenter) {
      try {
        await segmenter.settle()
      } catch (error) {
        cleanupErrors.push(`settle: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        await segmenter.dispose()
      } catch (error) {
        cleanupErrors.push(`dispose: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const drainDeadline = Date.now() + 5000
    while (ownedPids.size > 0 && Date.now() < drainDeadline)
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100))
    report.processOwnership = {
      starts: childStarts,
      closes: childCloses,
      stillOwnedPids: [...ownedPids],
    }
    childChannel.unsubscribe(onChild)
    report.cleanupErrors = cleanupErrors
    const photos = report.photoCases
    const ids = photos.map((item) => item.caseId)
    const allPhotoCasesSegmented =
      photos.length === 5 &&
      new Set(ids).size === 5 &&
      photos.every((item) => item.status === 'segmented' && Number.isFinite(item.iou))
    const syntheticQualityPassed =
      report.syntheticCase?.status === 'segmented' &&
      Number.isFinite(report.syntheticCase.iou) &&
      report.syntheticCase.iou >= 0.98
    const photoThreshold = 0.8
    report.photoQuality = {
      threshold: photoThreshold,
      caseCount: photos.length,
      meanIou:
        photos.length > 0 && photos.every((item) => Number.isFinite(item.iou))
          ? photos.reduce((sum, item) => sum + item.iou, 0) / photos.length
          : null,
      minimumIou:
        photos.length > 0 && photos.every((item) => Number.isFinite(item.iou))
          ? Math.min(...photos.map((item) => item.iou))
          : null,
      belowThreshold: photos
        .filter((item) => !Number.isFinite(item.iou) || item.iou < photoThreshold)
        .map((item) => ({ caseId: item.caseId, iou: item.iou ?? null })),
    }
    report.checks = {
      runtimeImport: report.runtimeImport === 'passed',
      declarationProbe: report.declarationProbe === 'passed',
      cpuSessionProbe: report.cpuSessionProbe === 'passed-cpu-only',
      syntheticSegmented: report.syntheticCase?.status === 'segmented',
      syntheticQuality: syntheticQualityPassed,
      allExpectedPositivePhotosSegmented: allPhotoCasesSegmented,
      cancellation: report.lifecycle?.cancellationCode === 'ABORTED',
      capacity:
        report.lifecycle?.queueCapacityRejected === 1 && report.lifecycle?.queueSettled === 4,
      disposal:
        report.lifecycle?.disposedIdempotently === true &&
        report.lifecycle?.afterDisposeCode === 'DISPOSED',
      processOwnership:
        childStarts === childCloses &&
        ownedPids.size === 0 &&
        report.processOwnership.stillOwnedPids.length === 0,
      cleanup: null,
    }
    report.acceptance = false
    try {
      await fsp.mkdir(path.dirname(reportPath), { recursive: true })
      await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    } catch (error) {
      process.stderr.write(
        `Could not preserve acceptance report: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 1
    }
  }
  const workerChecks = Object.entries(report.checks).filter(([key]) => key !== 'cleanup')
  if (!workerChecks.every(([, passed]) => passed === true)) process.exitCode = 1
}

function safeOwnedTempRoot(tempRoot) {
  if (typeof tempRoot !== 'string') return false
  const base = path.resolve(os.tmpdir())
  const resolved = path.resolve(tempRoot)
  const relative = path.relative(base, resolved)
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep) &&
    path.basename(resolved).startsWith('zorya-classifier-v02-native-')
  )
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.at(-1) === '--internal-worker') {
    if (process.env.ZORYA_NATIVE_ACCEPTANCE_WORKER !== '1')
      throw new Error('Internal worker mode cannot be started directly')
    await runWorker(argv.slice(0, -1))
    return
  }

  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error(`Expected native Windows x64 Node, got ${process.platform}/${process.arch}`)
  const reportPath = path.resolve(options.report)
  if (fs.existsSync(reportPath)) throw new Error(`Refusing to overwrite report: ${reportPath}`)
  const worker = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), ...argv, '--internal-worker'],
    {
      env: { ...process.env, ZORYA_NATIVE_ACCEPTANCE_WORKER: '1' },
      encoding: 'utf8',
      timeout: 1_800_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  )
  let report
  const reportExists = fs.existsSync(reportPath)
  try {
    report = JSON.parse(await fsp.readFile(reportPath, 'utf8'))
  } catch {
    report = {
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      cleanupErrors: [],
      checks: {},
      acceptance: false,
      failure: 'Worker did not preserve an acceptance report',
    }
  }
  const cleanupErrors = Array.isArray(report.cleanupErrors) ? report.cleanupErrors : []
  if (report.tempRoot) {
    if (!safeOwnedTempRoot(report.tempRoot)) {
      cleanupErrors.push('refused temp cleanup because report path is outside owned WinTemp')
    } else {
      try {
        await fsp.rm(report.tempRoot, { recursive: true, force: true })
      } catch (error) {
        cleanupErrors.push(
          `temp cleanup: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  report.cleanupErrors = cleanupErrors
  report.workerStatus = worker.status
  report.workerError = worker.error?.message ?? null
  report.checks = {
    ...report.checks,
    worker: worker.error === undefined && worker.signal === null && worker.status === 0,
    cleanup: cleanupErrors.length === 0,
  }
  report.acceptance = Object.values(report.checks).every((passed) => passed === true)
  try {
    await fsp.mkdir(path.dirname(reportPath), { recursive: true })
    await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: reportExists ? 'w' : 'wx',
    })
  } catch (error) {
    process.stderr.write(
      `Could not finalize acceptance report: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.acceptance) process.exitCode = 1
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Native Windows acceptance failed'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
