import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, statSync, writeFileSync } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { scanSecretText, secretPathRules } from '../../../scripts/secrets.mjs'

const packageRoot = resolve('.')
const repositoryRoot = resolve(packageRoot, '../..')
const evidenceRootInput = resolve(
  process.env['ZORYA_MCP_EVIDENCE_DIR'] ?? join(tmpdir(), 'zorya-classifier-mcp-evidence'),
)
const publishedLibrarySha256 = '3e13abef137b232d6ff7467a8dca470040eb303df8839aa1fc4298c141e20e0c'
const expectedPackageName = 'zorya-classifier-mcp'
const expectedPackageVersion = '0.1.0'
const maxPackedFileBytes = 2 * 1024 * 1024

function resolveNpmCli() {
  const declared = process.env['npm_execpath']
  if (declared !== undefined && isAbsolute(declared) && basename(declared) === 'npm-cli.js')
    return declared
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue
    for (const candidate of [
      join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ]) {
      try {
        if (basename(candidate) === 'npm-cli.js' && awaitStat(candidate)) return candidate
      } catch {
        continue
      }
    }
  }
  throw new Error('Could not resolve the current Node/npm CLI for archive verification.')
}

function awaitStat(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? packageRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 300_000,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    const status = result.status === null ? 'no exit status' : `exit ${result.status}`
    if (options.failureLog !== undefined) {
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(0, 1024 * 1024)
      const findings = scanSecretText(basename(options.failureLog), output)
      writeFileSync(
        options.failureLog,
        findings.length === 0
          ? output
          : 'Failure output withheld because secret scanning found a match.\n',
        { flag: 'wx', mode: 0o600 },
      )
    }
    throw new Error(
      `${options.label ?? basename(executable)} failed (${status}); raw output was withheld.`,
    )
  }
  return result.stdout
}

const npmCli = resolveNpmCli()
await mkdir(evidenceRootInput, { recursive: true })
const evidenceRoot = await realpath(evidenceRootInput)
const evidenceRelative = relative(repositoryRoot, evidenceRoot)
if (
  evidenceRelative === '' ||
  (evidenceRelative !== '..' &&
    !evidenceRelative.startsWith(`..${sep}`) &&
    !isAbsolute(evidenceRelative))
) {
  throw new Error('MCP evidence directory must resolve outside the repository.')
}
const runId = randomUUID()
const runRoot = join(evidenceRoot, `run-${runId}`)
const archiveStore = join(evidenceRoot, 'archives')
await mkdir(runRoot, { recursive: false })
await mkdir(archiveStore, { recursive: true })
const tempRoot = await mkdtemp(join(runRoot, '.work-'))
const safeEnvironment = Object.fromEntries(
  ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
)
let archivePath
let archiveHash
let installedRoot
let packageManifest
let auditFiles = []
let consumerRoot
let smokeResult
let cliResult
let typecheckResult
let publishedLibraryArchiveHash

try {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, expectedPackageName)
  assert.equal(manifest.version, expectedPackageVersion)
  assert.equal(manifest.engines?.node, '>=22.12.0')
  assert.equal(manifest.exports?.['.']?.import, './dist/index.js')
  assert.equal(manifest.bin?.[expectedPackageName], './dist/cli.js')

  const lock = JSON.parse(await readFile(join(packageRoot, 'package-lock.json'), 'utf8'))
  const publishedLibrary = lock.packages?.['node_modules/zorya-classifier']
  assert.equal(publishedLibrary?.version, '0.2.3')
  assert.equal(
    publishedLibrary?.resolved,
    'https://registry.npmjs.org/zorya-classifier/-/zorya-classifier-0.2.3.tgz',
  )
  assert.equal(
    publishedLibrary?.integrity,
    'sha512-yb+gdGAZOGhOrca+/ji3Fyq0B0jgfTXlqHy1KP+FqITOyave4LobhwROgDACUAhjTnTPI3GCzHpDgN3SbEt3UQ==',
  )

  const libraryPackOutput = command(
    process.execPath,
    [npmCli, 'pack', '--json', '--pack-destination', tempRoot, 'zorya-classifier@0.2.3'],
    { label: 'published zorya-classifier archive fetch', timeout: 180_000 },
  )
  const libraryPackRecord = JSON.parse(libraryPackOutput)[0]
  assert.ok(libraryPackRecord && typeof libraryPackRecord.filename === 'string')
  const libraryArchivePath = join(tempRoot, libraryPackRecord.filename)
  const libraryArchive = await readFile(libraryArchivePath)
  publishedLibraryArchiveHash = createHash('sha256').update(libraryArchive).digest('hex')
  assert.equal(
    publishedLibraryArchiveHash,
    publishedLibrarySha256,
    'Registry library archive bytes differ from the published-source pin.',
  )
  const extractedLibraryRoot = join(tempRoot, 'published-library-extracted')
  await mkdir(extractedLibraryRoot)
  command('tar', ['-xzf', libraryArchivePath, '-C', extractedLibraryRoot], {
    label: 'published library tar extraction',
  })
  const publishedLibraryFiles = await walkFiles(join(extractedLibraryRoot, 'package'))

  const packOutput = command(
    process.execPath,
    [npmCli, 'pack', '--json', '--pack-destination', tempRoot],
    {
      label: 'npm pack',
      timeout: 120_000,
    },
  )
  const packRecord = JSON.parse(packOutput)[0]
  assert.ok(packRecord && typeof packRecord.filename === 'string')
  archivePath = join(tempRoot, packRecord.filename)
  const archive = await readFile(archivePath)
  archiveHash = createHash('sha256').update(archive).digest('hex')
  const listing = command('tar', ['-tzf', archivePath], { label: 'tar listing' }).trim().split('\n')
  const archiveMembers = listing.filter((member) => member && !member.endsWith('/')).sort()
  assert.ok(archiveMembers.length > 0 && archiveMembers.length <= 10_000)
  assert.equal(
    new Set(archiveMembers).size,
    archiveMembers.length,
    'Archive has duplicate file paths.',
  )
  for (const member of archiveMembers) {
    const memberSegments = member.split('/')
    assert.equal(member.includes('\\'), false, 'Archive member has a platform-specific separator.')
    assert.equal(member.startsWith('/'), false, 'Archive member is absolute.')
    assert.equal(/^[A-Za-z]:/u.test(member), false, 'Archive member has a drive prefix.')
    assert.equal(
      memberSegments.some((segment) => segment === '' || segment === '.' || segment === '..'),
      false,
      'Archive member has a traversal segment.',
    )
    assert.equal(posix.normalize(member), member, 'Archive member is not normalized.')
    assert.ok(member.startsWith('package/'), 'Archive member is outside the npm package root.')
    const name = member.slice('package/'.length)
    assert.ok(
      name === 'package.json' ||
        name === 'README.md' ||
        name === 'LICENSE' ||
        name === 'NOTICE.md' ||
        name.startsWith('dist/'),
      `Archive contains a non-allowlisted member: ${name}`,
    )
    assert.equal(secretPathRules(name).length, 0, `Archive member path is prohibited: ${name}`)
  }

  const extractedRoot = join(tempRoot, 'archive-extracted')
  await mkdir(extractedRoot)
  command('tar', ['-xzf', archivePath, '-C', extractedRoot], { label: 'tar extraction' })
  const extractedPackage = join(extractedRoot, 'package')
  const files = await walkFiles(extractedPackage)
  assert.deepEqual(
    files.map((file) => file.relative).sort(),
    archiveMembers.map((name) => name.slice('package/'.length)).sort(),
  )
  for (const file of files) {
    if (file.size > maxPackedFileBytes)
      throw new Error(`Packed file exceeds scan limit: ${file.relative}`)
    const bytes = await readFile(file.path)
    const findings = scanSecretText(file.relative, bytes.toString('utf8'))
    assert.deepEqual(findings, [], `Secret scan failed for packed file ${file.relative}.`)
  }

  const evidenceArchive = join(
    archiveStore,
    `zorya-classifier-mcp-${expectedPackageVersion}-${archiveHash}.tgz`,
  )
  try {
    await copyFile(archivePath, evidenceArchive, constants.COPYFILE_EXCL)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    assert.equal(
      createHash('sha256')
        .update(await readFile(evidenceArchive))
        .digest('hex'),
      archiveHash,
    )
  }

  consumerRoot = join(tempRoot, 'consumer')
  await mkdir(consumerRoot)
  command(
    process.execPath,
    [npmCli, 'install', '--no-audit', '--no-fund', '--prefix', consumerRoot, archivePath],
    {
      label: 'independent archive consumer install',
      timeout: 300_000,
      env: process.env,
    },
  )
  installedRoot = join(consumerRoot, 'node_modules', expectedPackageName)
  packageManifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
  assert.equal(packageManifest.version, expectedPackageVersion)
  const installedFiles = await walkFiles(installedRoot)
  auditFiles = installedFiles.map((file) => file.relative).sort()
  assert.deepEqual(auditFiles, files.map((file) => file.relative).sort())
  for (const file of files) {
    const installed = await readFile(join(installedRoot, file.relative))
    const packed = await readFile(file.path)
    assert.equal(
      createHash('sha256').update(installed).digest('hex'),
      createHash('sha256').update(packed).digest('hex'),
      `Installed archive bytes differ for ${file.relative}.`,
    )
  }

  const mcpEntry = withinInstalled(installedRoot, packageManifest.exports['.'].import)
  const cliEntry = withinInstalled(installedRoot, packageManifest.bin[expectedPackageName])
  const libraryRoot = join(consumerRoot, 'node_modules', 'zorya-classifier')
  const libraryManifest = JSON.parse(await readFile(join(libraryRoot, 'package.json'), 'utf8'))
  assert.equal(libraryManifest.version, '0.2.3')
  for (const file of publishedLibraryFiles) {
    const installed = await readFile(join(libraryRoot, file.relative))
    const published = await readFile(file.path)
    assert.equal(
      createHash('sha256').update(installed).digest('hex'),
      createHash('sha256').update(published).digest('hex'),
      `Installed zorya-classifier bytes differ from the pinned registry archive for ${file.relative}.`,
    )
  }
  const libraryEntry = withinInstalled(libraryRoot, libraryManifest.exports['.'].import)
  const sdkConsumerEnvironment = {
    ...safeEnvironment,
    MCP_CONSUMER_ROOT: consumerRoot,
    MCP_PACKAGE_ENTRY: mcpEntry,
    MCP_LIBRARY_ENTRY: libraryEntry,
    MCP_CLI_ENTRY: cliEntry,
  }
  for (const name of [
    'MCP_CONSUMER_ROOT',
    'MCP_PACKAGE_ENTRY',
    'MCP_LIBRARY_ENTRY',
    'MCP_CLI_ENTRY',
  ]) {
    if (!sdkConsumerEnvironment[name]) throw new Error(`Missing installed-consumer input: ${name}`)
  }

  command(
    process.execPath,
    [
      npmCli,
      'install',
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--prefix',
      consumerRoot,
      '@types/node@24.3.0',
    ],
    { label: 'independent TypeScript consumer node types', timeout: 180_000, env: process.env },
  )
  const typeConsumerRoot = join(consumerRoot, 'type-consumer')
  await mkdir(typeConsumerRoot)
  const typeConfigPath = join(typeConsumerRoot, 'tsconfig.json')
  await writeFile(
    typeConfigPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          skipLibCheck: false,
          types: ['node'],
          typeRoots: [join(consumerRoot, 'node_modules', '@types')],
        },
        include: ['consumer.mts'],
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o600 },
  )
  const typeConfigSource = await readFile(join(packageRoot, 'test/consumer/type-consumer.mts'))
  await writeFile(join(typeConsumerRoot, 'consumer.mts'), typeConfigSource, {
    flag: 'wx',
    mode: 0o600,
  })
  const tscCli = join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  typecheckResult = command(
    process.execPath,
    [tscCli, '--pretty', 'false', '--listFiles', '--project', typeConfigPath],
    {
      cwd: typeConsumerRoot,
      label: 'installed package declaration consumer typecheck',
      timeout: 120_000,
    },
  )
  const installedDeclaration = withinInstalled(installedRoot, packageManifest.exports['.'].types)
  const normalizePath = (value) => value.replaceAll('\\', '/').toLowerCase()
  assert.ok(
    normalizePath(typecheckResult).includes(normalizePath(installedDeclaration)),
    'The independent TypeScript consumer did not resolve the installed package declarations.',
  )
  assert.equal(
    normalizePath(typecheckResult).includes(normalizePath(join(packageRoot, 'src'))),
    false,
    'The independent consumer typecheck reached package source files.',
  )
  const typeLogPath = join(runRoot, 'consumer-types.log')
  await writeFile(typeLogPath, typecheckResult, { flag: 'wx', mode: 0o600 })

  smokeResult = command(process.execPath, ['--test', 'test/consumer/smoke.test.mjs'], {
    label: 'installed archive SDK consumer smoke',
    timeout: 180_000,
    failureLog: join(runRoot, 'consumer-smoke-failure.tap'),
    env: sdkConsumerEnvironment,
  })
  const testCount = smokeResult.match(/^# tests (\d+)$/mu)?.[1]
  const passCount = smokeResult.match(/^# pass (\d+)$/mu)?.[1]
  const skipCount = smokeResult.match(/^# skipped (\d+)$/mu)?.[1]
  if (testCount !== '5' || passCount !== '5' || skipCount !== '0') {
    throw new Error('Installed SDK consumer TAP did not execute all five tests without skips.')
  }
  const sdkLogPath = join(runRoot, 'consumer-smoke.tap')
  await writeFile(sdkLogPath, smokeResult, { flag: 'wx', mode: 0o600 })
  cliResult = command(process.execPath, ['test/consumer/cli-smoke.mjs', installedRoot, npmCli], {
    label: 'installed CLI smoke',
    timeout: 60_000,
    failureLog: join(runRoot, 'cli-smoke-failure.log'),
    env: safeEnvironment,
  })
  const cliLogPath = join(runRoot, 'cli-smoke.log')
  await writeFile(cliLogPath, cliResult, { flag: 'wx', mode: 0o600 })

  const summary = {
    status: 'PASS',
    runId,
    package: { name: manifest.name, version: manifest.version },
    archive: {
      path: evidenceArchive,
      bytes: archive.byteLength,
      sha256: archiveHash,
      members: archiveMembers,
      installedFileCount: installedFiles.length,
      installedBytesMatched: true,
      secretScannedFileCount: files.length,
    },
    dependency: {
      name: 'zorya-classifier',
      version: '0.2.3',
      registry: publishedLibrary.resolved,
      integrity: publishedLibrary.integrity,
      downloadedArchiveSha256: publishedLibraryArchiveHash,
      previouslyPinnedArchiveSha256: publishedLibrarySha256,
      installedPackagedFilesMatched: true,
    },
    consumer: {
      independentInstall: 'PASS',
      sdkSmoke: 'PASS',
      cliSmoke: 'PASS',
      declarationTypecheck: 'PASS',
      sdkLogPath,
      cliLogPath,
      typeLogPath,
      providerRequests: 0,
    },
  }
  const receiptPath = join(runRoot, 'pack-check.json')
  await writeFile(receiptPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write(
    `${JSON.stringify({ status: 'PASS', archiveSha256: archiveHash, installedFileCount: installedFiles.length, receiptPath })}\n`,
  )
} catch (error) {
  const failure = {
    status: 'FAIL',
    package: expectedPackageName,
    archiveSha256: archiveHash ?? null,
    errorType: error instanceof Error ? error.name : 'unknown',
    message: error instanceof Error ? error.message : 'Archive verification failed.',
  }
  const receiptPath = join(runRoot, 'pack-check-failure.json')
  await writeFile(receiptPath, `${JSON.stringify({ runId, ...failure }, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  process.stderr.write(`MCP archive verification failed; receipt: ${receiptPath}\n`)
  process.exitCode = 1
} finally {
  if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true })
}

async function walkFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walkFiles(path, name)))
    else if (entry.isFile()) {
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`Archive contains a symbolic link: ${name}`)
      files.push({ path, relative: name, size: info.size })
    } else throw new Error(`Archive contains a non-file entry: ${name}`)
  }
  return files
}

function withinInstalled(root, relativePath) {
  const target = resolve(root, relativePath)
  const suffix = relative(root, target)
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('Installed export entry escapes its package directory.')
  }
  return target
}
