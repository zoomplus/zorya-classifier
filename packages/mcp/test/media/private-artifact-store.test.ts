import assert from 'node:assert/strict'
import test from 'node:test'
import { createPrivateArtifactStore } from '../../src/media/private-artifact-store.js'

const future = () => Date.now() + 5_000

await test('private artifact store copies bytes and scopes uploaded ids to their verified owner', async (context) => {
  const store = createPrivateArtifactStore({
    maxGlobalBytes: 4_096,
    maxOwnerBytes: 2_048,
    maxArtifactBytes: 1_024,
    ttlMs: 10_000,
  })
  context.after(() => store.dispose())
  const original = Uint8Array.from([1, 2, 3, 4])
  const descriptor = await store.putUpload({
    ownerId: 'owner-a',
    bytes: original,
    mediaType: 'image/png',
    signal: new AbortController().signal,
    deadlineAt: future(),
  })
  original.fill(9)
  const loaded = await store.readUploaded({
    ownerId: 'owner-a',
    id: descriptor.id,
    signal: new AbortController().signal,
    deadlineAt: future(),
    maxBytes: 32,
  })
  assert.deepEqual([...loaded.bytes], [1, 2, 3, 4])
  await assert.rejects(
    store.readUploaded({
      ownerId: 'owner-b',
      id: descriptor.id,
      signal: new AbortController().signal,
      deadlineAt: future(),
      maxBytes: 32,
    }),
    (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'NOT_FOUND',
  )
})

await test('private artifact cleanup is owner/job scoped and still runs after cancellation', async (context) => {
  const store = createPrivateArtifactStore({
    maxGlobalBytes: 4_096,
    maxOwnerBytes: 2_048,
    maxArtifactBytes: 1_024,
    ttlMs: 10_000,
  })
  context.after(() => store.dispose())
  const signal = new AbortController().signal
  const first = await store.put({
    ownerId: 'owner-a',
    jobId: 'job-1',
    role: 'source',
    bytes: Uint8Array.of(1, 2),
    mediaType: 'image/png',
    expiresAt: future(),
    signal,
    deadlineAt: future(),
  })
  const other = await store.put({
    ownerId: 'owner-a',
    jobId: 'job-2',
    role: 'source',
    bytes: Uint8Array.of(3),
    mediaType: 'image/png',
    expiresAt: future(),
    signal,
    deadlineAt: future(),
  })
  const aborted = new AbortController()
  aborted.abort()
  await store.deleteJob({
    ownerId: 'owner-a',
    jobId: 'job-1',
    signal: aborted.signal,
    deadlineAt: 0,
  })
  await assert.rejects(
    store.read({
      ownerId: 'owner-a',
      artifactId: first.id,
      signal,
      deadlineAt: future(),
      maxBytes: 32,
    }),
    /not found/u,
  )
  assert.deepEqual(
    [
      ...(
        await store.read({
          ownerId: 'owner-a',
          artifactId: other.id,
          signal,
          deadlineAt: future(),
          maxBytes: 32,
        })
      ).bytes,
    ],
    [3],
  )
})

await test('private artifact store enforces owner and global byte quotas', async (context) => {
  const store = createPrivateArtifactStore({
    maxGlobalBytes: 16,
    maxOwnerBytes: 8,
    maxArtifactBytes: 8,
    maxArtifacts: 4,
    maxArtifactsPerOwner: 4,
    ttlMs: 10_000,
  })
  context.after(() => store.dispose())
  await store.putUpload({
    ownerId: 'owner-a',
    bytes: new Uint8Array(8),
    mediaType: 'image/png',
    signal: new AbortController().signal,
    deadlineAt: future(),
  })
  await assert.rejects(
    store.putUpload({
      ownerId: 'owner-a',
      bytes: new Uint8Array(1),
      mediaType: 'image/png',
      signal: new AbortController().signal,
      deadlineAt: future(),
    }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'CAPACITY_LIMIT',
  )
  await store.putUpload({
    ownerId: 'owner-b',
    bytes: new Uint8Array(8),
    mediaType: 'image/png',
    signal: new AbortController().signal,
    deadlineAt: future(),
  })
  await assert.rejects(
    store.putUpload({
      ownerId: 'owner-c',
      bytes: new Uint8Array(1),
      mediaType: 'image/png',
      signal: new AbortController().signal,
      deadlineAt: future(),
    }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'CAPACITY_LIMIT',
  )
})

await test('oversized output artifacts fail as resource limits and job cleanup removes already written partial artifacts', async (context) => {
  const store = createPrivateArtifactStore({
    maxGlobalBytes: 4_096,
    maxOwnerBytes: 2_048,
    maxArtifactBytes: 8,
    ttlMs: 10_000,
  })
  context.after(() => store.dispose())
  const signal = new AbortController().signal
  const source = await store.put({
    ownerId: 'owner-a',
    jobId: 'job-output',
    role: 'source',
    bytes: Uint8Array.of(1, 2, 3),
    mediaType: 'image/png',
    expiresAt: future(),
    signal,
    deadlineAt: future(),
  })
  await assert.rejects(
    store.put({
      ownerId: 'owner-a',
      jobId: 'job-output',
      role: 'cutout',
      bytes: new Uint8Array(9),
      mediaType: 'image/png',
      expiresAt: future(),
      signal,
      deadlineAt: future(),
    }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'RESOURCE_LIMIT',
  )
  await store.deleteJob({ ownerId: 'owner-a', jobId: 'job-output', signal, deadlineAt: future() })
  await assert.rejects(
    store.read({
      ownerId: 'owner-a',
      artifactId: source.id,
      signal,
      deadlineAt: future(),
      maxBytes: 32,
    }),
    (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'NOT_FOUND',
  )
})
