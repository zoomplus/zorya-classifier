import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsPromises, { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  providerRefusalReplayProtocolSchema,
  PROVIDER_REFUSAL_REPLAY_DEADLINE_ISO,
  PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_PATH,
  PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_SHA256,
  PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_PATH,
  PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_SHA256,
  PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH,
  PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH,
  PROVIDER_REFUSAL_REPLAY_STUDY_ID,
  PROVIDER_REFUSAL_REPLAY_FREEZE_ID,
} from './provider-refusal-replay-admission.js'
import * as legacyAdmission from './provider-refusal-replay-admission.js'
import {
  PROVIDER_REFUSAL_REPLAY_ROOT,
  verifyProviderRefusalReplayAdmission,
} from './provider-refusal-replay-admission.js'
import { verifyDevReplayAdmission } from './dev-replay-admission.js'
import {
  AUTHORED_SCOPE_ROOT,
  AUTHORED_SCOPE_STUDY_ID,
  LEGACY_REPLAY_ROOT,
} from './dev-replay-study-policy.js'
import { makeAuthoredScopeProtocolFixture } from './dev-replay-test-fixtures.js'
import { PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY } from './provider-refusal-replay.js'
import {
  UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256,
  UI_STATE_DEV40_RUNTIME_PROOF_SHA256,
} from './ui-state-dev40-policy.js'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

await test('replay protocol schema binds fixed namespace, policy and unchanged bounded budget', () => {
  const protocol = providerRefusalReplayProtocolSchema.parse({
    schema: 'h8a-provider-refusal-replay-protocol-v1',
    studyId: PROVIDER_REFUSAL_REPLAY_STUDY_ID,
    freezeId: PROVIDER_REFUSAL_REPLAY_FREEZE_ID,
    deadlineIso: PROVIDER_REFUSAL_REPLAY_DEADLINE_ISO,
    parentAudit: {
      path: PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_PATH,
      sha256: PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_SHA256,
    },
    sourceAudit: {
      path: PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_PATH,
      sha256: PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_SHA256,
    },
    freeze: { path: '/tmp/freeze.json', sha256: hash('freeze') },
    annotations: { path: '/tmp/annotations.json', sha256: hash('annotations') },
    selection: { path: '/tmp/selection.json', sha256: hash('selection') },
    producerClosure: { path: '/tmp/closure.json', sha256: hash('closure') },
    runtimeProof: {
      path: PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH,
      sha256: UI_STATE_DEV40_RUNTIME_PROOF_SHA256,
    },
    runtimeEnvironment: {
      path: PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH,
      sha256: UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256,
    },
    sourceBytes: Array.from({ length: 40 }, (_, index) => ({
      caseId: `case-${index}`,
      path: `/tmp/source-${index}.png`,
      sha256: hash(`source-${index}`),
      bytes: 1,
    })),
    referenceMasks: Array.from({ length: 16 }, (_, index) => ({
      path: `/tmp/mask-${index}.bin`,
      sha256: hash(`mask-${index}`),
      packedBinarySha256: hash(`mask-${index}`),
    })),
    executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY.policySha256,
    budget: {
      globalPhysicalCallLimit: 2000,
      dev40PhysicalCallLimit: 400,
      candidateMaxCallsPerCase: 4,
      controlMaxCallsPerCase: 6,
      candidateMaxUsdPerDispatch: 0.55,
      controlMaxUsdPerDispatch: 0.12,
      ownerDollarCeilingUsd: null,
    },
    noRetryOrFallback: true,
    physicalCallsAt: 'fetch',
  })
  assert.equal(protocol.sourceBytes.length, 40)
  assert.equal(protocol.referenceMasks.length, 16)
  assert.equal(protocol.runtimeProof.path, PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH)
  assert.equal(protocol.runtimeEnvironment.path, PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH)
  assert.deepEqual(Object.keys(protocol), [
    'schema',
    'studyId',
    'freezeId',
    'deadlineIso',
    'parentAudit',
    'sourceAudit',
    'freeze',
    'annotations',
    'selection',
    'producerClosure',
    'runtimeProof',
    'runtimeEnvironment',
    'sourceBytes',
    'referenceMasks',
    'executionPolicy',
    'budget',
    'noRetryOrFallback',
    'physicalCallsAt',
  ])
  assert.equal(Object.hasOwn(protocol, 'queryPolicy'), false)
  assert.throws(() =>
    providerRefusalReplayProtocolSchema.parse({
      ...protocol,
      budget: { ...protocol.budget, ownerDollarCeilingUsd: 10 },
    }),
  )
  assert.throws(() =>
    providerRefusalReplayProtocolSchema.parse({ ...protocol, executionPolicy: hash('wrong') }),
  )
  assert.throws(() =>
    providerRefusalReplayProtocolSchema.parse({
      ...protocol,
      runtimeProof: {
        ...protocol.runtimeProof,
        path: 'zorya-classifier-mcp-20261101/main-flat-compare-v2/checked-runtime-files-v2.json',
      },
    }),
  )
  assert.throws(() =>
    providerRefusalReplayProtocolSchema.parse({
      ...protocol,
      runtimeEnvironment: {
        ...protocol.runtimeEnvironment,
        path: '/tmp/runtime-environment.json',
      },
    }),
  )
  assert.throws(() =>
    providerRefusalReplayProtocolSchema.parse({
      ...protocol,
      studyId: AUTHORED_SCOPE_STUDY_ID,
    }),
  )
  assert.throws(() =>
    providerRefusalReplayProtocolSchema.parse({
      ...protocol,
      freezeId: 'h8a-authored-scope-dev40-20261101-v1',
    }),
  )
  assert.throws(() =>
    providerRefusalReplayProtocolSchema.parse({
      ...protocol,
      queryPolicy: { policyId: 'strict-authored-scope-v1' },
    }),
  )
})

await test('legacy wrapper retains its bound exports and rejects a scope protocol before parent reads', async () => {
  assert.equal(PROVIDER_REFUSAL_REPLAY_ROOT, LEGACY_REPLAY_ROOT)
  assert.equal(
    PROVIDER_REFUSAL_REPLAY_ROOT,
    '/root/.codex/artifacts/zorya-classifier-mcp-20261101/provider-refusal-dev40-replay-v1',
  )
  assert.deepEqual(
    Object.keys(legacyAdmission).sort(),
    [
      'PROVIDER_REFUSAL_REPLAY_DEADLINE_ISO',
      'PROVIDER_REFUSAL_REPLAY_FREEZE_ID',
      'PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_PATH',
      'PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_SHA256',
      'PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_PATH',
      'PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_SHA256',
      'PROVIDER_REFUSAL_REPLAY_ROOT',
      'PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH',
      'PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH',
      'PROVIDER_REFUSAL_REPLAY_STUDY_ID',
      'providerRefusalReplayProtocolSchema',
      'verifyProviderRefusalReplayAdmission',
    ].sort(),
  )

  const root = await mkdtemp(join(tmpdir(), 'legacy-replay-boundary-'))
  try {
    const protocol = {
      ...makeAuthoredScopeProtocolFixture(),
      parentAudit: {
        path: join(root, 'parent-must-not-be-read.json'),
        sha256: hash('parent sentinel'),
      },
      sourceAudit: {
        path: join(root, 'source-must-not-be-read.json'),
        sha256: hash('source sentinel'),
      },
    }
    const protocolPath = join(root, 'scope-protocol.json')
    const protocolBytes = Buffer.from(JSON.stringify(protocol), 'utf8')
    await writeFile(protocolPath, protocolBytes, { mode: 0o600, flag: 'wx' })
    await assert.rejects(
      verifyProviderRefusalReplayAdmission({
        protocolPath,
        protocolSha256: hash(protocolBytes.toString('utf8')),
        repositoryRoot: process.cwd(),
        now: () => Date.parse('2026-11-01T12:00:00.000Z'),
      }),
      (error: unknown) => error instanceof Error && Reflect.get(error, 'code') !== 'ENOENT',
    )
  } finally {
    await rm(root, { recursive: true, force: false })
  }
})

await test('shared admission rejects unknown selectors before file access and snapshots caller inputs', async () => {
  const expectedProtocolPath = resolve(AUTHORED_SCOPE_ROOT, 'protocol-inputs', 'protocol.json')
  const observedLstatPaths: string[] = []
  const mockedLstat = test.mock.method(
    fsPromises,
    'lstat',
    async (path: Parameters<typeof fsPromises.lstat>[0]): Promise<never> => {
      if (typeof path !== 'string') throw new Error('Unexpected non-string replay file path')
      const normalizedPath = resolve(path)
      observedLstatPaths.push(normalizedPath)
      assert.equal(normalizedPath, expectedProtocolPath, 'unexpected replay filesystem access')
      throw Object.assign(new Error('Controlled missing protocol fixture'), {
        code: 'ENOENT',
        path: normalizedPath,
      })
    },
  )

  try {
    syncBuiltinESMExports()
    await assert.rejects(
      verifyDevReplayAdmission({
        studyId: 'caller-selected-study-v1',
        protocolPath: resolve(AUTHORED_SCOPE_ROOT, 'protocol-inputs', 'protocol.json'),
        protocolSha256: hash('protocol'),
        repositoryRoot: process.cwd(),
      }),
      /closed registry/u,
    )
    assert.deepEqual(
      observedLstatPaths,
      [],
      'unknown study selector must be rejected before file access',
    )

    const options: {
      studyId: string
      protocolPath: string
      protocolSha256: string
      repositoryRoot: string
      allowExpiredReadOnly: boolean
    } = {
      studyId: AUTHORED_SCOPE_STUDY_ID,
      protocolPath: expectedProtocolPath,
      protocolSha256: hash('offline-missing-protocol'),
      repositoryRoot: process.cwd(),
      allowExpiredReadOnly: true,
    }
    const pending = verifyDevReplayAdmission(options)
    options.studyId = 'caller-selected-study-v1'
    options.protocolPath = resolve(AUTHORED_SCOPE_ROOT, 'protocol-inputs', 'changed-protocol.json')
    options.allowExpiredReadOnly = false
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof Error &&
        Reflect.get(error, 'code') === 'ENOENT' &&
        Reflect.get(error, 'path') === expectedProtocolPath,
    )
    assert.deepEqual(observedLstatPaths, [expectedProtocolPath])

    await assert.rejects(
      verifyDevReplayAdmission({
        studyId: AUTHORED_SCOPE_STUDY_ID,
        protocolPath: expectedProtocolPath,
        protocolSha256: hash('offline-missing-protocol'),
        repositoryRoot: process.cwd(),
        allowExpiredReadOnly: 'yes' as unknown as boolean,
      }),
      /must be boolean/u,
    )
    assert.deepEqual(
      observedLstatPaths,
      [expectedProtocolPath],
      'invalid allowExpiredReadOnly selector must be rejected before file access',
    )
  } finally {
    mockedLstat.mock.restore()
    syncBuiltinESMExports()
  }
})
