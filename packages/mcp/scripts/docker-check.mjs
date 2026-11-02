import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

if (process.platform !== 'linux') {
  throw new Error(
    'Docker MCP acceptance is run on Linux; this check does not claim Windows container acceptance.',
  )
}

const packageRoot = resolve('.')
const repositoryRoot = resolve(packageRoot, '../..')
const evidenceInput = resolve(
  process.env['ZORYA_MCP_EVIDENCE_DIR'] ?? join(tmpdir(), 'zorya-classifier-mcp-evidence'),
)
await mkdir(evidenceInput, { recursive: true })
const evidenceRoot = await realpath(evidenceInput)
const evidenceRelative = relative(repositoryRoot, evidenceRoot)
if (
  evidenceRelative === '' ||
  (evidenceRelative !== '..' &&
    !evidenceRelative.startsWith(`..${sep}`) &&
    !isAbsolute(evidenceRelative))
) {
  throw new Error('Docker evidence directory must resolve outside the repository.')
}
const runId = randomUUID()
const runRoot = join(evidenceRoot, `docker-${runId}`)
await mkdir(runRoot, { recursive: false })
const workRoot = await mkdtemp(join(runRoot, '.work-'))
const ownedSuffix = runId.replaceAll('-', '')
const imageTag = `zorya-classifier-mcp:smoke-${ownedSuffix}`
const containerName = `zorya-mcp-smoke-${ownedSuffix}`
let imageBuilt = false
let client
let buildOutput = ''
let failure
let passReceipt
let imageId
let configuredUser
let containerRemoved = false
let imageTagRemoved = false

try {
  const configPath = join(workRoot, 'runtime.json')
  const config = {
    transport: 'stdio',
    core: {
      profiles: {
        dockerFixture: {
          id: 'dockerFixture',
          adapter: 'openai-compatible-text',
          credentialMode: 'none',
          endpoint: 'http://127.0.0.1:9/v1/chat/completions',
          model: 'fixture/docker-smoke',
        },
      },
      defaultProfileId: 'dockerFixture',
    },
    credentialVault: { mode: 'memory-only' },
    remoteImageHosts: [],
  }
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o644, flag: 'wx' })

  buildOutput = run('docker', ['build', '--pull', '--tag', imageTag, '--file', 'Dockerfile', '.'], {
    cwd: packageRoot,
    env: safeEnvironment(),
    timeout: 900_000,
  })
  imageBuilt = true
  await writeFile(join(runRoot, 'docker-build.log'), buildOutput, { flag: 'wx', mode: 0o600 })
  configuredUser = run('docker', ['image', 'inspect', '--format', '{{.Config.User}}', imageTag], {
    cwd: packageRoot,
    env: safeEnvironment(),
    timeout: 60_000,
  }).trim()
  assert.equal(configuredUser, 'node', 'The runtime image must configure a non-root user.')
  imageId = run('docker', ['image', 'inspect', '--format', '{{.Id}}', imageTag], {
    cwd: packageRoot,
    env: safeEnvironment(),
    timeout: 60_000,
  }).trim()

  const dockerArgs = [
    'run',
    '--name',
    containerName,
    '--rm',
    '--interactive',
    '--mount',
    `type=bind,source=${configPath},target=/run/zorya/config.json,readonly`,
    '--env',
    'ZORYA_MCP_CONFIG=/run/zorya/config.json',
    imageTag,
  ]
  const transport = new StdioClientTransport({
    command: 'docker',
    args: dockerArgs,
    cwd: packageRoot,
    env: { PATH: process.env['PATH'] ?? '' },
    stderr: 'pipe',
    maxBufferSize: 32 * 1024 * 1024,
  })
  client = new Client(
    { name: 'mcp-docker-consumer-smoke', version: '0.1.0' },
    {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  )
  await client.connect(transport)
  const listed = await client.listTools()
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    'zorya_cancel_job',
    'zorya_capabilities',
    'zorya_classify',
    'zorya_extract',
    'zorya_get_job',
    'zorya_locate',
  ])
  const capabilities = await client.callTool({ name: 'zorya_capabilities', arguments: {} })
  assert.notEqual(capabilities.isError, true)
  assert.equal(capabilities.structuredContent.profiles[0].id, 'dockerFixture')
  assert.equal(capabilities.structuredContent.inputs.url, false)
  await client.close()
  client = undefined

  await writeFile(
    join(runRoot, 'docker-smoke.log'),
    `${JSON.stringify(
      {
        toolNames: listed.tools.map((tool) => tool.name).sort(),
        capabilitiesProfile: capabilities.structuredContent.profiles[0].id,
        networkProviderRequests: 0,
        externalAssetsMounted: false,
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o600 },
  )
  passReceipt = {
    status: 'PASS',
    runId,
    imageTag,
    imageId,
    containerName,
    containerRemoved: true,
    imageTagRemoved: true,
    build: 'PASS',
    nonRootRuntime: `PASS (${configuredUser})`,
    mountedRuntimeConfig: 'PASS',
    sdkProtocol: 'MCP 2026-07-28 over stdio',
    sixToolsListed: 'PASS',
    capabilitiesCalled: 'PASS',
    providerRequests: 0,
    modelAssetsBundled: false,
    buildLog: join(runRoot, 'docker-build.log'),
    smokeLog: join(runRoot, 'docker-smoke.log'),
  }
} catch (error) {
  failure = {
    status: 'FAIL',
    runId,
    imageTag,
    errorType: error instanceof Error ? error.name : 'unknown',
    message: error instanceof Error ? error.message : 'Docker smoke failed.',
    buildLogCaptured: buildOutput.length > 0,
    providerRequests: 0,
  }
} finally {
  if (client !== undefined) {
    try {
      await client.close()
    } catch (error) {
      failure ??= {
        status: 'FAIL',
        runId,
        imageTag,
        errorType: error instanceof Error ? error.name : 'unknown',
        message: 'MCP client cleanup failed.',
        providerRequests: 0,
      }
    }
  }
  try {
    const remainingContainers = run(
      'docker',
      ['container', 'ls', '--all', '--quiet', '--filter', `name=^/${containerName}$`],
      { cwd: packageRoot, env: safeEnvironment(), timeout: 60_000 },
    ).trim()
    if (remainingContainers.length > 0) {
      run('docker', ['container', 'rm', '--force', containerName], {
        cwd: packageRoot,
        env: safeEnvironment(),
        timeout: 60_000,
      })
    }
    const afterRemoval = run(
      'docker',
      ['container', 'ls', '--all', '--quiet', '--filter', `name=^/${containerName}$`],
      { cwd: packageRoot, env: safeEnvironment(), timeout: 60_000 },
    ).trim()
    assert.equal(afterRemoval, '', 'The task-owned Docker container remains after cleanup.')
    containerRemoved = true
  } catch (error) {
    failure ??= {
      status: 'FAIL',
      runId,
      imageTag,
      errorType: error instanceof Error ? error.name : 'unknown',
      message: 'Owned Docker smoke container cleanup could not be verified.',
      providerRequests: 0,
    }
  }
  if (imageBuilt) {
    try {
      run('docker', ['image', 'rm', '--force', imageTag], {
        cwd: packageRoot,
        env: safeEnvironment(),
        timeout: 60_000,
      })
      const remainingImageTags = run(
        'docker',
        ['image', 'ls', '--quiet', '--filter', `reference=${imageTag}`],
        { cwd: packageRoot, env: safeEnvironment(), timeout: 60_000 },
      ).trim()
      assert.equal(remainingImageTags, '', 'The task-owned Docker image tag remains after cleanup.')
      imageTagRemoved = true
    } catch (error) {
      failure ??= {
        status: 'FAIL',
        runId,
        imageTag,
        errorType: error instanceof Error ? error.name : 'unknown',
        message: 'Owned Docker smoke image cleanup failed.',
        providerRequests: 0,
      }
    }
  }
  try {
    const buildLogPath = join(runRoot, 'docker-build.log')
    let existingBuildLog
    try {
      existingBuildLog = await readFile(buildLogPath, 'utf8')
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        failure ??= {
          status: 'FAIL',
          runId,
          imageTag,
          errorType: error instanceof Error ? error.name : 'unknown',
          message: 'Owned Docker build log could not be read consistently.',
          providerRequests: 0,
        }
      }
    }
    if (failure === undefined) {
      if (existingBuildLog !== undefined) {
        assert.equal(
          existingBuildLog,
          buildOutput,
          'Retained Docker build log changed during the run.',
        )
      } else if (buildOutput.length > 0) {
        await writeFile(buildLogPath, buildOutput, { flag: 'wx', mode: 0o600 })
      }
    }
  } catch (error) {
    failure ??= {
      status: 'FAIL',
      runId,
      imageTag,
      errorType: error instanceof Error ? error.name : 'unknown',
      message: 'Owned Docker build log could not be retained consistently.',
      providerRequests: 0,
    }
  }
  try {
    await rm(workRoot, { recursive: true, force: true })
  } catch (error) {
    failure ??= {
      status: 'FAIL',
      runId,
      imageTag,
      errorType: error instanceof Error ? error.name : 'unknown',
      message: 'Owned Docker smoke temporary directory cleanup failed.',
      providerRequests: 0,
    }
  }
  if (failure !== undefined) {
    if (buildOutput.length > 0) {
      await writeFile(join(runRoot, 'docker-build.log'), buildOutput, { flag: 'wx', mode: 0o600 })
    }
    const receiptPath = join(runRoot, 'failure.json')
    await writeFile(receiptPath, `${JSON.stringify(failure, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    process.stderr.write(`MCP Docker smoke failed; receipt: ${receiptPath}\n`)
    process.exitCode = 1
  } else if (passReceipt !== undefined && containerRemoved && imageTagRemoved) {
    const passReceiptPath = join(runRoot, 'receipt.json')
    await writeFile(passReceiptPath, `${JSON.stringify(passReceipt, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    process.stdout.write(`${JSON.stringify({ status: 'PASS', receipt: passReceiptPath })}\n`)
  }
}

function run(executable, args, options) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    shell: false,
    timeout: options.timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    const output = [result.stdout ?? '', result.stderr ?? ''].filter(Boolean).join('\n')
    if (executable === 'docker' && args[0] === 'build' && output.length > 0) buildOutput = output
    throw new Error(
      `Owned Docker command ${args[0]} failed; detailed output is retained only for build commands.`,
    )
  }
  return `${result.stdout ?? ''}${result.stderr ? `\n${result.stderr}` : ''}`
}

function safeEnvironment() {
  return Object.fromEntries(
    ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  )
}
