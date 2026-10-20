#!/usr/bin/env node
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_NAME = 'zorya-classifier'
const ENCODER = {
  name: 'mobile_sam_image_encoder.onnx',
  bytes: 28_157_093,
  sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
}
const DECODER = {
  name: 'sam_mask_decoder_multi.onnx',
  bytes: 16_496_559,
  sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
}
const resourceChannel = channel('zorya.segmentation.child-resource')
const WIDTH = 256
const HEIGHT = 256
const PROPOSAL_TARGET = { left: 8, top: 8, width: 48, height: 48 }
// The first fine-grid seed center is inside this synthetic target rectangle.
const REGION_TARGET = { left: 0, top: 0, width: 64, height: 64 }

function usage() {
  return [
    'Usage: node native-proposal-windows-acceptance.mjs --archive=<verified .tgz> --sha256=<archive sha256> --source-commit=<frozen source commit>',
    '       --encoder=<pinned MobileSAM encoder> --decoder=<pinned MobileSAM decoder> --report=<new report path>',
    '       [--workflow=proposals|region-segmentation] (default: proposals)',
  ].join('\n')
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const allowed = new Set([
    'archive',
    'sha256',
    'source-commit',
    'encoder',
    'decoder',
    'report',
    'workflow',
  ])
  const result = {}
  for (const arg of argv) {
    const match = /^--([a-z][a-z0-9-]*)=(.*)$/u.exec(arg)
    if (!match || !allowed.has(match[1])) throw new Error(`Invalid argument: ${arg}`)
    const key = match[1].replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate argument: --${match[1]}`)
    result[key] = match[2]
  }
  for (const key of ['archive', 'sha256', 'sourceCommit', 'encoder', 'decoder', 'report'])
    if (typeof result[key] !== 'string' || !result[key])
      throw new Error(`Missing --${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`)
  if (!/^[a-f0-9]{64}$/u.test(result.sha256)) throw new Error('--sha256 must be lowercase SHA-256')
  if (!/^[a-f0-9]{40}$/u.test(result.sourceCommit))
    throw new Error('--source-commit must be a full lowercase Git SHA')
  result.workflow ??= 'proposals'
  if (!['proposals', 'region-segmentation'].includes(result.workflow))
    throw new Error('--workflow must be proposals or region-segmentation')
  return result
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function createOwnedTemp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zorya-classifier-v02-proposals-win-'))
  for (const directory of ['profile', 'assets', 'npm-cache'])
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
  fs.writeFileSync(userConfig, '# isolated proposal acceptance user config\n', { flag: 'wx' })
  fs.writeFileSync(globalConfig, '# isolated proposal acceptance global config\n', { flag: 'wx' })
  Object.assign(env, {
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_CACHE: path.join(root, 'npm-cache'),
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
  })
  return env
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 300_000,
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
      throw new Error('Input changed size while being read')
    return Buffer.concat(chunks, bytesRead)
  } finally {
    stream?.destroy()
    await handle.close()
  }
}

async function stagePinnedFile(sourcePath, destination, expected, maxBytes = expected.bytes) {
  const bytes = await readBoundedFile(sourcePath, maxBytes)
  if (bytes.byteLength !== expected.bytes || digest(bytes) !== expected.sha256)
    throw new Error(`${expected.name} failed its pinned size/hash check`)
  await fsp.writeFile(destination, bytes, { flag: 'wx' })
  return { path: destination, bytes: bytes.byteLength, sha256: expected.sha256 }
}

function insideTemp(root) {
  const base = path.resolve(os.tmpdir())
  const resolved = path.resolve(root)
  const relative = path.relative(base, resolved)
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep) &&
    path.basename(resolved).startsWith('zorya-classifier-v02-proposals-win-')
  )
}

function syntheticRgba(target) {
  const data = Buffer.alloc(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 4
      const foreground =
        x >= target.left &&
        x < target.left + target.width &&
        y >= target.top &&
        y < target.top + target.height
      data[offset] = foreground ? 226 : 228
      data[offset + 1] = foreground ? 36 : 228
      data[offset + 2] = foreground ? 42 : 228
      data[offset + 3] = 255
    }
  }
  return data
}

async function foregroundScores(sharp, state) {
  const marker = state.indexOf('CANDIDATE MASK CONTACT SHEETS')
  const imageParts =
    marker < 0 ? [] : state.slice(marker + 1).filter((part) => part && part.type === 'image_url')
  const scores = new Map()
  for (const part of imageParts) {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(part.image_url?.url ?? '')
    if (!match) continue
    const { data, info } = await sharp(Buffer.from(match[1], 'base64'), {
      limitInputPixels: 1_000_000,
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (info.width !== 1200 || info.height !== 720 || info.channels !== 4) continue
    for (let local = 0; local < 12; local++) {
      const index = scores.size
      const tileX = (local % 4) * 300
      const tileY = Math.floor(local / 4) * 240
      let count = 0
      for (let y = tileY + 28; y < tileY + 228; y++) {
        for (let x = tileX + 154; x < tileX + 296; x++) {
          const offset = (y * 1200 + x) * 4
          if (
            data[offset] > 150 &&
            data[offset + 1] < 100 &&
            data[offset + 2] < 110 &&
            data[offset + 3] > 0
          )
            count++
        }
      }
      scores.set(`C${String(index).padStart(2, '0')}`, count)
    }
  }
  return scores
}

function fixtureDecision(sharp, enforceRegionChoiceContract = false) {
  let calls = 0
  let validRegionChoiceRequests = 0
  const decision = {
    async decide(request, signal) {
      calls++
      if (signal.aborted)
        throw Object.assign(new Error('Fixture decision aborted'), { code: 'ABORTED' })
      if (enforceRegionChoiceContract) {
        const questionIds = Object.keys(request.questions).sort()
        if (JSON.stringify(questionIds) !== JSON.stringify(['presence', 'selection']))
          throw new Error(
            'Region workflow changed the original presence + selection Choice contract',
          )
        if (
          request.questions.presence?.type !== 'noul' ||
          request.questions.selection?.type !== 'ranked-choice'
        )
          throw new Error(
            'Region workflow changed the original Noul + ranked Choice question types',
          )
        validRegionChoiceRequests++
      }
      const answers = {}
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type === 'noul') {
          answers[id] = { type: 'noul', noul: 1 }
          continue
        }
        const choices = Object.keys(question.criteria ?? {})
        if (!choices.length) throw new Error('Decision fixture received an empty choice question')
        let choice = choices.includes('C00') ? 'C00' : choices[0]
        if (request.state.includes('CANDIDATE MASK CONTACT SHEETS')) {
          const scores = await foregroundScores(sharp, request.state)
          const best = choices
            .filter((value) => /^C\d{2}$/u.test(value))
            .map((value) => ({ value, count: scores.get(value) ?? 0 }))
            .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))[0]
          if (best?.count > 0) choice = best.value
          else if (choices.includes('none')) choice = 'none'
        }
        answers[id] = {
          type: 'choice',
          choice,
          probabilities: Object.fromEntries(
            choices.map((value) => [value, value === choice ? 1 : 0]),
          ),
        }
      }
      return {
        answers,
        metadata: {
          model: null,
          provider: null,
          requestId: null,
          durationMs: 0,
          costUsd: 0,
          attempts: 1,
        },
      }
    },
  }
  return {
    decision,
    calls: () => calls,
    validRegionChoiceRequests: () => validRegionChoiceRequests,
  }
}

function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNEXPECTED'
}

async function waitForNativeStart(timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      resourceChannel.unsubscribe(listener)
      reject(new Error('Timed out waiting for owned native child start'))
    }, timeoutMs)
    const listener = (event) => {
      if (event && event.type === 'start' && Number.isInteger(event.pid)) {
        globalThis.clearTimeout(timer)
        resourceChannel.unsubscribe(listener)
        resolve(event.pid)
      }
    }
    resourceChannel.subscribe(listener)
  })
}

async function runWorker(options) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error(`Expected native Windows x64 Node, got ${process.platform}/${process.arch}`)
  const tempRoot = createOwnedTemp()
  const report = {
    schemaVersion: 1,
    benchmark:
      options.workflow === 'region-segmentation'
        ? 'installed-archive-mobile-sam-region-segmentation-windows-v1'
        : 'installed-archive-mobile-sam-proposal-windows-v1',
    ...(options.workflow === 'region-segmentation' ? { workflow: options.workflow } : {}),
    backend:
      options.workflow === 'region-segmentation'
        ? 'mobile-sam-seed-region'
        : 'mobile-sam-object-proposals',
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    osRelease: os.release(),
    startedAt: new Date().toISOString(),
    executionProvider: 'CPU',
    sourceCommitReference: options.sourceCommit,
    harnessSha256: null,
    archive: null,
    assets: {},
    installedPackage: null,
    checks: {},
    located: null,
    extracted: null,
    lifecycle: null,
    childOwnership: { starts: 0, closes: 0, stillOwnedPids: [] },
    cleanupErrors: [],
    tempRoot,
    failure: null,
  }
  const target = options.workflow === 'region-segmentation' ? REGION_TARGET : PROPOSAL_TARGET
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
  let adapter
  let classifier
  let outputPath
  try {
    report.harnessSha256 = digest(await readBoundedFile(fileURLToPath(import.meta.url), 1_000_000))
    outputPath = path.resolve(options.report)
    const reportRelative = path.relative(tempRoot, outputPath)
    if (!reportRelative || (!reportRelative.startsWith('..') && !path.isAbsolute(reportRelative)))
      throw new Error('Report path must be outside the owned temp root')
    if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite report: ${outputPath}`)
    const profile = path.join(tempRoot, 'profile')
    const archivePath = path.join(tempRoot, 'verified-package.tgz')
    const encoderPath = path.join(tempRoot, 'assets', ENCODER.name)
    const decoderPath = path.join(tempRoot, 'assets', DECODER.name)
    const archiveBytes = await readBoundedFile(options.archive, 64 * 1024 * 1024)
    const archiveSha256 = digest(archiveBytes)
    if (archiveSha256 !== options.sha256) throw new Error('Package archive SHA-256 does not match')
    await fsp.writeFile(archivePath, archiveBytes, { flag: 'wx' })
    const stagedArchiveSha256 = digest(await readBoundedFile(archivePath, 64 * 1024 * 1024))
    if (stagedArchiveSha256 !== archiveSha256)
      throw new Error('Staged package archive bytes differ from the verified input')
    report.archive = { path: archivePath, bytes: archiveBytes.byteLength, sha256: archiveSha256 }
    report.assets.encoder = await stagePinnedFile(options.encoder, encoderPath, ENCODER)
    report.assets.decoder = await stagePinnedFile(options.decoder, decoderPath, DECODER)
    const pkg = {
      name:
        options.workflow === 'region-segmentation'
          ? 'zorya-region-segmentation-windows-profile'
          : 'zorya-proposal-windows-profile',
      private: true,
      type: 'module',
      dependencies: {
        [PACKAGE_NAME]: 'file:../verified-package.tgz',
        'onnxruntime-node': '1.23.2',
      },
    }
    await fsp.writeFile(path.join(profile, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, {
      flag: 'wx',
    })
    const env = cleanNpmEnvironment(tempRoot)
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
      label: 'npm version probe',
    }).trim()
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
      ],
      {
        cwd: profile,
        env,
        timeout: 600_000,
        label: 'Install exact package archive and optional native peer',
      },
    )

    const packageRoot = path.join(profile, 'node_modules', PACKAGE_NAME)
    const installedPackageJson = JSON.parse(
      await fsp.readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    )
    const installedOrt = JSON.parse(
      await fsp.readFile(
        path.join(profile, 'node_modules', 'onnxruntime-node', 'package.json'),
        'utf8',
      ),
    )
    if (installedOrt.version !== '1.23.2')
      throw new Error(`Expected onnxruntime-node 1.23.2, got ${installedOrt.version}`)
    if (!installedPackageJson.exports?.['./segmentation'])
      throw new Error('Installed archive does not export ./segmentation')
    const declarationPath = path.join(packageRoot, 'dist', 'segmentation.d.ts')
    const declaration = await fsp.readFile(declarationPath, 'utf8')
    const requiredDeclarations =
      options.workflow === 'region-segmentation'
        ? ['createMobileSamSegmenter', 'SegmentationPort']
        : ['createMobileSamObjectProposals', 'ObjectProposalPort']
    if (!requiredDeclarations.every((item) => declaration.includes(item)))
      throw new Error(`Installed archive declarations omit ${requiredDeclarations.join('/')}`)
    const segmentationEntry = installedPackageJson.exports['./segmentation']
    const runtimeEntry = path.join(packageRoot, segmentationEntry.import)
    const runtimeModuleBytes = await fsp.readFile(runtimeEntry)
    const installedFiles = []
    async function hashTree(directory) {
      for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) await hashTree(file)
        else if (
          entry.isFile() &&
          (file.includes(`${path.sep}dist${path.sep}`) || file.endsWith('package.json'))
        )
          installedFiles.push({
            path: path.relative(packageRoot, file).split(path.sep).join('/'),
            sha256: digest(await fsp.readFile(file)),
          })
      }
    }
    await hashTree(packageRoot)
    installedFiles.sort((left, right) => left.path.localeCompare(right.path))
    report.installedPackage = {
      name: installedPackageJson.name,
      version: installedPackageJson.version,
      onnxruntimeNodeVersion: installedOrt.version,
      archiveSha256: archiveSha256,
      segmentationRuntimeSha256: digest(runtimeModuleBytes),
      installedDistFileCount: installedFiles.length,
      installedDistManifestSha256: digest(Buffer.from(JSON.stringify(installedFiles))),
      exportsSegmentation: true,
      declarations: { path: 'dist/segmentation.d.ts', sha256: digest(Buffer.from(declaration)) },
    }

    const runtimeProbe = path.join(profile, 'proposal-runtime-probe.mjs')
    await fsp.writeFile(
      runtimeProbe,
      [
        "import sharp from 'sharp'",
        "import { createMobileSamObjectProposals, createMobileSamSegmenter } from 'zorya-classifier/segmentation'",
        "import { createClassifier, ClassifierError } from 'zorya-classifier'",
        'export { sharp, createMobileSamObjectProposals, createMobileSamSegmenter, createClassifier, ClassifierError }',
        '',
      ].join('\n'),
      { flag: 'wx' },
    )
    const importsBefore = {
      starts: report.childOwnership.starts,
      closes: report.childOwnership.closes,
    }
    const {
      sharp,
      createMobileSamObjectProposals,
      createMobileSamSegmenter,
      createClassifier,
      ClassifierError,
    } = await import(pathToFileURL(runtimeProbe).href)
    if (typeof createClassifier !== 'function')
      throw new Error('Installed archive imports omit classifier')
    const createBackend =
      options.workflow === 'region-segmentation'
        ? createMobileSamSegmenter
        : createMobileSamObjectProposals
    if (typeof createBackend !== 'function')
      throw new Error('Installed archive imports omit the configured segmentation factory')
    report.checks.importWithoutNativeChild = report.childOwnership.starts === importsBefore.starts
    if (!report.checks.importWithoutNativeChild)
      throw new Error('Importing installed package started a native child')

    adapter = await createBackend({
      encoderPath,
      decoderPath,
      executionProvider: 'cpu',
      threads: 1,
    })
    report.checks.backendProbeSettled =
      report.childOwnership.starts === report.childOwnership.closes && ownedPids.size === 0
    if (!report.checks.backendProbeSettled)
      throw new Error('Explicit CPU backend probe left an owned native child running')
    const rgba = syntheticRgba(target)
    const png = await sharp(rgba, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
      .png()
      .toBuffer()
    const fixture = fixtureDecision(sharp, options.workflow === 'region-segmentation')
    classifier = createClassifier({
      decision: fixture.decision,
      ...(options.workflow === 'region-segmentation'
        ? { segmentation: adapter }
        : { objectProposals: adapter }),
      concurrency: 1,
      maxQueue: 2,
      timeoutMs: 45_000,
    })
    const locateStartedAt = Date.now()
    const location = await classifier.locate({
      image: new Uint8Array(png),
      target: 'the red square in the first cell',
      exclusions: [],
      mode: 'whole-object',
    })
    report.located = {
      status: location.status,
      durationMs: Date.now() - locateStartedAt,
      ...(location.status === 'located'
        ? {
            seedRegion: location.seedRegion,
            region: location.region,
            method: location.method,
            ...(location.center ? { center: location.center } : {}),
            ...(location.proposalMetadata ? { proposalMetadata: location.proposalMetadata } : {}),
          }
        : { reason: location.reason }),
    }
    if (location.status !== 'located') throw new Error(`Fixture locate returned ${location.status}`)
    const seedCenter = {
      x: location.seedRegion.left + location.seedRegion.width / 2,
      y: location.seedRegion.top + location.seedRegion.height / 2,
    }
    const seedCenterInsideTarget =
      seedCenter.x >= target.left &&
      seedCenter.x < target.left + target.width &&
      seedCenter.y >= target.top &&
      seedCenter.y < target.top + target.height
    report.seed = {
      region: location.seedRegion,
      center: seedCenter,
      centerInsideSyntheticTarget: seedCenterInsideTarget,
    }
    if (options.workflow === 'region-segmentation' && !seedCenterInsideTarget)
      throw new Error('Selected seed center is outside the synthetic target rectangle')
    const extractStartedAt = Date.now()
    const extraction = await classifier.extract({
      image: new Uint8Array(png),
      target: 'the red square in the first cell',
      exclusions: [],
      mode: 'whole-object',
    })
    report.extracted = {
      status: extraction.status,
      durationMs: Date.now() - extractStartedAt,
      ...(extraction.status === 'extracted'
        ? {
            region: extraction.region,
            offset: extraction.offset,
            pngBytes: extraction.png.byteLength,
            maskBytes: extraction.mask.data.byteLength,
            segmentation: extraction.segmentation,
          }
        : { reason: extraction.reason }),
    }
    if (extraction.status !== 'extracted')
      throw new Error(`Fixture extract returned ${extraction.status}`)
    if (options.workflow === 'region-segmentation') {
      const { data: cutout, info } = await sharp(extraction.png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      let foregroundPixels = 0
      for (let index = 0; index < extraction.mask.data.length; index++) {
        const foreground = extraction.mask.data[index] === 1
        if (foreground) foregroundPixels++
        if (cutout[index * 4 + 3] > 0 !== foreground)
          throw new Error('Cutout alpha does not match the cropped binary mask')
      }
      const largerThanSeed =
        extraction.region.width > location.seedRegion.width &&
        extraction.region.height > location.seedRegion.height
      const centerMatchesBounds =
        extraction.center.x === extraction.region.left + extraction.region.width / 2 &&
        extraction.center.y === extraction.region.top + extraction.region.height / 2
      const cropMatchesBounds =
        extraction.mask.width === extraction.region.width &&
        extraction.mask.height === extraction.region.height &&
        info.width === extraction.mask.width &&
        info.height === extraction.mask.height &&
        extraction.offset.x === extraction.region.left &&
        extraction.offset.y === extraction.region.top
      report.maskDerived = {
        sourceSize: { width: WIDTH, height: HEIGHT },
        segmenterInputSize: extraction.segmentation.input,
        syntheticTarget: target,
        region: extraction.region,
        center: extraction.center,
        seedRegion: location.seedRegion,
        maskPixels: foregroundPixels,
        pngSize: { width: info.width, height: info.height },
        method: extraction.segmentation.method,
        cutoutAlphaMatchesMask: true,
        centerMatchesBounds,
        cropMatchesBounds,
        objectBoundsLargerThanSeed: largerThanSeed,
      }
      if (extraction.segmentation.method !== 'mobile-sam-seed-point-v1')
        throw new Error(`Unexpected seed-prompt method: ${extraction.segmentation.method}`)
      if (
        extraction.segmentation.input.width !== WIDTH ||
        extraction.segmentation.input.height !== HEIGHT
      )
        throw new Error('Seed prompt did not segment the full source image')
      if (!largerThanSeed)
        throw new Error('Mask-derived object bounds did not exceed the seed region')
      if (!centerMatchesBounds || !cropMatchesBounds)
        throw new Error('Mask-derived center, crop dimensions or source offset are inconsistent')
    }
    report.fixtureDecision = {
      calls: fixture.calls(),
      providerHttpCalls: 0,
      ...(options.workflow === 'region-segmentation'
        ? {
            noExtentOrMaskConfirmationCalls: true,
            validRegionChoiceRequests: fixture.validRegionChoiceRequests(),
          }
        : { selectionUsesRenderedSyntheticForegroundPixels: true }),
    }
    if (options.workflow === 'region-segmentation' && fixture.calls() !== 6)
      throw new Error(
        `Expected six locator calls across locate + extract, received ${fixture.calls()}`,
      )
    if (options.workflow === 'region-segmentation' && fixture.validRegionChoiceRequests() !== 6)
      throw new Error('Not all six requests used the original presence + selection Choices')

    if (options.workflow === 'region-segmentation') {
      const emptyRgba = new Uint8Array(WIDTH * HEIGHT * 4)
      const empty = await adapter.segment({
        image: { data: emptyRgba, width: WIDTH, height: HEIGHT, format: 'rgba8' },
        prompt: 'seed-region',
        seedRegion: location.seedRegion,
        wholeRegion: { left: 0, top: 0, width: WIDTH, height: HEIGHT },
        bounds: location.bounds,
        roi: { left: 0, top: 0, width: WIDTH, height: HEIGHT },
        target: 'the red square in the first cell',
        exclusions: [],
        completeness: 'visible-object',
        signal: new globalThis.AbortController().signal,
      })
      const emptyForeground =
        empty.status === 'segmented' ? empty.mask.data.reduce((sum, value) => sum + value, 0) : -1
      report.emptyTransparentInput = {
        status: empty.status,
        maskPixels: emptyForeground,
        fullSourceSize: { width: WIDTH, height: HEIGHT },
      }
      if (empty.status !== 'segmented' || emptyForeground !== 0)
        throw new Error('Transparent full-source input did not return a valid empty mask')
    }

    const cancelController = new globalThis.AbortController()
    const startsBeforeCancel = report.childOwnership.starts
    const closesBeforeCancel = report.childOwnership.closes
    const startEvent = waitForNativeStart()
    const nativeInput = (signal) => ({
      image: { data: new Uint8Array(rgba), width: WIDTH, height: HEIGHT, format: 'rgba8' },
      seedRegion: location.seedRegion,
      roi: { left: 0, top: 0, width: WIDTH, height: HEIGHT },
      signal,
      ...(options.workflow === 'region-segmentation'
        ? {
            prompt: 'seed-region',
            wholeRegion: { left: 0, top: 0, width: WIDTH, height: HEIGHT },
            bounds: location.bounds,
            target: 'the red square in the first cell',
            exclusions: [],
            completeness: 'visible-object',
          }
        : {}),
    })
    const runNative = (input) =>
      options.workflow === 'region-segmentation' ? adapter.segment(input) : adapter.propose(input)
    const cancelPending = runNative(nativeInput(cancelController.signal)).then(
      () => 'FULFILLED',
      (error) => errorCode(error),
    )
    const cancelPid = await startEvent
    cancelController.abort(new ClassifierError('ABORTED', 'Windows acceptance cancellation'))
    const cancelCode = await cancelPending
    await adapter.settle()
    const cancellationPhysicalCloseConfirmed =
      report.childOwnership.starts === startsBeforeCancel + 1 &&
      report.childOwnership.closes === closesBeforeCancel + 1 &&
      !ownedPids.has(cancelPid)
    report.lifecycle = {
      cancellationCode: cancelCode,
      cancellationChildPid: cancelPid,
      cancellationPhysicalCloseConfirmed,
    }
    if (cancelCode !== 'ABORTED' || !cancellationPhysicalCloseConfirmed)
      throw new Error(`Cancellation did not abort and join physical child (${cancelCode})`)

    const queueInput = () => nativeInput(new globalThis.AbortController().signal)
    const queued = Array.from({ length: 4 }, () => runNative(queueInput()))
    const queueResults = await Promise.allSettled(queued)
    const queueFulfilled = queueResults.filter((item) => item.status === 'fulfilled').length
    const queueCapacity = queueResults.filter(
      (item) => item.status === 'rejected' && item.reason?.code === 'CAPACITY',
    ).length
    const queueOtherFailures = queueResults.filter(
      (item) => item.status === 'rejected' && item.reason?.code !== 'CAPACITY',
    ).length
    report.lifecycle.queue = {
      submitted: queueResults.length,
      fulfilled: queueFulfilled,
      capacityRejected: queueCapacity,
      otherFailures: queueOtherFailures,
    }
    if (queueFulfilled !== 3 || queueCapacity !== 1 || queueOtherFailures !== 0)
      throw new Error('Native queue did not enforce one active plus two waiters')
    await adapter.settle()

    await classifier.dispose()
    classifier = undefined
    const afterClassifierDispose = await runNative(queueInput())
    report.lifecycle.callerOwnedAdapterAfterClassifierDispose =
      options.workflow === 'region-segmentation'
        ? afterClassifierDispose.status
        : afterClassifierDispose.proposals.length
    await adapter.settle()
    await adapter.dispose()
    const afterDispose = await runNative(queueInput()).then(
      () => 'FULFILLED',
      (error) => errorCode(error),
    )
    report.lifecycle.afterAdapterDispose = afterDispose
    if (afterDispose !== 'DISPOSED') throw new Error(`Disposed adapter returned ${afterDispose}`)

    report.checks.locate = report.located.status === 'located'
    report.checks.extract = report.extracted.status === 'extracted'
    report.checks.cancellationAndPhysicalJoin =
      report.lifecycle.cancellationCode === 'ABORTED' &&
      report.lifecycle.cancellationPhysicalCloseConfirmed === true
    report.checks.capacity = queueFulfilled === 3 && queueCapacity === 1 && queueOtherFailures === 0
    report.checks.callerOwnedAdapter =
      options.workflow === 'region-segmentation'
        ? report.lifecycle.callerOwnedAdapterAfterClassifierDispose === 'segmented' ||
          report.lifecycle.callerOwnedAdapterAfterClassifierDispose === 'unknown'
        : report.lifecycle.callerOwnedAdapterAfterClassifierDispose > 0
    report.checks.dispose = afterDispose === 'DISPOSED'
    report.checks.fixtureDecisionOffline = report.fixtureDecision.providerHttpCalls === 0
    if (options.workflow === 'region-segmentation')
      report.checks.emptyTransparentIsValidEmptyMask =
        report.emptyTransparentInput.status === 'segmented' &&
        report.emptyTransparentInput.maskPixels === 0
  } catch (error) {
    report.failure = error instanceof Error ? error.message : 'Windows proposal acceptance failed'
  } finally {
    if (classifier) {
      try {
        await classifier.dispose()
      } catch (error) {
        report.cleanupErrors.push(`classifier dispose: ${String(error)}`)
      }
    }
    if (adapter) {
      try {
        await adapter.settle()
      } catch (error) {
        report.cleanupErrors.push(`adapter settle: ${String(error)}`)
      }
      try {
        await adapter.dispose()
      } catch (error) {
        report.cleanupErrors.push(`adapter dispose: ${String(error)}`)
      }
    }
    const drainUntil = Date.now() + 10_000
    while (ownedPids.size && Date.now() < drainUntil)
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100))
    report.childOwnership.stillOwnedPids = [...ownedPids]
    report.checks.childOwnership =
      report.childOwnership.starts === report.childOwnership.closes && ownedPids.size === 0
    report.checks.cleanup = report.cleanupErrors.length === 0
    report.endedAt = new Date().toISOString()
    report.acceptance =
      !report.failure && Object.values(report.checks).every((value) => value === true)
    resourceChannel.unsubscribe(onChild)
    try {
      await fsp.mkdir(path.dirname(outputPath), { recursive: true })
      await fsp.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    } catch (error) {
      process.stderr.write(
        `Could not preserve worker report: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 1
    }
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.at(-1) === '--internal-worker') {
    if (process.env.ZORYA_PROPOSAL_ACCEPTANCE_WORKER !== '1')
      throw new Error('Internal worker cannot be launched directly')
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
      env: { ...process.env, ZORYA_PROPOSAL_ACCEPTANCE_WORKER: '1' },
      encoding: 'utf8',
      timeout: 1_200_000,
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
      benchmark: 'installed-archive-mobile-sam-proposal-windows-v1',
      checks: {},
      cleanupErrors: [],
      failure: 'Worker did not preserve an acceptance report',
    }
  }
  const cleanupErrors = Array.isArray(report.cleanupErrors) ? report.cleanupErrors : []
  if (report.tempRoot) {
    if (!insideTemp(report.tempRoot)) cleanupErrors.push('Refused cleanup outside owned WinTemp')
    else {
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
    tempCleanup:
      cleanupErrors.length === 0 &&
      report.tempCleanup === 'removed by coordinator after worker exit',
  }
  report.acceptance =
    !report.failure && Object.values(report.checks).every((value) => value === true)
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
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Windows proposal acceptance failed'}\n`,
  )
  process.exitCode = 1
})
