import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { createResearchClassifier } from '../src/app/create-classifier.js'
import { createSharpBoundaryView } from '../src/infrastructure/boundary-view.js'
import { recordProvider } from '../benchmarks/v02/recording.js'
import { RunBudget } from '../benchmarks/v02/budget.js'
import { withSeedUnboundedPrompt } from '../benchmarks/v02/seedunboundedprompt.js'
import { withSeedOutlinePresentation } from '../benchmarks/v02/seedoutlinepresentation.js'

await test('outline presentation replaces SEED crop on a real whole-object extent request and traces source geometry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v02-seed-outline-trace-'))
  const providerRequests: DecisionRequest[] = []
  const decision: DecisionPort = {
    async decide(request) {
      providerRequests.push(request)
      const answers: DecisionResult['answers'] = {}
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type === 'noul') {
          answers[id] = { type: 'noul', noul: 0.99 }
          continue
        }
        const options = Object.keys(question.criteria)
        const choice =
          id === 'instance'
            ? 'same'
            : id === 'left'
              ? options[0]!
              : id === 'right' || id === 'top' || id === 'bottom'
                ? options.at(-2)!
                : options[0]!
        answers[id] = {
          type: 'choice',
          choice,
          probabilities: Object.fromEntries(
            options.map((option) => [option, option === choice ? 1 : 0]),
          ),
        }
      }
      return {
        answers,
        metadata: {
          model: 'fixture',
          provider: 'fixture',
          requestId: null,
          durationMs: 1,
          costUsd: 0,
          attempts: 1,
        },
      }
    },
  }
  try {
    const recorder = recordProvider(() => decision, new RunBudget(8, 1), directory, {
      model: 'fixture',
      provider: 'fixture',
      providerName: 'fixture',
      apiEndpoint: '/fixture',
      allowFallbacks: false,
    })
    const classifier = createResearchClassifier(
      {
        decision: withSeedUnboundedPrompt(withSeedOutlinePresentation(recorder.port)),
        timeoutMs: 10000,
        concurrency: 1,
        maxQueue: 0,
      },
      undefined,
      createSharpBoundaryView(),
    )
    try {
      await classifier.locate({
        image: new Uint8Array(
          await sharp({ create: { width: 400, height: 300, channels: 3, background: '#777777' } })
            .png()
            .toBuffer(),
        ),
        target: 'fixture target',
        mode: 'whole-object',
        boxTolerancePx: 8,
        maxExtentPasses: 1,
      })
    } finally {
      await classifier.dispose()
    }
    const extent = providerRequests.find((request) => Object.hasOwn(request.questions, 'left'))
    assert.ok(extent)
    const markers = extent.state.filter((part) => typeof part === 'string')
    assert.ok(markers.includes('ORIGINAL WITH SEED CROP OUTLINE (INTERIOR WITNESS ONLY)'))
    assert.equal(markers.includes('SEED'), false)
    const imageParts = extent.state.filter((part) => typeof part !== 'string')
    assert.equal(imageParts.length, 3)
    const outlinePart = imageParts[0]!
    const outlineBytes = Buffer.from(
      outlinePart.image_url.url.slice('data:image/png;base64,'.length),
      'base64',
    )
    const outlineState = extent.state.find(
      (part): part is string => typeof part === 'string' && part.includes('seedOutlineView'),
    )
    assert.ok(outlineState)
    const outlineGeometry = JSON.parse(outlineState) as {
      seedOutlineView: {
        content: { left: number; top: number }
        scaleX: number
        scaleY: number
        seedRegion: { left: number; top: number }
      }
    }
    const pixels = await sharp(outlineBytes).raw().toBuffer({ resolveWithObject: true })
    const x = Math.floor(
      outlineGeometry.seedOutlineView.content.left +
        outlineGeometry.seedOutlineView.seedRegion.left * outlineGeometry.seedOutlineView.scaleX,
    )
    const y = Math.floor(
      outlineGeometry.seedOutlineView.content.top +
        outlineGeometry.seedOutlineView.seedRegion.top * outlineGeometry.seedOutlineView.scaleY,
    )
    const cyanStroke = Array.from({ length: 5 }, (_, offset) => {
      const sampleY = Math.max(0, y - 2 + offset)
      const offsetByte = (sampleY * pixels.info.width + x) * pixels.info.channels
      return (
        pixels.data[offsetByte]! < 80 &&
        pixels.data[offsetByte + 1]! > 180 &&
        pixels.data[offsetByte + 2]! > 180
      )
    }).some(Boolean)
    assert.equal(cyanStroke, true)

    const extentCall = recorder.logicalCalls.find((call) =>
      call.request.questions.some((question) => question.id === 'left'),
    )
    assert.ok(extentCall)
    const trace = JSON.parse(
      await readFile(join(directory, `decision-trace-${extentCall.logicalId}.json`), 'utf8'),
    ) as {
      status: string
      geometry: {
        seedRegion: unknown
        currentBounds: unknown
        imageTransforms: { role: string; sourceRegion: unknown }[]
        boundaryViews: unknown[]
      }
    }
    assert.equal(trace.status, 'recorded')
    assert.ok(trace.geometry.seedRegion)
    assert.ok(trace.geometry.currentBounds)
    assert.equal(trace.geometry.boundaryViews.length, 2)
    const outlineTransform = trace.geometry.imageTransforms.find(
      (transform) => transform.role === 'seed-outline',
    )
    assert.ok(outlineTransform)
    assert.ok(outlineTransform.sourceRegion)
    const traceText = JSON.stringify(trace)
    assert.doesNotMatch(traceText, /data:image|fixture target|ORIGINAL WITH SEED/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
