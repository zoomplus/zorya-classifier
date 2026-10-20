#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { z } = require('zod')
const sharp = require('sharp')

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const xyxySchema = z
  .tuple([
    z.number().finite().min(0).max(1),
    z.number().finite().min(0).max(1),
    z.number().finite().min(0).max(1),
    z.number().finite().min(0).max(1),
  ])
  .refine(([left, top, right, bottom]) => left < right && top < bottom)
const truthSchema = z
  .array(
    z
      .object({
        caseId: z.string().min(1),
        expectedPresence: z.enum(['present', 'absent']),
        targetBoxes: z.array(z.object({ xyxy: xyxySchema }).passthrough()).max(10000),
        negativeEvidence: z
          .union([
            z.record(z.unknown()),
            z
              .string()
              .min(1)
              .max(4000)
              .refine((value) => value.trim().length > 0),
          ])
          .nullable(),
      })
      .passthrough()
      .superRefine((row, context) => {
        if (
          row.expectedPresence === 'present'
            ? row.targetBoxes.length === 0
            : row.targetBoxes.length !== 0 ||
              row.negativeEvidence === null ||
              (typeof row.negativeEvidence === 'string'
                ? !row.negativeEvidence.trim()
                : Object.keys(row.negativeEvidence).length === 0)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Missing independent positive/negative evidence',
          })
        }
      }),
  )
  .min(1)
  .max(120)

function assertCondition(condition, message) {
  if (!condition) throw new Error(message)
}

function parseOptions(argv) {
  const output = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    const outputKey = key === '--image-root' ? 'imageRoot' : key?.slice(2)
    if (!['--inputs', '--truth', '--image-root'].includes(key) || !value || output[outputKey])
      throw new Error('Expected unique --inputs, --truth, and --image-root arguments')
    output[outputKey] = value
  }
  assertCondition(Object.keys(output).length === 3, 'All three validation paths are required')
  return output
}

async function validateEvaluatorTruth({ inputs, truth, imageRoot }) {
  const inputBytes = fs.readFileSync(inputs)
  const truthBytes = fs.readFileSync(truth)
  const inputRows = JSON.parse(inputBytes.toString('utf8'))
  const truthRows = truthSchema.parse(JSON.parse(truthBytes.toString('utf8')))
  assertCondition(
    Array.isArray(inputRows) && inputRows.length > 0,
    'Input manifest must be a nonempty array',
  )
  const inputById = new Map()
  for (const row of inputRows) {
    assertCondition(
      typeof row.caseId === 'string' && row.caseId.length > 0,
      'Input case ID is invalid',
    )
    assertCondition(!inputById.has(row.caseId), 'Input case IDs are duplicated')
    assertCondition(
      Number.isSafeInteger(row.image?.width) &&
        row.image.width > 0 &&
        Number.isSafeInteger(row.image?.height) &&
        row.image.height > 0,
      'Input raster dimensions are invalid',
    )
    inputById.set(row.caseId, row)
  }
  assertCondition(truthRows.length === inputRows.length, 'Truth/input case counts differ')
  const truthIds = new Set()
  let decoded = 0
  for (const row of truthRows) {
    assertCondition(!truthIds.has(row.caseId), 'Truth case IDs are duplicated')
    truthIds.add(row.caseId)
    const input = inputById.get(row.caseId)
    assertCondition(input !== undefined, 'Truth case ID is absent from input manifest')
    for (const box of row.targetBoxes) {
      const [left, top, right, bottom] = box.xyxy
      assertCondition(
        right * input.image.width <= input.image.width + 1e-8 &&
          bottom * input.image.height <= input.image.height + 1e-8,
        'Normalized box escapes source dimensions',
      )
    }
    const resolvedRoot = fs.realpathSync(imageRoot)
    const imagePath = path.resolve(resolvedRoot, input.image.path)
    const relative = path.relative(resolvedRoot, imagePath)
    assertCondition(
      relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      'Input image path escapes image root',
    )
    const actualPath = fs.realpathSync(imagePath)
    const actualRelative = path.relative(resolvedRoot, actualPath)
    assertCondition(
      actualRelative !== '..' &&
        !actualRelative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(actualRelative),
      'Input image resolves outside image root',
    )
    assertCondition(
      hash(fs.readFileSync(actualPath)) === input.image.sha256,
      'Input image digest differs',
    )
    const metadata = await sharp(actualPath, { failOn: 'error' }).metadata()
    assertCondition(
      metadata.width === input.image.width && metadata.height === input.image.height,
      'Decoded input image dimensions differ',
    )
    decoded++
  }
  const present = truthRows.filter((row) => row.expectedPresence === 'present').length
  const absent = truthRows.length - present
  return {
    status: 'valid',
    caseCount: truthRows.length,
    present,
    absent,
    decodedImageCount: decoded,
    inputsSha256: hash(inputBytes),
    truthSha256: hash(truthBytes),
  }
}

if (require.main === module) {
  validateEvaluatorTruth(parseOptions(process.argv.slice(2)))
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    })
}

module.exports = { truthSchema, validateEvaluatorTruth }
