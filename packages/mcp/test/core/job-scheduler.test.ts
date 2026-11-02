import assert from 'node:assert/strict'
import test from 'node:test'

import type { McpConfigInput } from '../../src/config.js'
import type { OperationOutput, Principal } from '../../src/contracts.js'
import { McpCoreError } from '../../src/errors.js'
import { JobScheduler } from '../../src/core/job-scheduler.js'

const ownerA: Principal = { ownerId: 'owner-a', transport: 'stdio' }
const ownerB: Principal = { ownerId: 'owner-b', transport: 'stdio' }

const output: OperationOutput = {
  operation: 'extract',
  result: {
    status: 'unknown',
    reason: 'segmentation-uncertain',
    artifacts: [],
  },
}

function schedulerConfig(overrides: Record<string, unknown> = {}): McpConfigInput {
  return {
    profiles: {
      injected: {
        id: 'injected',
        adapter: 'injected-decision',
        credentialMode: 'none',
      },
    },
    defaultProfileId: 'injected',
    limits: {
      jobTimeoutMs: 2_000,
      maxActiveJobs: 1,
      maxActiveJobsPerOwner: 1,
      maxQueuedJobs: 4,
      maxQueuedJobsPerOwner: 3,
      maxStoredJobs: 16,
      maxStoredJobsPerOwner: 8,
      maxQueuedInputBytes: 64_000_000,
      maxQueuedInputBytesPerOwner: 32_000_000,
      ...overrides,
    },
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error('Deferred promise is not ready.')
      resolvePromise(value)
    },
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for scheduler state.')
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}

await test('a cancelled running job retains its slot until physical task settlement', async () => {
  const released = deferred<OperationOutput>()
  let firstSignal: AbortSignal | undefined
  let secondStarted = false
  const scheduler = new JobScheduler({ config: schedulerConfig(), onEvict: async () => {} })

  const first = scheduler.submit({
    principal: ownerA,
    operation: 'extract',
    queuedBytes: 10,
    task: async (_jobId, signal) => {
      firstSignal = signal
      return released.promise
    },
  })
  const firstId = String(first['jobId'])
  await waitFor(() => scheduler.get(ownerA.ownerId, firstId).state === 'running')

  const second = scheduler.submit({
    principal: ownerB,
    operation: 'extract',
    queuedBytes: 10,
    task: async () => {
      secondStarted = true
      return output
    },
  })
  const secondId = String(second['jobId'])
  assert.equal(second['state'], 'queued')

  assert.throws(
    () => scheduler.get(ownerB.ownerId, firstId),
    (error: unknown) => error instanceof McpCoreError && error.code === 'NOT_FOUND',
  )
  assert.equal(scheduler.cancel(ownerA.ownerId, firstId).state, 'cancelling')
  assert.equal(firstSignal?.aborted, true)
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  assert.equal(secondStarted, false)

  released.resolve(output)
  await waitFor(() => secondStarted)
  await waitFor(() => scheduler.get(ownerB.ownerId, secondId).state === 'succeeded')
  assert.equal(scheduler.get(ownerA.ownerId, firstId).state, 'cancelled')
  await scheduler.shutdown()
})

await test('queued deadlines fail without starting physical work', async () => {
  const blocker = deferred<OperationOutput>()
  let expiredTaskStarted = false
  const scheduler = new JobScheduler({
    config: schedulerConfig({ jobTimeoutMs: 100 }),
    onEvict: async () => {},
  })
  const active = scheduler.submit({
    principal: ownerA,
    operation: 'extract',
    queuedBytes: 1,
    task: async () => blocker.promise,
  })
  const queued = scheduler.submit({
    principal: ownerB,
    operation: 'extract',
    queuedBytes: 1,
    task: async () => {
      expiredTaskStarted = true
      return output
    },
  })
  const queuedId = String(queued['jobId'])
  await waitFor(() => scheduler.get(ownerB.ownerId, queuedId).state === 'failed')
  assert.equal(scheduler.get(ownerB.ownerId, queuedId).error?.code, 'TIMEOUT')
  assert.equal(expiredTaskStarted, false)

  blocker.resolve(output)
  await waitFor(() => scheduler.get(ownerA.ownerId, String(active['jobId'])).state === 'failed')
  assert.equal(scheduler.get(ownerA.ownerId, String(active['jobId'])).error?.code, 'TIMEOUT')
  await scheduler.shutdown()
})

await test('artifact totals and serialized results stay within configured limits', async () => {
  const cleanup: string[] = []
  const scheduler = new JobScheduler({
    config: schedulerConfig({
      maxArtifactTotalBytes: 1_024,
      maxArtifactTotalBytesPerOwner: 1_024,
      maxResultJsonBytes: 1_024,
    }),
    onEvict: async (_ownerId, jobId) => {
      cleanup.push(jobId)
    },
  })
  const blocker = deferred<OperationOutput>()
  const first = scheduler.submit({
    principal: ownerA,
    operation: 'extract',
    queuedBytes: 0,
    task: async () => blocker.promise,
  })
  const firstId = String(first['jobId'])
  await waitFor(() => scheduler.get(ownerA.ownerId, firstId).state === 'running')
  scheduler.addArtifacts(ownerA.ownerId, firstId, [
    {
      id: 'artifact-a',
      role: 'source',
      mediaType: 'image/png',
      byteLength: 600,
      expiresAt: Date.now() + 10_000,
    },
  ])
  assert.throws(
    () =>
      scheduler.addArtifacts(ownerA.ownerId, firstId, [
        {
          id: 'artifact-b',
          role: 'mask',
          mediaType: 'application/octet-stream',
          byteLength: 500,
          expiresAt: Date.now() + 10_000,
        },
      ]),
    (error: unknown) => error instanceof McpCoreError && error.code === 'RESOURCE_LIMIT',
  )

  const oversized: OperationOutput = {
    operation: 'extract',
    result: {
      status: 'unknown',
      reason: 'x'.repeat(2_000),
      artifacts: [],
    },
  }
  const second = scheduler.submit({
    principal: ownerB,
    operation: 'extract',
    queuedBytes: 0,
    task: async (jobId) => {
      scheduler.addArtifacts(ownerB.ownerId, jobId, [
        {
          id: 'artifact-c',
          role: 'source',
          mediaType: 'image/png',
          byteLength: 100,
          expiresAt: Date.now() + 10_000,
        },
      ])
      return oversized
    },
  })
  const secondId = String(second['jobId'])
  blocker.resolve(output)
  await waitFor(() => scheduler.get(ownerB.ownerId, secondId).state === 'failed')
  assert.equal(scheduler.get(ownerB.ownerId, secondId).error?.code, 'RESOURCE_LIMIT')
  assert.deepEqual(cleanup, [secondId])
  await scheduler.shutdown()
  assert.deepEqual(cleanup, [secondId, firstId])
})

await test('a task settling after its deadline cannot succeed before the timer callback runs', async () => {
  const scheduler = new JobScheduler({
    config: schedulerConfig({ jobTimeoutMs: 100 }),
    onEvict: async () => {},
  })
  const released = deferred<OperationOutput>()
  const submitted = scheduler.submit({
    principal: ownerA,
    operation: 'classify',
    queuedBytes: 0,
    task: async () => released.promise,
  })
  const jobId = String(submitted['jobId'])
  await waitFor(() => scheduler.get(ownerA.ownerId, jobId).state === 'running')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 110)
  released.resolve(output)
  await waitFor(() => scheduler.get(ownerA.ownerId, jobId).state === 'failed')
  assert.equal(scheduler.get(ownerA.ownerId, jobId).error?.code, 'TIMEOUT')
  await scheduler.shutdown()
})
