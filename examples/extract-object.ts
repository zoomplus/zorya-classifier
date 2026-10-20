import { readFile, writeFile } from 'node:fs/promises'
import { createClassifier, type Classifier } from 'zorya-classifier'
import { createOpenRouterDecisions } from 'zorya-classifier/openrouter'
import { createMobileSamSegmenter } from 'zorya-classifier/segmentation'

const [path, target, output] = process.argv.slice(2)
const apiKey = process.env['OPENROUTER_API_KEY']
const model = process.env['ZORYA_MODEL']
const provider = process.env['ZORYA_PROVIDER']
const encoderPath = process.env['MOBILE_SAM_ENCODER']
const decoderPath = process.env['MOBILE_SAM_DECODER']
if (!apiKey || !model || !provider || !encoderPath || !decoderPath || !path || !target || !output)
  throw new Error(
    'Configure credentials, explicit model/provider and pinned MOBILE_SAM_ENCODER/MOBILE_SAM_DECODER paths; supply image, target and a new output PNG path',
  )

const decision = createOpenRouterDecisions({ apiKey, model, provider })
const segmenter = await createMobileSamSegmenter({
  encoderPath,
  decoderPath,
  executionProvider: 'cpu',
  threads: 1,
})
let client: Classifier | undefined
try {
  client = createClassifier({ decision, segmentation: segmenter })
  const result = await client.extract({ image: await readFile(path), target })
  if (result.status === 'extracted') {
    await writeFile(output, result.png, { flag: 'wx' })
    console.log(
      JSON.stringify({
        status: result.status,
        region: result.region,
        center: result.center,
        offset: result.offset,
        mask: {
          width: result.mask.width,
          height: result.mask.height,
          format: result.mask.format,
        },
      }),
    )
  } else console.log(JSON.stringify({ status: result.status, reason: result.reason }))
} finally {
  try {
    await client?.dispose()
  } finally {
    await segmenter.dispose()
  }
}
