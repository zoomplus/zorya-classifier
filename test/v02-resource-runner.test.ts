import assert from 'node:assert/strict'
import { channel } from 'node:diagnostics_channel'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'

import {
  ResourceRunner,
  disposeInOrder,
  runMonotonicPhase,
  validateFullSoakDurations,
  waitMonotonicDuration,
} from '../benchmarks/v02/resource-runner.js'

await test('resource runner captures parent and owned-child memory then observes zero owned children', () => {
  const runner = new ResourceRunner(250)
  const childChannel = channel('zorya.segmentation.child-resource')
  runner.start()
  childChannel.publish({ type: 'start', jobId: 'job-1', pid: 77 })
  childChannel.publish({
    type: 'memory',
    jobId: 'job-1',
    pid: 77,
    rss: 400,
    heapTotal: 200,
    heapUsed: 100,
    external: 50,
    arrayBuffers: 25,
  })
  childChannel.publish({ type: 'close', jobId: 'job-1', pid: 77 })
  const report = runner.stop()
  assert.equal(report.childStarts, 1)
  assert.equal(report.childCloses, 1)
  assert.deepEqual(report.childrenStillOwned, [])
  assert.equal(report.childPeak.rss, 400)
  assert.ok(report.parentSamples.length >= 1)
  assert.ok(report.parentPeak.rss > 0)
  const phased = new ResourceRunner(250)
  phased.start()
  phased.setPhase('busy')
  phased.setPhase('idle-after')
  const phasedReport = phased.stop()
  assert.deepEqual(
    phasedReport.parentSamples.map((sample) => sample.phase),
    ['idle-before', 'busy', 'idle-after', 'idle-after'],
  )
  assert.ok(phasedReport.parentSamples.every((sample) => sample.timestampMs >= 0))
  assert.ok(phasedReport.idleWindowMedian.before.heapUsed > 0)
  assert.ok(phasedReport.idleWindowMedian.after.external > 0)
})

await test('soak phases follow monotonic time when wall clock jumps', async () => {
  let monotonicMs = 0
  let wallClockMs = 1_000_000
  let iterations = 0
  const durationMs = await runMonotonicPhase(
    100,
    async () => {
      iterations++
      wallClockMs += 60_000
      monotonicMs += 10
    },
    { now: () => monotonicMs },
  )
  assert.equal(iterations, 10)
  assert.equal(durationMs, 100)
  assert.equal(wallClockMs, 1_600_000)

  const samples = new ResourceRunner(250, () => monotonicMs)
  samples.start()
  samples.setPhase('busy')
  monotonicMs += 25
  const report = samples.stop()
  assert.equal(report.observedDurationMs, 25)
  assert.ok(report.parentSamples.every((sample) => sample.timestampMs <= 25))
  assert.ok(report.phaseTransitions.every((phase) => phase.timestampMs <= 25))
})

await test('minimum monotonic wait retries early timers until the exact deadline', async () => {
  let monotonicMs = 100
  const requestedWaits: number[] = []
  const earlyAdvances = [29_999.5, 1]
  const elapsedMs = await waitMonotonicDuration(30_000, {
    now: () => monotonicMs,
    wait: async (waitMs) => {
      requestedWaits.push(waitMs)
      monotonicMs += earlyAdvances.shift() ?? waitMs
    },
  })

  assert.deepEqual(requestedWaits, [30_000, 1])
  assert.equal(elapsedMs, 30_000.5)
  assert.ok(elapsedMs >= 30_000)
})

await test('minimum monotonic wait cancels its abortable timer and removes the signal listener', async () => {
  const controller = new AbortController()
  const wait = waitMonotonicDuration(60_000, { signal: controller.signal })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)

  controller.abort(new Error('test cancellation'))
  await assert.rejects(wait, { name: 'AbortError' })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

await test('qualified resource runs enforce duration and cleanup requirements', async () => {
  assert.equal(
    validateFullSoakDurations({ warmupSeconds: 600, durationSeconds: 6540, idleSeconds: 30 }),
    true,
  )
  assert.equal(
    validateFullSoakDurations({ warmupSeconds: 599, durationSeconds: 6540, idleSeconds: 30 }),
    false,
  )
  assert.equal(
    validateFullSoakDurations({ warmupSeconds: 600, durationSeconds: 6539, idleSeconds: 30 }),
    false,
  )
  assert.equal(
    validateFullSoakDurations({ warmupSeconds: 600, durationSeconds: 6540, idleSeconds: 29 }),
    false,
  )

  const calls: string[] = []
  await assert.rejects(
    disposeInOrder([
      async () => {
        calls.push('classifier')
        throw new Error('classifier dispose failed')
      },
      async () => {
        calls.push('adapter')
      },
    ]),
    /classifier dispose failed/,
  )
  assert.deepEqual(calls, ['classifier', 'adapter'])
})
