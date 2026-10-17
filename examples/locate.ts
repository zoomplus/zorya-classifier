import { readFile } from 'node:fs/promises'
import { createClassifier } from 'zorya-classifier'
import { createOpenRouterDecisions } from 'zorya-classifier/openrouter'
const [path, target] = process.argv.slice(2)
const apiKey = process.env['OPENROUTER_API_KEY']
const model = process.env['ZORYA_MODEL'],
  provider = process.env['ZORYA_PROVIDER']
if (!apiKey || !model || !provider || !path || !target)
  throw new Error(
    'Set OPENROUTER_API_KEY, ZORYA_MODEL, ZORYA_PROVIDER and supply image path and target description',
  )
const client = createClassifier({
  decision: createOpenRouterDecisions({ apiKey, model, provider }),
})
try {
  console.log(await client.locate({ image: await readFile(path), target }))
} finally {
  await client.dispose()
}
