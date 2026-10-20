import assert from 'node:assert/strict'
import { channel } from 'node:diagnostics_channel'
import { test } from 'node:test'

import { ResourceRunner } from '../benchmarks/v02/resource-runner.js'

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
})
