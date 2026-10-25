import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  JEV_NATIVE_BOX_CASE_DEADLINE_MS,
  JEV_NATIVE_BOX_ENDPOINT,
  JEV_NATIVE_BOX_MAX_CONSECUTIVE_TRANSPORT_ERRORS,
  JEV_NATIVE_BOX_MAX_COST_USD,
  JEV_NATIVE_BOX_MAX_PHYSICAL_CALLS,
  computeJevNativeBoxFreezeSha256,
  sha256Bytes,
} from '../benchmarks/v03/jev-native-box.js'
import {
  executeJevNativeBoxRun,
  prepareJevNativeBoxFreeze,
  readJevNativeBoxFreeze,
} from '../benchmarks/v03/run-jev-native-box.js'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const dataRootEnv = process.env.ZORYA_JEV_NATIVE_BOX_DATA_ROOT
const artifactRootEnv = process.env.ZORYA_JEV_NATIVE_BOX_ARTIFACT_ROOT

function envSkipReason(): string | null {
  if (!dataRootEnv) return 'ZORYA_JEV_NATIVE_BOX_DATA_ROOT is unset'
  if (!artifactRootEnv) return 'ZORYA_JEV_NATIVE_BOX_ARTIFACT_ROOT is unset'
  return null
}

async function artifactsSkipReason(): Promise<string | null> {
  const capabilityReceipt = join(artifactRootEnv!, 'capability-receipt.json')
  const capabilitySource = join(artifactRootEnv!, 'capability-source.json')
  try {
    await access(dataRootEnv!)
    await access(capabilityReceipt)
    await access(capabilitySource)
  } catch {
    return 'missing DEV12 data root or capability artifacts under ZORYA_JEV_NATIVE_BOX_ARTIFACT_ROOT'
  }
  return null
}

async function localEvidenceSkipReason(): Promise<string | null> {
  const envReason = envSkipReason()
  if (envReason) return envReason
  return artifactsSkipReason()
}

await test('prepare freeze from pinned DEV12 corpus and capability artifacts', async (t) => {
  const skipReason = await localEvidenceSkipReason()
  if (skipReason) {
    t.skip(skipReason)
    return
  }
  const freezeParent = await mkdtemp(join(tmpdir(), 'jev-native-box-local-freeze-'))
  try {
    const { freeze, outputDirectory } = await prepareJevNativeBoxFreeze({
      repositoryRoot,
      dataRoot: resolve(dataRootEnv!),
      capabilityReceiptPath: join(artifactRootEnv!, 'capability-receipt.json'),
      capabilitySourcePath: join(artifactRootEnv!, 'capability-source.json'),
      outputDirectory: join(freezeParent, 'freeze'),
    })
    assert.equal(freeze.profileId, 'jev-native-box-dev12-v1')
    assert.equal(freeze.rows.length, 12)
    const reread = await readJevNativeBoxFreeze(join(outputDirectory, 'freeze.json'))
    assert.equal(reread.freezeSha256, freeze.freezeSha256)
  } finally {
    await rm(freezeParent, { recursive: true, force: true })
  }
})

await test('execute rejects tampered freeze rows against pinned producer manifests', async (t) => {
  const skipReason = await localEvidenceSkipReason()
  if (skipReason) {
    t.skip(skipReason)
    return
  }
  const freezeParent = await mkdtemp(join(tmpdir(), 'jev-native-box-local-tamper-'))
  const runParent = await mkdtemp(join(tmpdir(), 'jev-native-box-local-tamper-run-'))
  try {
    const { freeze, outputDirectory: freezeDirectory } = await prepareJevNativeBoxFreeze({
      repositoryRoot,
      dataRoot: resolve(dataRootEnv!),
      capabilityReceiptPath: join(artifactRootEnv!, 'capability-receipt.json'),
      capabilitySourcePath: join(artifactRootEnv!, 'capability-source.json'),
      outputDirectory: join(freezeParent, 'freeze'),
    })
    const tampered = structuredClone(freeze)
    const originalRow = tampered.rows[0]!
    tampered.rows[0] = {
      ...originalRow,
      imagePath: `${originalRow.imagePath}-tampered-suffix`,
    }
    const { freezeSha256: _ignored, ...tamperedBody } = tampered
    const tamperedDigest = computeJevNativeBoxFreezeSha256(tamperedBody)
    const tamperedPath = join(freezeDirectory, 'freeze-tampered.json')
    await writeFile(
      tamperedPath,
      `${JSON.stringify({ ...tamperedBody, freezeSha256: tamperedDigest }, null, 2)}\n`,
    )
    await assert.rejects(
      () =>
        executeJevNativeBoxRun({
          repositoryRoot,
          dataRoot: resolve(dataRootEnv!),
          freezePath: tamperedPath,
          expectedFreezeSha256: tamperedDigest,
          outputDirectory: join(runParent, 'run'),
          apiKey: 'test-key',
          fetch: async () => new Response('{}', { status: 500 }),
        }),
      /freeze-producer-image-path-mismatch|source-hash-mismatch/u,
    )
  } finally {
    await rm(freezeParent, { recursive: true, force: true })
    await rm(runParent, { recursive: true, force: true })
  }
})

await test('deadline after admission record cancels reservation before fetch with zero physical receipts', async (t) => {
  const skipReason = await localEvidenceSkipReason()
  if (skipReason) {
    t.skip(skipReason)
    return
  }
  const freezeParent = await mkdtemp(join(tmpdir(), 'jev-native-box-local-dispatch-fail-'))
  const runParent = await mkdtemp(join(tmpdir(), 'jev-native-box-local-dispatch-run-'))
  try {
    const { freeze, outputDirectory: freezeDirectory } = await prepareJevNativeBoxFreeze({
      repositoryRoot,
      dataRoot: resolve(dataRootEnv!),
      capabilityReceiptPath: join(artifactRootEnv!, 'capability-receipt.json'),
      capabilitySourcePath: join(artifactRootEnv!, 'capability-source.json'),
      outputDirectory: join(freezeParent, 'freeze'),
    })
    const runDirectory = join(runParent, 'run')
    const now = (): number => {
      if (existsSync(join(runDirectory, 'physical-admission-1.json')))
        return JEV_NATIVE_BOX_CASE_DEADLINE_MS + 1
      return 0
    }
    const manifest = await executeJevNativeBoxRun({
      repositoryRoot,
      dataRoot: resolve(dataRootEnv!),
      freezePath: join(freezeDirectory, 'freeze.json'),
      expectedFreezeSha256: freeze.freezeSha256,
      outputDirectory: runDirectory,
      apiKey: 'test-key',
      now,
      fetch: async () => {
        throw new Error('fetch-should-not-run')
      },
    })
    assert.notEqual(manifest.status, 'complete')
    assert.equal(manifest.physicalReceipts.length, 0)
    assert.equal(manifest.budget.admittedPhysicalCalls, 0)
    assert.equal(manifest.budget.unknownCostCalls, 0)
    assert.equal(manifest.rows[0]?.errorCode, 'deadline-exceeded')
  } finally {
    await rm(freezeParent, { recursive: true, force: true })
    await rm(runParent, { recursive: true, force: true })
  }
})

await test('execute stops after consecutive transport errors with bounded physical count', async (t) => {
  const skipReason = await localEvidenceSkipReason()
  if (skipReason) {
    t.skip(skipReason)
    return
  }
  const freezeParent = await mkdtemp(join(tmpdir(), 'jev-native-box-local-transport-'))
  const runParent = await mkdtemp(join(tmpdir(), 'jev-native-box-local-transport-run-'))
  try {
    const { freeze, outputDirectory: freezeDirectory } = await prepareJevNativeBoxFreeze({
      repositoryRoot,
      dataRoot: resolve(dataRootEnv!),
      capabilityReceiptPath: join(artifactRootEnv!, 'capability-receipt.json'),
      capabilitySourcePath: join(artifactRootEnv!, 'capability-source.json'),
      outputDirectory: join(freezeParent, 'freeze'),
    })
    const fetcher: typeof fetch = async (input, init) => {
      assert.equal(input, JEV_NATIVE_BOX_ENDPOINT)
      assert.equal(init?.method, 'POST')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('TypeSafe-Danger-Zone-Images'), 'true')
      assert.match(headers.get('Authorization') ?? '', /^Bearer test-key$/u)
      return new Response(JSON.stringify({ error: { message: 'transport-down' } }), { status: 502 })
    }
    const manifest = await executeJevNativeBoxRun({
      repositoryRoot,
      dataRoot: resolve(dataRootEnv!),
      freezePath: join(freezeDirectory, 'freeze.json'),
      expectedFreezeSha256: freeze.freezeSha256,
      outputDirectory: join(runParent, 'run'),
      apiKey: 'test-key',
      fetch: fetcher,
    })
    assert.equal(manifest.physicalReceipts.length, JEV_NATIVE_BOX_MAX_CONSECUTIVE_TRANSPORT_ERRORS)
    assert.equal(
      manifest.rows.filter((row) => row.status === 'not-run').length,
      JEV_NATIVE_BOX_MAX_PHYSICAL_CALLS - JEV_NATIVE_BOX_MAX_CONSECUTIVE_TRANSPORT_ERRORS,
    )
    assert.equal(
      manifest.budget.admittedPhysicalCalls,
      JEV_NATIVE_BOX_MAX_CONSECUTIVE_TRANSPORT_ERRORS,
    )
    assert.ok(manifest.budget.accountedExposureUsd <= JEV_NATIVE_BOX_MAX_COST_USD + 1e-9)
  } finally {
    await rm(freezeParent, { recursive: true, force: true })
    await rm(runParent, { recursive: true, force: true })
  }
})

await test('post-read deadline preserves body hash status usage cost and one failure receipt', async (t) => {
  const skipReason = await localEvidenceSkipReason()
  if (skipReason) {
    t.skip(skipReason)
    return
  }
  const freezeParent = await mkdtemp(join(tmpdir(), 'jev-native-box-local-deadline-'))
  const runParent = await mkdtemp(join(tmpdir(), 'jev-native-box-local-deadline-run-'))
  try {
    const { freeze, outputDirectory: freezeDirectory } = await prepareJevNativeBoxFreeze({
      repositoryRoot,
      dataRoot: resolve(dataRootEnv!),
      capabilityReceiptPath: join(artifactRootEnv!, 'capability-receipt.json'),
      capabilitySourcePath: join(artifactRootEnv!, 'capability-source.json'),
      outputDirectory: join(freezeParent, 'freeze'),
    })
    const responseBody = JSON.stringify({
      model: 'typesafe/jev-1.14-20261014',
      provider: 'TypeSafe',
      usage: { cost: 0.0012 },
      answers: {
        presence: { type: 'noul', noul: 0.9 },
        object: { type: 'box', box: { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 } },
      },
    })
    const expectedHash = sha256Bytes(Buffer.from(responseBody, 'utf8'))
    let currentTime = 0
    let fetchCount = 0
    const parentController = new AbortController()
    const now = (): number => {
      if (currentTime > JEV_NATIVE_BOX_CASE_DEADLINE_MS) {
        parentController.abort()
      }
      return currentTime
    }
    const manifest = await executeJevNativeBoxRun({
      repositoryRoot,
      dataRoot: resolve(dataRootEnv!),
      freezePath: join(freezeDirectory, 'freeze.json'),
      expectedFreezeSha256: freeze.freezeSha256,
      outputDirectory: join(runParent, 'run'),
      apiKey: 'test-key',
      signal: parentController.signal,
      now,
      fetch: async () => {
        fetchCount += 1
        const encoded = new TextEncoder().encode(responseBody)
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(encoded)
            controller.close()
            currentTime = JEV_NATIVE_BOX_CASE_DEADLINE_MS + 1
          },
        })
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    assert.notEqual(manifest.status, 'complete')
    assert.equal(fetchCount, 1)
    assert.equal(manifest.physicalReceipts.length, 1)
    const receipt = manifest.physicalReceipts[0]!
    assert.equal(receipt.httpStatus, 200)
    assert.equal(receipt.responseBodySha256, expectedHash)
    assert.equal(receipt.costUsd, 0.0012)
    assert.equal(receipt.outcome, 'protocol-error')
    assert.equal(receipt.errorCode, 'deadline-exceeded')
    assert.equal(manifest.rows[0]?.status, 'protocol-error')
    assert.notEqual(manifest.rows[0]?.status, 'resolved')
    assert.equal(manifest.rows.filter((row) => row.status === 'resolved').length, 0)
    assert.ok(manifest.rows.slice(1).every((row) => row.status !== 'resolved'))
    await readFile(join(runParent, 'run', 'response-body-1.json'), 'utf8')
    await readFile(join(runParent, 'run', 'physical-receipt-1.json'), 'utf8')
  } finally {
    await rm(freezeParent, { recursive: true, force: true })
    await rm(runParent, { recursive: true, force: true })
  }
})
