import { readFile } from 'node:fs/promises'
import { createClassifier } from 'zorya-classifier'
import { createOpenRouterJev } from 'zorya-classifier/openrouter'
const [path, target] = process.argv.slice(2)
const apiKey = process.env['OPENROUTER_API_KEY']
if (!apiKey || !path || !target)
  throw new Error('Set OPENROUTER_API_KEY and supply image path and target description')
const client = createClassifier({ decision: createOpenRouterJev({ apiKey }) })
try {
  console.log(await client.locate({ image: await readFile(path), target }))
} finally {
  await client.dispose()
}
