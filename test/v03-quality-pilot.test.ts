import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { runPilotCase } from '../benchmarks/v03/run-quality-pilot.js'
import type { FreshCase } from '../benchmarks/v02/fresh-corpus.js'
import type { DecisionPort } from '../src/entities/contracts.js'
import { ClassifierError } from '../src/entities/errors.js'

const item: FreshCase = {
  caseId: 'private-controller-id',
  image: { path: 'private/source.png', sha256: 'a'.repeat(64), width: 320, height: 280 },
  locate: { target: 'the visible circle' },
  classify: { question: 'Is the circle visible?', options: ['present', 'absent'] },
}
const image = await sharp({
  create: { width: 320, height: 280, channels: 3, background: '#888888' },
})
  .png()
  .toBuffer()

await test('pilot preserves provider failure without retry, fallback or absence conversion', async () => {
  let calls = 0
  const decision: DecisionPort = {
    async decide(request) {
      calls++
      const payload = JSON.stringify(request)
      for (const privateValue of [item.caseId, item.image.path, item.image.sha256])
        assert.equal(payload.includes(privateValue), false)
      throw new ClassifierError('PROVIDER', 'Fixture rejection')
    },
  }
  const result = await runPilotCase(
    item,
    image,
    'v02-presence-region',
    decision,
    new AbortController().signal,
  )
  assert.equal(calls, 1)
  assert.equal(result.classify.status, 'failed')
  assert.equal(result.extraction.status, 'failed')
  assert.equal(result.extraction.errorCode, 'PROVIDER')
  assert.equal(result.extraction.seed.region, undefined)
})

await test('pre-cancelled zoom pilot dispatches no model and retains cancelled failure', async () => {
  let calls = 0
  const decision: DecisionPort = {
    async decide() {
      calls++
      throw new Error('Must not run')
    },
  }
  const controller = new AbortController()
  controller.abort(new ClassifierError('ABORTED', 'Fixture stop'))
  const result = await runPilotCase(item, image, 'v03-zoom-region', decision, controller.signal)
  assert.equal(calls, 0)
  assert.equal(result.classify.status, 'skipped')
  assert.equal(result.extraction.status, 'failed')
  assert.equal(result.extraction.errorCode, 'ABORTED')
})
