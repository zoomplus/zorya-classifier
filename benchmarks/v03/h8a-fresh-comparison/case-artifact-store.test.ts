import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { ImmutableCaseArtifactStore } from './case-artifact-store.js'
import type { CaseArtifactIdentity } from './case-artifact-store.js'
import { PROFILE_CANDIDATE_ID } from './constants.js'
import type { CaseExecutionPortResult } from './paired-runner.js'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function identity(
  profileId:
    | typeof PROFILE_CANDIDATE_ID
    | 'v02-final-v3-fresh-cohort-replay-v1' = PROFILE_CANDIDATE_ID,
): CaseArtifactIdentity {
  const hash = 'a'.repeat(64)
  return {
    freezeCommitmentSha256: hash,
    sourceManifestSha256: 'b'.repeat(64),
    recipeIdentitySha256: 'c'.repeat(64),
    requestPolicyIdentitySha256: 'd'.repeat(64),
    pairedScheduleSha256: 'e'.repeat(64),
    selectionCommitmentSha256: 'f'.repeat(64),
    opaqueCaseId: 'opaque-1',
    profileId,
    sourceBytesSha256: '1'.repeat(64),
    targetTaskSha256: '2'.repeat(64),
    sourceCanvasWidth: 8,
    sourceCanvasHeight: 8,
  }
}

function result(
  cutoutBytes?: Uint8Array,
  maskBytes?: Uint8Array,
  profileId:
    | typeof PROFILE_CANDIDATE_ID
    | 'v02-final-v3-fresh-cohort-replay-v1' = PROFILE_CANDIDATE_ID,
): CaseExecutionPortResult {
  const maskSha = maskBytes ? digest(maskBytes) : null
  const outputRow = {
    schema: 'h8a-fresh-output-row-v1' as const,
    opaqueCaseId: 'opaque-1',
    profileId,
    executionValidity: 'valid' as const,
    caseState: 'success' as const,
    box: cutoutBytes ? { left: 1, top: 1, width: 2, height: 2 } : null,
    cutoutPresent: Boolean(cutoutBytes),
    maskPackedSha256: maskSha,
    logicalReceiptIds: [1],
    physicalReceiptIds: [],
  }
  return {
    outputRow,
    logicalReceipts: [
      {
        logicalId: 1,
        opaqueCaseId: 'opaque-1',
        profileId,
        requestSha256: '3'.repeat(64),
        physicalIds: [],
        outcome: 'resolved',
      },
    ],
    physicalReceipts: [],
    ...(cutoutBytes
      ? {
          caseArtifactSidecars: [
            {
              opaqueCaseId: 'opaque-1',
              profileId,
              kind:
                profileId === PROFILE_CANDIDATE_ID
                  ? ('candidate-cutout-rgba' as const)
                  : ('control-cutout-png' as const),
              sha256: digest(cutoutBytes),
              byteLength: cutoutBytes.byteLength,
              width: 2,
              height: 2,
              sourceCanvasWidth: 8,
              sourceCanvasHeight: 8,
              sourceRegion: { left: 1, top: 1, width: 2, height: 2 },
              sourceOffset: { x: 1, y: 1 },
            },
          ],
        }
      : {}),
  }
}

await test('an incomplete immutable intent is validated and never autorizes a retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-case-intent-'))
  try {
    const store = new ImmutableCaseArtifactStore(root)
    const id = identity()
    await store.begin(id, new Date().toISOString())
    await assert.rejects(() => store.begin(id, new Date().toISOString()), /pending intent/u)
    const opened = store.identity(id)
    const path = join(root, 'case-intents', opened.sha256.slice(0, 2), `${opened.sha256}.json`)
    await writeFile(path, '{broken', 'utf8')
    await assert.rejects(() => store.begin(id, new Date().toISOString()), /JSON|Unexpected/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('completed cutout is reopened byte-for-byte and missing/corrupt bytes block reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-case-cutout-'))
  try {
    const store = new ImmutableCaseArtifactStore(root)
    const id = identity()
    const opened = await store.begin(id, new Date().toISOString())
    const bytes = new Uint8Array(16).fill(17)
    for (let index = 0; index < bytes.length; index += 4) bytes[index + 3] = 255
    const mask = new Uint8Array(8)
    for (const pixel of [9, 10, 17, 18]) mask[Math.floor(pixel / 8)]! |= 1 << pixel % 8
    const complete = await store.complete({
      identitySha256: opened.identitySha256,
      identity: opened.identity,
      result: result(bytes, mask),
      durationMs: 3.5,
      startedAtIso: new Date().toISOString(),
      completedAtIso: new Date().toISOString(),
      knownCostUsd: 0,
      unknownDispatchCount: 0,
      blobs: new Map([
        [digest(bytes), bytes],
        [digest(mask), mask],
      ]),
    })
    const reopened = await store.begin(id, new Date().toISOString())
    assert.ok(reopened.existing)
    assert.deepEqual(reopened.existing!.blobsBySha256.get(digest(bytes)), bytes)
    assert.equal(reopened.existing!.result.caseArtifactSidecars?.[0]?.sha256, digest(bytes))
    const blobPath = complete.artifactPaths.find((path) => path.endsWith(digest(bytes)))!
    await writeFile(blobPath, new Uint8Array([0]))
    await assert.rejects(() => store.begin(id, new Date().toISOString()), /missing or corrupt/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('identity or sidecar cross-row, profile, geometry and offset edits are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-case-integrity-'))
  try {
    const store = new ImmutableCaseArtifactStore(root)
    const id = identity()
    const opened = await store.begin(id, new Date().toISOString())
    const bytes = new Uint8Array(16).fill(0)
    for (let index = 0; index < bytes.length; index += 4) bytes[index + 3] = 255
    const mask = new Uint8Array(8)
    for (const pixel of [9, 18]) mask[Math.floor(pixel / 8)]! |= 1 << pixel % 8
    const wrongCase = result(bytes, mask, PROFILE_CANDIDATE_ID)
    wrongCase.caseArtifactSidecars![0]!.opaqueCaseId = 'other-case'
    await assert.rejects(
      () =>
        store.complete({
          identitySha256: opened.identitySha256,
          identity: opened.identity,
          result: wrongCase,
          durationMs: 1,
          startedAtIso: new Date().toISOString(),
          completedAtIso: new Date().toISOString(),
          knownCostUsd: 0,
          unknownDispatchCount: 0,
          blobs: new Map([
            [digest(bytes), bytes],
            [digest(mask), mask],
          ]),
        }),
      /case\/profile/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('a pending case intent recovers correlated dispatch receipts without authorizing retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-case-recovery-'))
  try {
    const store = new ImmutableCaseArtifactStore(root)
    const id = identity()
    const opened = await store.begin(id, new Date().toISOString())
    const journalDirectory = join(root, 'dispatch-journal')
    const journalEntry = {
      reservationId: 41,
      physicalId: 8,
      profileId: PROFILE_CANDIDATE_ID,
      opaqueCaseId: id.opaqueCaseId,
      caseExecutionIdentitySha256: opened.identitySha256,
      logicalId: 7,
      recorderPhysicalId: 3,
      requestSha256: '4'.repeat(64),
      requestBodySha256: '5'.repeat(64),
      endpoint: '/api/v1/chat/completions',
      dispatchState: 'confirmed',
      settled: true,
      costUsd: 0.07,
      httpStatus: 200,
    }
    await mkdir(journalDirectory, { recursive: true })
    await writeFile(
      join(journalDirectory, 'dispatch-41.json'),
      `${JSON.stringify(journalEntry)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    )
    const recovered = await store.loadOrRecover(id)
    assert.ok(recovered)
    assert.equal(recovered!.durationMs, null)
    assert.equal(recovered!.knownCostUsd, 0.07)
    assert.equal(recovered!.result.outputRow.executionValidity, 'invalid')
    assert.equal(recovered!.result.outputRow.caseState, 'unknown')
    assert.deepEqual(
      recovered!.result.physicalReceipts.map((receipt) => [
        receipt.receiptId,
        receipt.physicalId,
        receipt.dispatchState,
      ]),
      [[41, 8, 'confirmed']],
    )
    assert.ok((await store.begin(id, new Date().toISOString())).existing)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('control PNG sidecar is fully decoded and its alpha is checked against the source mask', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-case-control-png-'))
  try {
    const store = new ImmutableCaseArtifactStore(root)
    const id = identity('v02-final-v3-fresh-cohort-replay-v1')
    const opened = await store.begin(id, new Date().toISOString())
    const mask = new Uint8Array(8)
    for (const pixel of [9, 18]) mask[Math.floor(pixel / 8)]! |= 1 << pixel % 8
    const rgba = new Uint8Array(16)
    for (let index = 0; index < rgba.length; index += 4) rgba[index + 3] = 255
    const png = await sharp(rgba, { raw: { width: 2, height: 2, channels: 4 } })
      .png()
      .toBuffer()
    const bytes = new Uint8Array(png)
    await assert.rejects(
      () =>
        store.complete({
          identitySha256: opened.identitySha256,
          identity: opened.identity,
          result: result(bytes, mask, 'v02-final-v3-fresh-cohort-replay-v1'),
          durationMs: 1,
          startedAtIso: new Date().toISOString(),
          completedAtIso: new Date().toISOString(),
          knownCostUsd: 0,
          unknownDispatchCount: 0,
          blobs: new Map([
            [digest(bytes), bytes],
            [digest(mask), mask],
          ]),
        }),
      /alpha/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
