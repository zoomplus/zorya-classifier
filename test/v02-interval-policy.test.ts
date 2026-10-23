import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { createClassifier } from '../src/app/create-classifier.js'
import { createResearchClassifier } from '../benchmarks/experiments/create-research-classifier.js'
import {
  intervalPolicyPilotPolicy,
  intervalPolicyVariants,
} from '../benchmarks/v02/intervalpolicy-pilot.js'
import { parseIntervalPolicyPilotArgs } from '../benchmarks/v02/run-interval-policy-pilot.js'

await test('paired interval-policy experiment freezes only named variants and unchanged localization gates', () => {
  assert.deepEqual(intervalPolicyVariants, [
    { id: 'seed-outline-fixed-16-v1', intervalPolicy: 'fixed-16-v1' },
    { id: 'seed-outline-tolerance-aware-v1', intervalPolicy: 'tolerance-aware-v1' },
  ])
  assert.equal(intervalPolicyPilotPolicy.tolerancePx, 8)
  assert.equal(intervalPolicyPilotPolicy.maxExtentPasses, 3)
  assert.equal(intervalPolicyPilotPolicy.timeoutMs, 45000)
  assert.equal(intervalPolicyPilotPolicy.retries, 0)
  assert.equal(intervalPolicyPilotPolicy.fallback, false)
  assert.equal(intervalPolicyPilotPolicy.maxPhysicalCalls, 64)
  assert.equal(intervalPolicyPilotPolicy.maxCostUsd, 2)
  assert.equal(intervalPolicyPilotPolicy.latencyRankingEligible, false)
})

await test('paired interval-policy CLI requires explicit paid-run intent and fixes selected variants', () => {
  assert.throws(() => parseIntervalPolicyPilotArgs([]), /explicit --allow-paid/u)
  const args = parseIntervalPolicyPilotArgs(['--allow-paid', '--image-root', './benchmarks/corpus'])
  assert.equal(args.imageRoot, resolve('./benchmarks/corpus'))
})

await test('research factory opt-in changes only the interval partition policy', async () => {
  const image = await sharp({
    create: { width: 1024, height: 43, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer()

  async function firstExtentCounts(
    makeClassifier: (decision: DecisionPort) => ReturnType<typeof createClassifier>,
  ) {
    let counts: number[] | undefined
    const decision: DecisionPort = {
      async decide(request: DecisionRequest) {
        if (['left', 'right', 'top', 'bottom'].every((id) => id in request.questions)) {
          counts = ['left', 'right', 'top', 'bottom'].map((id) => {
            const question = request.questions[id]
            assert.ok(question?.type === 'choice')
            return Object.keys(question.criteria).filter((key) => key !== 'unknown').length
          })
        }
        const metadata = {
          model: 'fixture',
          provider: 'fixture',
          requestId: null,
          durationMs: 0,
          costUsd: 0,
          attempts: 1,
        }
        const result: DecisionResult = {
          metadata,
          answers: Object.fromEntries(
            Object.entries(request.questions).map(([id, question]) => {
              if (question.type === 'noul')
                return [id, { type: 'presence' as const, presence: 'present' as const }]
              return [
                id,
                {
                  type: 'ranked-choice' as const,
                  ranking: Object.keys(question.criteria).slice(0, question.rankingSize ?? 4),
                },
              ]
            }),
          ),
        }
        return result
      },
    }
    const classifier = makeClassifier(decision)
    try {
      await classifier.locate({
        image,
        target: 'fixture object',
        mode: 'whole-object',
        boxTolerancePx: 8,
        maxExtentPasses: 1,
      })
    } finally {
      await classifier.dispose()
    }
    assert.ok(counts)
    return counts
  }

  const baseline = await firstExtentCounts((decision) => createClassifier({ decision }))
  const adaptive = await firstExtentCounts((decision) =>
    createResearchClassifier({ decision }, undefined, undefined, 'tolerance-aware-v1'),
  )
  assert.deepEqual(baseline, [16, 16, 16, 16])
  assert.deepEqual(adaptive, [16, 16, 6, 6])
})
