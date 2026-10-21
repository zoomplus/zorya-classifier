import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { createSharpRaster } from '../src/infrastructure/raster.js'
import { locateInput } from '../src/processes/locate.js'
import { locateWithZoom, zoomTileRegions } from '../benchmarks/v03/zoom-locator.js'

const signal = () => new AbortController().signal
const metadata = {
  model: 'fixture-model',
  provider: 'fixture-provider',
  requestId: null,
  durationMs: 1,
  costUsd: 0.01,
  attempts: 1,
} as const

function answerFor(
  request: DecisionRequest,
  choiceForCall: number,
  mode: 'first' | 'tie' | 'none',
) {
  const isTileChoice = request.state.includes('FULL SOURCE AND OVERLAPPING CROP VIEWS')
  const answers = Object.fromEntries(
    Object.entries(request.questions).map(([key, question]) => {
      if (question.type === 'noul') return [key, { type: 'noul' as const, noul: 1 }]
      const choices = Object.keys(question.criteria)
      if (isTileChoice) {
        if (mode === 'none')
          return [
            key,
            {
              type: 'choice' as const,
              choice: 'none',
              probabilities: Object.fromEntries(
                choices.map((choice) => [choice, Number(choice === 'none')]),
              ),
            },
          ]
        if (mode === 'tie')
          return [
            key,
            {
              type: 'choice' as const,
              choice: 'C',
              probabilities: Object.fromEntries(
                choices.map((choice) => [choice, 1 / choices.length]),
              ),
            },
          ]
        const choice = 'A'
        return [
          key,
          {
            type: 'choice' as const,
            choice,
            probabilities: Object.fromEntries(
              choices.map((value) => [value, Number(value === choice)]),
            ),
          },
        ]
      }

      const choice =
        choiceForCall === 1 || choiceForCall === 2
          ? (choices.find((value) => value.startsWith('P') || value.startsWith('C')) ?? choices[0]!)
          : (choices.find((value) => /^[A-D]$/.test(value)) ?? choices[0]!)
      return [
        key,
        {
          type: 'choice' as const,
          choice,
          probabilities: Object.fromEntries(
            choices.map((value) => [value, Number(value === choice)]),
          ),
        },
      ]
    }),
  )
  return { answers, metadata } satisfies DecisionResult
}

function fixtureDecision(mode: 'first' | 'tie' | 'none' = 'first') {
  const requests: DecisionRequest[] = []
  const decision: DecisionPort = {
    async decide(request) {
      requests.push(request)
      return answerFor(request, requests.length, mode)
    },
  }
  return { decision, requests }
}

const imageBytes = await sharp({
  create: { width: 320, height: 280, channels: 3, background: { r: 32, g: 80, b: 120 } },
})
  .png()
  .toBuffer()

await test('zoom tiles overlap each seam and cover the full source and its edges', () => {
  const roi = { left: 11, top: 7, width: 101, height: 71 }
  const tiles = zoomTileRegions(roi)
  assert.equal(tiles.length, 4)
  assert.deepEqual(tiles[0], { left: 11, top: 7, width: 61, height: 43 })
  assert.deepEqual(tiles[1], { left: 51, top: 7, width: 61, height: 43 })
  assert.deepEqual(tiles[2], { left: 11, top: 35, width: 61, height: 43 })
  assert.deepEqual(tiles[3], { left: 51, top: 35, width: 61, height: 43 })
  for (let y = roi.top; y < roi.top + roi.height; y += 1)
    for (let x = roi.left; x < roi.left + roi.width; x += 1)
      assert.ok(
        tiles.some(
          (tile) =>
            x >= tile.left &&
            x < tile.left + tile.width &&
            y >= tile.top &&
            y < tile.top + tile.height,
        ),
      )
  assert.deepEqual(zoomTileRegions({ left: 0, top: 0, width: 2, height: 10 }), [])
})

await test('selected crop result maps through its known source offset and stays within ROI', async () => {
  const raster = createSharpRaster()
  const controller = new AbortController()
  const normalized = await raster.normalize(imageBytes, controller.signal)
  const tileRegion = zoomTileRegions({ left: 0, top: 0, width: 320, height: 280 })[0]!
  const tile = await raster.crop(normalized, tileRegion, controller.signal)
  const reference = fixtureDecision()
  const local = await locateInput(
    { image: tile.bytes, target: 'target' },
    reference.decision,
    raster,
    controller.signal,
  )
  assert.equal(local.status, 'located')

  const actual = fixtureDecision()
  const zoomed = await locateWithZoom(
    {
      image: imageBytes,
      target: 'target',
      roi: { left: 0, top: 0, width: 320, height: 280 },
      signal: signal(),
    },
    { decision: actual.decision },
  )
  assert.equal(zoomed.status, 'located')
  if (zoomed.status !== 'located' || local.status !== 'located') return
  assert.deepEqual(zoomed.tileRegion, tileRegion)
  assert.deepEqual(zoomed.sourceRegion, {
    left: tileRegion.left + local.region.left,
    top: tileRegion.top + local.region.top,
    width: local.region.width,
    height: local.region.height,
  })
  assert.equal(zoomed.selectedTile, 'A')
  assert.equal(actual.requests.length, 4)
  assert.equal(actual.requests[0]!.state.filter((part) => typeof part !== 'string').length, 5)
  assert.equal(zoomed.metadata.preparedViews.length, 5)
  assert.equal(zoomed.metadata.knownCostUsd, 0.04)
})

await test('tile-choice views enlarge 1024px source regions and record exact prepared scales', async () => {
  const largeImage = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: 'slategray' },
  })
    .png()
    .toBuffer()
  const fixture = fixtureDecision()
  const result = await locateWithZoom(
    { image: largeImage, target: 'target', signal: signal() },
    { decision: fixture.decision },
  )
  assert.equal(result.status, 'located')
  const expectedRegion = zoomTileRegions({ left: 0, top: 0, width: 1024, height: 1024 })[0]!
  const view = result.metadata.preparedViews.find((candidate) => candidate.id === 'tile-A')
  assert.ok(view)
  assert.deepEqual(view.sourceRegion, expectedRegion)
  assert.ok(view.scaleX > 1)
  assert.ok(view.scaleY > 1)
  assert.ok(view.content.width <= 1568)
  assert.ok(view.content.height <= 1568)
  assert.equal(view.scaleX, view.content.width / view.sourceRegion.width)
  assert.equal(view.scaleY, view.content.height / view.sourceRegion.height)
  assert.ok(
    Math.abs(
      view.content.width / view.content.height - expectedRegion.width / expectedRegion.height,
    ) < 0.01,
  )
})

await test('tile-choice ties use stable input order and none remains unknown', async () => {
  const tied = fixtureDecision('tie')
  const tieResult = await locateWithZoom(
    { image: imageBytes, target: 'target', signal: signal() },
    { decision: tied.decision },
  )
  assert.equal(tieResult.status, 'located')
  if (tieResult.status === 'located') assert.equal(tieResult.selectedTile, 'A')
  assert.equal(tied.requests.length, 4)

  const none = fixtureDecision('none')
  const noneResult = await locateWithZoom(
    { image: imageBytes, target: 'target', signal: signal() },
    { decision: none.decision },
  )
  assert.equal(noneResult.status, 'unknown')
  if (noneResult.status === 'unknown') assert.equal(noneResult.reason, 'none-selected')
  assert.equal(none.requests.length, 1)
})

await test('crop-local absence becomes unknown without retrying the baseline', async () => {
  let calls = 0
  const decision: DecisionPort = {
    async decide(request) {
      calls += 1
      const response = answerFor(request, calls, 'first')
      if (calls === 2) {
        const presenceAnswer = response.answers['presence']
        assert.ok(presenceAnswer?.type === 'noul')
        presenceAnswer.noul = 0
      }
      return response
    },
  }
  const result = await locateWithZoom(
    { image: imageBytes, target: 'target', signal: signal() },
    { decision },
  )
  assert.equal(result.status, 'unknown')
  if (result.status === 'unknown') assert.equal(result.reason, 'crop-not-found')
  assert.equal(calls, 2)
})

await test('cancellation after tile choice performs no crop-locator decision', async () => {
  const controller = new AbortController()
  let calls = 0
  const decision: DecisionPort = {
    async decide(request) {
      calls += 1
      const response = answerFor(request, calls, 'first')
      controller.abort()
      return response
    },
  }
  await assert.rejects(
    locateWithZoom(
      { image: imageBytes, target: 'target', signal: controller.signal },
      { decision },
    ),
    { code: 'ABORTED' },
  )
  assert.equal(calls, 1)
})

await test('input bytes are owned before the first asynchronous decision', async () => {
  const ownedBytes = new Uint8Array(imageBytes)
  let calls = 0
  const decision: DecisionPort = {
    async decide(request) {
      calls += 1
      const response = answerFor(request, calls, 'first')
      if (calls === 1) ownedBytes.fill(0)
      return response
    },
  }
  const result = await locateWithZoom(
    { image: ownedBytes, target: 'target', signal: signal() },
    { decision },
  )
  assert.equal(result.status, 'located')
  assert.equal(calls, 4)
})
