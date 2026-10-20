#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { z } from 'zod'

const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_SOURCE_PIXELS = 2_097_152
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
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

function readBoundedImageBytes(file) {
  const descriptor = openSync(file, 'r')
  try {
    const stat = fstatSync(descriptor)
    const size = stat.size
    assertCondition(
      stat.isFile() && Number.isSafeInteger(size) && size > 0 && size <= MAX_IMAGE_BYTES,
      'Input image byte size is invalid or exceeds the per-image cap',
    )
    const bytes = Buffer.allocUnsafe(size)
    try {
      let offset = 0
      while (offset < size) {
        const count = readSync(descriptor, bytes, offset, size - offset, offset)
        assertCondition(count > 0, 'Input image was truncated during bounded read')
        offset += count
      }
      return bytes
    } catch (error) {
      bytes.fill(0)
      throw error
    }
  } finally {
    closeSync(descriptor)
  }
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
  const inputBytes = readFileSync(inputs)
  const truthBytes = readFileSync(truth)
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
        row.image.height > 0 &&
        row.image.width * row.image.height <= MAX_SOURCE_PIXELS,
      'Input raster dimensions are invalid',
    )
    shaSchema.parse(row.image.sha256)
    inputById.set(row.caseId, row)
  }
  assertCondition(truthRows.length === inputRows.length, 'Truth/input case counts differ')
  const truthIds = new Set()
  let decoded = 0
  const resolvedRoot = realpathSync(imageRoot)
  for (const row of truthRows) {
    assertCondition(!truthIds.has(row.caseId), 'Truth case IDs are duplicated')
    truthIds.add(row.caseId)
    const input = inputById.get(row.caseId)
    assertCondition(input !== undefined, 'Truth case ID is absent from input manifest')
    for (const box of row.targetBoxes) {
      const right = box.xyxy[2]
      const bottom = box.xyxy[3]
      assertCondition(
        right * input.image.width <= input.image.width + 1e-8 &&
          bottom * input.image.height <= input.image.height + 1e-8,
        'Normalized box escapes source dimensions',
      )
    }
    const imagePath = path.resolve(resolvedRoot, input.image.path)
    const relative = path.relative(resolvedRoot, imagePath)
    assertCondition(
      relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      'Input image path escapes image root',
    )
    const actualPath = realpathSync(imagePath)
    const actualRelative = path.relative(resolvedRoot, actualPath)
    assertCondition(
      actualRelative !== '..' &&
        !actualRelative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(actualRelative),
      'Input image resolves outside image root',
    )
    const imageBytes = readBoundedImageBytes(actualPath)
    let decoder
    let decodedRaster
    try {
      assertCondition(hash(imageBytes) === input.image.sha256, 'Input image digest differs')
      decoder = sharp(imageBytes, {
        failOn: 'error',
        limitInputPixels: MAX_SOURCE_PIXELS,
        sequentialRead: true,
      })
      decodedRaster = await decoder.raw().toBuffer({ resolveWithObject: true })
      assertCondition(
        decodedRaster.info.width === input.image.width &&
          decodedRaster.info.height === input.image.height &&
          decodedRaster.info.width * decodedRaster.info.height <= MAX_SOURCE_PIXELS &&
          Number.isSafeInteger(decodedRaster.info.channels) &&
          decodedRaster.info.channels >= 1 &&
          decodedRaster.info.channels <= 4 &&
          decodedRaster.data.byteLength ===
            decodedRaster.info.width * decodedRaster.info.height * decodedRaster.info.channels,
        'Fully decoded input image dimensions differ',
      )
      decoded++
    } finally {
      decoder?.destroy()
      imageBytes.fill(0)
      decodedRaster?.data.fill(0)
    }
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

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  validateEvaluatorTruth(parseOptions(process.argv.slice(2)))
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    })
}

export { truthSchema, validateEvaluatorTruth }
