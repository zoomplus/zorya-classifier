'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const { truthSchema, validateEvaluatorTruth } = require('./validate_evaluator_truth.cjs')

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

test('truth schema accepts positive and verified negative rows', () => {
  const parsed = truthSchema.parse([
    {
      caseId: 'case-positive',
      expectedPresence: 'present',
      targetBoxes: [{ xyxy: [0.1, 0.2, 0.7, 0.8] }],
      negativeEvidence: null,
    },
    {
      caseId: 'case-negative',
      expectedPresence: 'absent',
      targetBoxes: [],
      negativeEvidence: 'complete scoped source inventory',
    },
  ])
  assert.equal(parsed.length, 2)
})

test('truth schema rejects degenerate and out-of-range normalized geometry', () => {
  assert.throws(() =>
    truthSchema.parse([
      {
        caseId: 'bad-box',
        expectedPresence: 'present',
        targetBoxes: [{ xyxy: [0.1, 0.2, 1.1, 0.8] }],
        negativeEvidence: null,
      },
    ]),
  )
  assert.throws(() =>
    truthSchema.parse([
      {
        caseId: 'zero-area',
        expectedPresence: 'present',
        targetBoxes: [{ xyxy: [0.5, 0.2, 0.5, 0.8] }],
        negativeEvidence: null,
      },
    ]),
  )
})

test('dataset validation binds truth IDs, declared dimensions, pixels, and box extents', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'controlled-truth-'))
  t.after(async () => fs.rm(root, { recursive: true, force: true }))
  const imageRoot = path.join(root, 'images')
  await fs.mkdir(imageRoot)
  const imageBytes = await sharp({
    create: { width: 12, height: 8, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer()
  await fs.writeFile(path.join(imageRoot, 'image.png'), imageBytes)
  const inputs = [
    {
      caseId: 'fixture-1',
      image: { path: 'image.png', sha256: digest(imageBytes), width: 12, height: 8 },
    },
  ]
  const truth = [
    {
      caseId: 'fixture-1',
      expectedPresence: 'present',
      targetBoxes: [{ xyxy: [0.1, 0.1, 0.9, 0.9] }],
      negativeEvidence: null,
    },
  ]
  const inputPath = path.join(root, 'inputs.json')
  const truthPath = path.join(root, 'truth.json')
  await fs.writeFile(inputPath, JSON.stringify(inputs))
  await fs.writeFile(truthPath, JSON.stringify(truth))
  const valid = await validateEvaluatorTruth({ inputs: inputPath, truth: truthPath, imageRoot })
  assert.equal(valid.status, 'valid')
  assert.equal(valid.decodedImageCount, 1)
  const wrongDimensions = [{ ...inputs[0], image: { ...inputs[0].image, width: 13 } }]
  await fs.writeFile(inputPath, JSON.stringify(wrongDimensions))
  await assert.rejects(
    validateEvaluatorTruth({ inputs: inputPath, truth: truthPath, imageRoot }),
    /box escapes source dimensions|Decoded input image dimensions differ/u,
  )
})
