#!/usr/bin/env node
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_NAME = 'zorya-classifier'
const GRABCUT_FIX_COMMIT = '022ca0e1ea4219cb7c6b51445046ae5be3a224d0'
const OPENCV = {
  name: 'opencv-4.13.0.js',
  bytes: 10_964_323,
  sha256: '63366510248adf3a7eddf3e793dd825404efb7df3749f4d6f8557c7fa4ca8aa0',
  url: 'https://docs.opencv.org/4.13.0/opencv.js',
}
const FIXTURE_IDS = [
  'photo-dev-present-06',
  'photo-dev-present-08',
  'photo-dev-present-09',
  'photo-dev-present-13',
  'photo-dev-present-15',
]
const resourceChannel = channel('zorya.segmentation.child-resource')

function usage() {
  return [
    'Usage: node native-grabcut-windows-acceptance.mjs --archive=<verified .tgz> --sha256=<archive sha256> --source-commit=<full archive source commit>',
    '       --opencv=<official pinned OpenCV.js 4.13.0> --fixtures=<corrected fixture manifest>',
    '       --fixture-base=<directory used by relative photo/mask paths> --source-root=<allowed source ancestor> --report=<new report path>',
  ].join('\n')
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const allowed = new Set([
    'archive',
    'sha256',
    'source-commit',
    'opencv',
    'fixtures',
    'fixture-base',
    'source-root',
    'report',
  ])
  const result = {}
  for (const arg of argv) {
    const match = /^--([a-z][a-z0-9-]*)=(.*)$/u.exec(arg)
    if (!match || !allowed.has(match[1])) throw new Error(`Invalid argument: ${arg}`)
    const key = match[1].replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate argument: --${match[1]}`)
    result[key] = match[2]
  }
  for (const key of [
    'archive',
    'sha256',
    'sourceCommit',
    'opencv',
    'fixtures',
    'fixtureBase',
    'sourceRoot',
    'report',
  ])
    if (typeof result[key] !== 'string' || result[key].length === 0)
      throw new Error(`Missing --${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`)
  if (!/^[a-f0-9]{64}$/u.test(result.sha256)) throw new Error('--sha256 must be lowercase SHA-256')
  if (!/^[a-f0-9]{40}$/u.test(result.sourceCommit))
    throw new Error('--source-commit must be a full lowercase Git SHA')
  return result
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function createOwnedTemp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zorya-classifier-v02-grabcut-win-'))
  for (const directory of ['profile', 'assets', 'fixtures', 'npm-cache'])
    fs.mkdirSync(path.join(root, directory), { recursive: true })
  return root
}

function cleanNpmEnvironment(root) {
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (
      /^npm_config_/iu.test(key) ||
      /npm.*(token|auth|password)|(^|_)auth(token|key)?$/iu.test(key)
    )
      delete env[key]
  const userConfig = path.join(root, 'npm-user.npmrc')
  const globalConfig = path.join(root, 'npm-global.npmrc')
  fs.writeFileSync(userConfig, '# isolated native acceptance user config\n', { flag: 'wx' })
  fs.writeFileSync(globalConfig, '# isolated native acceptance global config\n', { flag: 'wx' })
  env.NPM_CONFIG_USERCONFIG = userConfig
  env.NPM_CONFIG_GLOBALCONFIG = globalConfig
  env.NPM_CONFIG_CACHE = path.join(root, 'npm-cache')
  env.NPM_CONFIG_AUDIT = 'false'
  env.NPM_CONFIG_FUND = 'false'
  return env
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 240_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error) throw new Error(`${options.label} failed to start`)
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`
      .replace(/https?:\/\/[^\s]+/gu, '[registry output omitted]')
      .slice(-1200)
    throw new Error(`${options.label} failed (${String(result.status)}): ${detail}`)
  }
  return result.stdout ?? ''
}

async function stageAsset(sourcePath, destination, expected) {
  const source = await readBoundedFile(sourcePath, expected.bytes)
  if (source.byteLength !== expected.bytes || digest(source) !== expected.sha256)
    throw new Error(`${expected.name} failed its pinned size/hash check`)
  await fsp.writeFile(destination, source, { flag: 'wx' })
  return { path: destination, bytes: source.byteLength, sha256: expected.sha256, url: expected.url }
}

async function stageArchive(sourcePath, destination, expectedHash) {
  const bytes = await readBoundedFile(sourcePath, 64 * 1024 * 1024)
  const actual = digest(bytes)
  if (actual !== expectedHash) throw new Error('Package archive SHA-256 does not match')
  await fsp.writeFile(destination, bytes, { flag: 'wx' })
  return { path: destination, bytes: bytes.length, sha256: actual }
}

async function readBoundedFile(sourcePath, maxBytes) {
  const handle = await fsp.open(sourcePath, 'r')
  let stream
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maxBytes)
      throw new Error(`Input must be a regular file no larger than ${maxBytes} bytes`)
    const chunks = []
    let bytesRead = 0
    stream = handle.createReadStream({ autoClose: false })
    for await (const chunk of stream) {
      bytesRead += chunk.byteLength
      if (bytesRead > maxBytes) throw new Error(`Input grew beyond its ${maxBytes}-byte limit`)
      chunks.push(Buffer.from(chunk))
    }
    const after = await handle.stat()
    if (bytesRead !== before.size || after.size !== before.size)
      throw new Error('Input changed size while it was being read')
    return Buffer.concat(chunks, bytesRead)
  } finally {
    stream?.destroy()
    await handle.close()
  }
}

function insideSource(root, base, relative) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(base, relative)
  const rel = path.relative(resolvedRoot, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
    throw new Error('Fixture path escapes the declared source root')
  return resolved
}

async function stageFixtures(manifestPath, fixtureBase, sourceRoot, destination) {
  const sourceBytes = await fsp.readFile(manifestPath)
  const manifest = JSON.parse(sourceBytes.toString('utf8'))
  const fixtures = Array.isArray(manifest) ? manifest : manifest?.fixtures
  if (!Array.isArray(fixtures) || fixtures.length !== FIXTURE_IDS.length)
    throw new Error('Expected exactly five corrected development photos')
  const staged = []
  for (let index = 0; index < FIXTURE_IDS.length; index++) {
    const fixture = fixtures[index]
    if (!fixture || fixture.id !== FIXTURE_IDS[index])
      throw new Error('Corrected fixture order/IDs do not match the frozen five-photo panel')
    if (
      !/^[a-f0-9]{64}$/u.test(fixture.sha256) ||
      !/^[a-f0-9]{64}$/u.test(fixture.referenceMaskSha256)
    )
      throw new Error(`Fixture ${fixture.id} has incomplete source hashes`)
    const photo = await fsp.readFile(insideSource(sourceRoot, fixtureBase, fixture.imagePath))
    const mask = await fsp.readFile(
      insideSource(sourceRoot, fixtureBase, fixture.referenceMaskPath),
    )
    if (digest(photo) !== fixture.sha256 || digest(mask) !== fixture.referenceMaskSha256)
      throw new Error(`Fixture ${fixture.id} photo/mask hash mismatch`)
    const extension = path.extname(fixture.imagePath) || '.img'
    const imagePath = path.join(destination, `${fixture.id}${extension}`)
    const maskPath = path.join(destination, `${fixture.id}.png`)
    await fsp.writeFile(imagePath, photo, { flag: 'wx' })
    await fsp.writeFile(maskPath, mask, { flag: 'wx' })
    staged.push({ ...fixture, imagePath, referenceMaskPath: maskPath })
  }
  return {
    fixtures: staged,
    manifestSha256: digest(sourceBytes),
    imageAndMaskCount: staged.length * 2,
  }
}

function boundsFromRect(rect) {
  return {
    left: { start: rect.left, endExclusive: rect.left + 1 },
    right: { start: rect.left + rect.width - 1, endExclusive: rect.left + rect.width },
    top: { start: rect.top, endExclusive: rect.top + 1 },
    bottom: { start: rect.top + rect.height - 1, endExclusive: rect.top + rect.height },
  }
}

function inputFor(item, signal) {
  return {
    image: {
      data: item.image.data,
      width: item.image.width,
      height: item.image.height,
      format: 'rgba8',
    },
    seedRegion: item.seedRegion,
    wholeRegion: item.wholeRegion,
    bounds: boundsFromRect(item.wholeRegion),
    roi: { left: 0, top: 0, width: item.image.width, height: item.image.height },
    target: item.target,
    exclusions: [],
    completeness: 'visible-object',
    signal,
  }
}

function countSeedPixels(mask, width, rect) {
  let count = 0
  for (let y = rect.top; y < rect.top + rect.height; y++)
    for (let x = rect.left; x < rect.left + rect.width; x++) if (mask[y * width + x] === 1) count++
  return count
}

function maskIoU(prediction, reference) {
  if (prediction.length !== reference.length) throw new Error('Native mask dimensions mismatch')
  let intersection = 0,
    union = 0
  for (let i = 0; i < prediction.length; i++) {
    const a = prediction[i],
      b = reference[i]
    if ((a !== 0 && a !== 1) || (b !== 0 && b !== 1)) throw new Error('Mask values are not binary')
    if (a && b) intersection++
    if (a || b) union++
  }
  return union ? intersection / union : 0
}

async function runWorker(options) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error(`Expected native Windows x64 Node, got ${process.platform}/${process.arch}`)
  const root = createOwnedTemp()
  const report = {
    schemaVersion: 1,
    backend: 'grabcut',
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    osRelease: os.release(),
    startedAt: new Date().toISOString(),
    executionProvider: 'native CPU / OpenCV.js',
    scope:
      'Corrected five-photo component plus owned-child lifecycle; annotation-derived points/boxes are evaluator-only component interventions, not end-to-end localization.',
    packageArchive: null,
    archiveSourceCommit: options.sourceCommit,
    grabcutFixCommit: GRABCUT_FIX_COMMIT,
    opencvAsset: null,
    fixtureManifest: null,
    fixtures: [],
    lifecycle: null,
    childOwnership: { starts: 0, closes: 0, stillOwnedPids: [] },
    checks: {},
    cleanupErrors: [],
    tempRoot: root,
    failure: null,
  }
  const ownedPids = new Set()
  const onChild = (event) => {
    if (!event || typeof event !== 'object') return
    if (event.type === 'start' && Number.isInteger(event.pid)) {
      ownedPids.add(event.pid)
      report.childOwnership.starts++
    } else if (event.type === 'close' && Number.isInteger(event.pid)) {
      ownedPids.delete(event.pid)
      report.childOwnership.closes++
    }
  }
  resourceChannel.subscribe(onChild)
  let segmenter
  let outputPath
  try {
    outputPath = path.resolve(options.report)
    if (path.resolve(outputPath).startsWith(`${path.resolve(root)}${path.sep}`))
      throw new Error('Report path must be outside the owned temporary directory')
    if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite report: ${outputPath}`)
    const profile = path.join(root, 'profile')
    const packageTar = path.join(root, 'verified-package.tgz')
    const assetPath = path.join(root, 'assets', OPENCV.name)
    report.packageArchive = await stageArchive(options.archive, packageTar, options.sha256)
    report.opencvAsset = await stageAsset(options.opencv, assetPath, OPENCV)
    const staged = await stageFixtures(
      options.fixtures,
      options.fixtureBase,
      options.sourceRoot,
      path.join(root, 'fixtures'),
    )
    report.fixtureManifest = { path: options.fixtures, sha256: staged.manifestSha256 }
    const pkg = {
      name: 'zorya-grabcut-windows-profile',
      private: true,
      type: 'module',
      dependencies: { [PACKAGE_NAME]: 'file:../verified-package.tgz' },
    }
    await fsp.writeFile(path.join(profile, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, {
      flag: 'wx',
    })
    const env = cleanNpmEnvironment(root)
    const npmCli = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    )
    if (!fs.existsSync(npmCli)) throw new Error('npm-cli.js is missing beside Windows Node.js')
    report.npm = run(process.execPath, [npmCli, '--version'], {
      cwd: profile,
      env,
      label: 'Windows npm version probe',
    }).trim()
    run(
      process.execPath,
      [
        npmCli,
        'install',
        '--ignore-scripts',
        '--omit=peer',
        '--no-save',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
        '--legacy-peer-deps',
      ],
      { cwd: profile, env, label: 'Windows local package installation' },
    )
    const sharp = createRequire(path.join(profile, 'package.json'))('sharp')
    const runtimeProbe = path.join(profile, 'grabcut-runtime-probe.mjs')
    await fsp.writeFile(
      runtimeProbe,
      "import { createGrabCutSegmenter } from 'zorya-classifier/segmentation'; export { createGrabCutSegmenter }\n",
      { flag: 'wx' },
    )
    const { createGrabCutSegmenter } = await import(pathToFileURL(runtimeProbe).href)
    if (typeof createGrabCutSegmenter !== 'function')
      throw new Error('Package archive misses createGrabCutSegmenter')
    segmenter = await createGrabCutSegmenter({ assetPath })
    const items = []
    for (const fixture of staged.fixtures) {
      const photo = await fsp.readFile(fixture.imagePath)
      const decoded = await sharp(photo, { limitInputPixels: 16_777_216, failOn: 'error' })
        .rotate()
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const maskBytes = await fsp.readFile(fixture.referenceMaskPath)
      const mask = await sharp(maskBytes, { limitInputPixels: 16_777_216, failOn: 'error' })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true })
      if (mask.info.width !== decoded.info.width || mask.info.height !== decoded.info.height)
        throw new Error(`Mask dimensions mismatch: ${fixture.id}`)
      const reference = new Uint8Array(mask.data.length)
      for (let i = 0; i < mask.data.length; i++) {
        if (mask.data[i] !== 0 && mask.data[i] !== 255)
          throw new Error(`Reference mask not binary: ${fixture.id}`)
        reference[i] = mask.data[i] === 255 ? 1 : 0
      }
      let referenceSeedPixels = 0
      for (
        let y = fixture.seedRegion.top;
        y < fixture.seedRegion.top + fixture.seedRegion.height;
        y++
      )
        for (
          let x = fixture.seedRegion.left;
          x < fixture.seedRegion.left + fixture.seedRegion.width;
          x++
        )
          if (reference[y * decoded.info.width + x] === 1) referenceSeedPixels++
      if (referenceSeedPixels === 0)
        throw new Error(`Corrected seed does not intersect ${fixture.id} reference mask`)
      items.push({
        id: fixture.id,
        target: fixture.target,
        image: {
          data: new Uint8Array(decoded.data),
          width: decoded.info.width,
          height: decoded.info.height,
        },
        seedRegion: fixture.seedRegion,
        wholeRegion: fixture.wholeRegion,
        reference,
        referenceSeedPixels,
        imageSha256: fixture.sha256,
        maskSha256: fixture.referenceMaskSha256,
      })
    }
    for (const item of items) {
      const started = Date.now()
      try {
        const result = await segmenter.segment(
          inputFor(item, new globalThis.AbortController().signal),
        )
        report.fixtures.push(
          result.status === 'segmented'
            ? {
                id: item.id,
                status: result.status,
                iou: maskIoU(result.mask.data, item.reference),
                durationMs: Date.now() - started,
                method: result.metadata.method,
                backend: result.metadata.backend,
                referenceSeedPixels: item.referenceSeedPixels,
                predictedSeedPixels: countSeedPixels(
                  result.mask.data,
                  item.image.width,
                  item.seedRegion,
                ),
                imageSha256: item.imageSha256,
                maskSha256: item.maskSha256,
              }
            : {
                id: item.id,
                status: result.status,
                reason: result.reason,
                durationMs: Date.now() - started,
                imageSha256: item.imageSha256,
                maskSha256: item.maskSha256,
              },
        )
      } catch (error) {
        report.fixtures.push({
          id: item.id,
          status: 'failed',
          errorCode:
            typeof error === 'object' && error && 'code' in error ? error.code : 'UNEXPECTED',
          durationMs: Date.now() - started,
          imageSha256: item.imageSha256,
          maskSha256: item.maskSha256,
        })
      }
    }
    const cancelController = new globalThis.AbortController()
    const cancellationStarted = Date.now()
    const cancellation = segmenter.segment(inputFor(items[0], cancelController.signal))
    const abortTimer = globalThis.setTimeout(
      () =>
        cancelController.abort(
          Object.assign(new Error('Windows GrabCut acceptance abort'), { code: 'ABORTED' }),
        ),
      50,
    )
    let cancellationCode = 'NOT_CANCELLED'
    try {
      await cancellation
    } catch (error) {
      cancellationCode =
        typeof error === 'object' && error && 'code' in error ? error.code : 'UNEXPECTED'
    }
    globalThis.clearTimeout(abortTimer)
    report.lifecycle = {
      cancellationCode,
      cancellationDurationMs: Date.now() - cancellationStarted,
      cancellationPhysicalCloseConfirmed:
        report.childOwnership.starts > 0 &&
        report.childOwnership.starts === report.childOwnership.closes &&
        ownedPids.size === 0,
    }
    const queued = Array.from({ length: 4 }, () =>
      segmenter.segment(inputFor(items[0], new globalThis.AbortController().signal)),
    )
    const queueResults = await Promise.allSettled(queued)
    report.lifecycle.queueFulfilledSegmented = queueResults.filter(
      (x) => x.status === 'fulfilled' && x.value?.status === 'segmented',
    ).length
    report.lifecycle.capacityRejected = queueResults.filter(
      (x) => x.status === 'rejected' && x.reason?.code === 'CAPACITY',
    ).length
    report.lifecycle.queueOtherFailures = queueResults.filter(
      (x) => x.status === 'rejected' && x.reason?.code !== 'CAPACITY',
    ).length
    report.lifecycle.queueSettled = queueResults.length
    await segmenter.settle()
    await segmenter.dispose()
    await segmenter.dispose()
    let afterDisposeCode = 'NOT_REJECTED'
    try {
      await segmenter.segment(inputFor(items[0], new globalThis.AbortController().signal))
    } catch (error) {
      afterDisposeCode =
        typeof error === 'object' && error && 'code' in error ? error.code : 'UNEXPECTED'
    }
    report.lifecycle.afterDisposeCode = afterDisposeCode
  } catch (error) {
    report.failure = error instanceof Error ? error.message : 'Windows GrabCut acceptance failed'
  } finally {
    if (segmenter) {
      try {
        await segmenter.settle()
      } catch (error) {
        report.cleanupErrors.push(
          `settle: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      try {
        await segmenter.dispose()
      } catch (error) {
        report.cleanupErrors.push(
          `dispose: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    const drainUntil = Date.now() + 5000
    while (ownedPids.size && Date.now() < drainUntil)
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100))
    report.childOwnership.stillOwnedPids = [...ownedPids]
    resourceChannel.unsubscribe(onChild)
    report.endedAt = new Date().toISOString()
    const allSegmented =
      report.fixtures.length === 5 && report.fixtures.every((x) => x.status === 'segmented')
    const life = report.lifecycle
    report.checks = {
      allFiveSegmented: allSegmented,
      cancellation:
        life?.cancellationCode === 'ABORTED' && life.cancellationPhysicalCloseConfirmed === true,
      capacity:
        life?.capacityRejected === 1 &&
        life.queueFulfilledSegmented === 3 &&
        life.queueOtherFailures === 0 &&
        life.queueSettled === 4,
      disposal: life?.afterDisposeCode === 'DISPOSED',
      childOwnership:
        report.childOwnership.starts === report.childOwnership.closes && ownedPids.size === 0,
      cleanup: report.cleanupErrors.length === 0,
    }
    report.photoQuality = {
      threshold: 0.8,
      passCount: report.fixtures.filter((x) => Number.isFinite(x.iou) && x.iou >= 0.8).length,
      belowThreshold: report.fixtures
        .filter((x) => !Number.isFinite(x.iou) || x.iou < 0.8)
        .map((x) => ({ id: x.id, iou: x.iou ?? null })),
    }
    report.checks.cleanup = report.cleanupErrors.length === 0
    report.acceptance = false
    try {
      await fsp.mkdir(path.dirname(outputPath ?? options.report), { recursive: true })
      await fsp.writeFile(outputPath ?? options.report, `${JSON.stringify(report, null, 2)}\n`, {
        flag: 'wx',
      })
    } catch (error) {
      process.stderr.write(
        `Could not preserve Windows GrabCut report: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 1
    }
  }
  if (!Object.values(report.checks).every((passed) => passed === true)) process.exitCode = 1
}

function safeOwnedTempRoot(root) {
  if (typeof root !== 'string') return false
  const base = path.resolve(os.tmpdir())
  const resolved = path.resolve(root)
  const relative = path.relative(base, resolved)
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep) &&
    path.basename(resolved).startsWith('zorya-classifier-v02-grabcut-win-')
  )
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.at(-1) === '--internal-worker') {
    if (process.env.ZORYA_GRABCUT_ACCEPTANCE_WORKER !== '1')
      throw new Error('Internal worker mode cannot be started directly')
    await runWorker(parseArgs(argv.slice(0, -1)))
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
      env: { ...process.env, ZORYA_GRABCUT_ACCEPTANCE_WORKER: '1' },
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
      backend: 'grabcut',
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
        report.tempCleanup = 'removed by coordinator after worker exit'
      } catch (error) {
        cleanupErrors.push(
          `temp cleanup: ${error instanceof Error ? error.message : String(error)}`,
        )
        report.tempCleanup = 'failed'
      }
    }
  }
  report.cleanupErrors = cleanupErrors
  report.workerStatus = worker.status
  report.workerSignal = worker.signal
  report.workerError = worker.error?.message ?? null
  report.checks = {
    ...report.checks,
    worker: worker.error === undefined && worker.signal === null && worker.status === 0,
    cleanup: cleanupErrors.length === 0 && report.tempCleanup !== 'failed',
  }
  report.acceptance = Object.values(report.checks).every((passed) => passed === true)
  try {
    await fsp.mkdir(path.dirname(reportPath), { recursive: true })
    await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: reportExists ? 'w' : 'wx',
    })
  } catch (error) {
    process.stderr.write(
      `Could not finalize Windows GrabCut report: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.acceptance) process.exitCode = 1
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Windows GrabCut acceptance failed'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
