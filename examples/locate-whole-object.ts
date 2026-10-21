/** Experimental: whole-object locate with caller segmentation is unqualified for general use. */
import { readFile } from 'node:fs/promises'
import { createClassifier, type Classifier } from 'zorya-classifier'
import { createOpenRouterDecisions } from 'zorya-classifier/openrouter'
import { createMobileSamSegmenter } from 'zorya-classifier/segmentation'

const [path, target] = process.argv.slice(2)
const apiKey = process.env['OPENROUTER_API_KEY']
const model = process.env['ZORYA_MODEL']
const provider = process.env['ZORYA_PROVIDER']
const encoderPath = process.env['MOBILE_SAM_ENCODER']
const decoderPath = process.env['MOBILE_SAM_DECODER']
if (!apiKey || !model || !provider || !encoderPath || !decoderPath || !path || !target)
  throw new Error(
    'Set model/provider, pinned MobileSAM asset paths, and supply image path and target description',
  )

const segmenter = await createMobileSamSegmenter({
  encoderPath,
  decoderPath,
  executionProvider: 'cpu',
  threads: 2,
})
let client: Classifier | undefined
try {
  client = createClassifier({
    decision: createOpenRouterDecisions({ apiKey, model, provider }),
    segmentation: segmenter,
  })
  const result = await client.locate({
    image: await readFile(path),
    target,
    mode: 'whole-object',
  })
  if (result.status === 'located')
    console.log(JSON.stringify({ region: result.region, center: result.center }, null, 2))
  else console.log(JSON.stringify({ status: result.status, reason: result.reason }, null, 2))
} finally {
  try {
    await client?.dispose()
  } finally {
    await segmenter.dispose()
  }
}
