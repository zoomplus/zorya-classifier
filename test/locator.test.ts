import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { createClassifier } from '../src/index.js'
import type { DecisionRequest, DecisionResult } from '../src/index.js'
import { uniformCoordinateCells } from '../src/features/uniform-grid.js'
import { choiceBeamFirstCells, choiceBeamPanels } from '../src/features/choice-beam-layout.js'
import { createSharpRaster } from '../src/infrastructure/raster.js'

function reply(request: DecisionRequest, present = 1, none = false): DecisionResult {
  return {
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, q]) => {
        if (q.type === 'noul') return [id, { type: 'noul', noul: present }]
        const keys = Object.keys(q.criteria),
          choice = none && keys.includes('none') ? 'none' : (keys[0] ?? '')
        return [
          id,
          {
            type: 'choice',
            choice,
            probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0])),
          },
        ]
      }),
    ),
    metadata: {
      model: 'fixture',
      provider: 'fixture',
      requestId: null,
      durationMs: 0,
      costUsd: null,
      attempts: 1,
    },
  }
}
const image = await sharp({ create: { width: 320, height: 280, channels: 3, background: 'navy' } })
  .png()
  .toBuffer()
await test('full locator has three calls with direct image parts and bounded candidate sets', async () => {
  const calls: DecisionRequest[] = []
  const client = createClassifier({
    decision: {
      async decide(r) {
        calls.push(structuredClone(r))
        return reply(r)
      },
    },
  })
  try {
    const result = await client.locate({ image, target: 'a generic object' })
    assert.equal(result.status, 'located')
    assert.equal(calls.length, 3)
    const firstQuestion = calls[0]?.questions['selection']
    assert.ok(firstQuestion?.type === 'choice')
    assert.equal(Object.keys(firstQuestion.criteria).length, 16)
    assert.equal(calls[1]!.state.filter((v) => typeof v !== 'string').length, 9)
    assert.equal(calls[2]!.state.filter((v) => typeof v !== 'string').length, 5)
    assert.equal(result.metadata.unknownCostCount, 3)
    if (result.status === 'located') {
      assert.equal(result.normalizedRegion.left, result.region.left / 320)
      assert.ok(result.region.width <= 256)
      assert.equal(result.method, 'three-choice-grid-v1')
    }
  } finally {
    await client.dispose()
  }
})
await test('global absence is one call, local absence does not claim global absence', async () => {
  let calls = 0
  const client = createClassifier({
    decision: {
      async decide(r) {
        calls++
        return reply(r, 0)
      },
    },
  })
  try {
    const result = await client.locate({ image, target: 'missing object' })
    assert.equal(result.status, 'not-found')
    assert.equal(calls, 1)
  } finally {
    await client.dispose()
  }
  let stage = 0
  const second = createClassifier({
    decision: {
      async decide(r) {
        stage++
        return reply(r, stage === 2 ? 0 : 1)
      },
    },
  })
  try {
    const result = await second.locate({ image, target: 'object' })
    assert.equal(result.status, 'unknown')
    assert.equal(stage, 2)
  } finally {
    await second.dispose()
  }
})
await test('none and presence contradiction remains unknown', async () => {
  let stage = 0
  const client = createClassifier({
    decision: {
      async decide(r) {
        stage++
        return reply(r, 1, stage === 3)
      },
    },
  })
  try {
    const result = await client.locate({ image, target: 'object' })
    assert.equal(result.status, 'unknown')
    if (result.status === 'unknown') assert.equal(result.reason, 'contradictory-evidence')
  } finally {
    await client.dispose()
  }
})
await test('0.5 independent presence abstains, not a categorical threshold', async () => {
  const client = createClassifier({
    decision: {
      async decide(r) {
        return reply(r, 0.5)
      },
    },
  })
  try {
    const result = await client.locate({ image, target: 'object' })
    assert.equal(result.status, 'unknown')
  } finally {
    await client.dispose()
  }
})
await test('ROI bounds checked before provider; tiny ROI reports layout limit', async () => {
  let calls = 0
  const client = createClassifier({
    decision: {
      async decide(r) {
        calls++
        return reply(r)
      },
    },
  })
  try {
    await assert.rejects(
      client.locate({ image, target: 'object', roi: { left: 310, top: 0, width: 20, height: 30 } }),
      { code: 'INVALID_INPUT' },
    )
    assert.equal(
      (
        await client.locate({
          image,
          target: 'object',
          roi: { left: 0, top: 0, width: 1, height: 1 },
        })
      ).status,
      'unknown',
    )
    assert.equal(calls, 0)
  } finally {
    await client.dispose()
  }
})
await test('candidate refinement is opt-in, bounded and never substitutes area', async () => {
  const client = createClassifier({
    decision: {
      async decide(r) {
        return reply(r)
      },
    },
    refinement: {
      async refine(input) {
        return { status: 'refined', region: input.region, method: 'fixture' }
      },
    },
  })
  try {
    const r = await client.locate({ image, target: 'object' })
    assert.equal(r.status, 'located')
    if (r.status === 'located') assert.equal(r.refinement?.status, 'refined')
  } finally {
    await client.dispose()
  }
  const bad = createClassifier({
    decision: {
      async decide(r) {
        return reply(r)
      },
    },
    refinement: {
      async refine() {
        return {
          status: 'refined',
          region: { left: 999, top: 999, width: 1, height: 1 },
          method: 'bad',
        }
      },
    },
  })
  try {
    await assert.rejects(bad.locate({ image, target: 'object' }), { code: 'INVALID_RESPONSE' })
  } finally {
    await bad.dispose()
  }
})
await test('source grids partition odd and narrow regions without edge gaps', () => {
  for (const width of [1, 2, 17, 319, 1001])
    for (const height of [1, 3, 19, 281]) {
      const roi = { left: 11, top: 7, width, height }
      const cells = uniformCoordinateCells(roi, 4, 4)
      assert.equal(
        cells.reduce((sum, c) => sum + c.region.width * c.region.height, 0),
        width * height,
      )
      assert.equal(Math.max(...cells.map((c) => c.region.left + c.region.width)), 11 + width)
      assert.equal(Math.max(...cells.map((c) => c.region.top + c.region.height)), 7 + height)
      for (const a of cells)
        for (const b of cells)
          if (a !== b)
            assert.ok(
              a.region.left + a.region.width <= b.region.left ||
                b.region.left + b.region.width <= a.region.left ||
                a.region.top + a.region.height <= b.region.top ||
                b.region.top + b.region.height <= a.region.top,
            )
    }
})
await test('beam keeps padded source geometry, canonical dedupe and at most196 cells', () => {
  const region = { left: 9, top: 4, width: 1001, height: 701 }
  const cells = choiceBeamFirstCells(region)
  const probabilities = Object.fromEntries(cells.map((c) => [c.id, 1 / cells.length]))
  const panels = choiceBeamPanels(region, cells, { choice: cells[0]!.id, probabilities }, 8)
  assert.equal(panels.length, 4)
  assert.ok(panels.reduce((n, p) => n + p.cells.length, 0) <= 196)
  for (const p of panels)
    for (const c of p.cells) {
      assert.ok(c.region.width <= 256 && c.region.height <= 256)
      assert.ok(c.region.left >= 9 && c.region.top >= 4)
    }
})
await test('presentation preserves aspect ratio with padding and stays in Jev limits', async () => {
  const raster = createSharpRaster(),
    signal = new AbortController().signal
  const bytes = await sharp({ create: { width: 2000, height: 50, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  const normalized = await raster.normalize(bytes, signal)
  const state = await raster.imageState(normalized, signal)
  const part = state[0]
  assert.ok(part && typeof part !== 'string')
  const metadata = await sharp(Buffer.from(part.image_url.url.split(',')[1]!, 'base64')).metadata()
  assert.equal(metadata.width, 1568)
  assert.equal(metadata.height, 280)
})
