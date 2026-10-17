#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { createClassifier } from './index.js'
import { createCliDecision } from './app/cli-route.js'

async function main() {
  const [command, value, target] = process.argv.slice(2)
  if (command === '--help' || !command) {
    console.log(
      'zorya-classifier classify-text <text> <classes.json>\nzorya-classifier classify-image <image> <classes.json>\nzorya-classifier locate <image> <target>\nSet ZORYA_MODEL. Default ZORYA_MODE=decisions; use chat for ordinary vision models/custom chat endpoints. OpenRouter: OPENROUTER_API_KEY + ZORYA_PROVIDER. Direct: ZORYA_ENDPOINT + optional ZORYA_API_KEY. Optional ZORYA_REASONING_EFFORT and ZORYA_RESPONSE_FORMAT. One classify request; up to three locate requests.',
    )
    return
  }
  if (!['classify-text', 'classify-image', 'locate'].includes(command) || !value || !target)
    throw new Error('Invalid arguments; use --help')
  const client = createClassifier({ decision: createCliDecision(process.env) })
  try {
    if (command === 'locate')
      console.log(
        JSON.stringify(await client.locate({ image: await readFile(value), target }), null, 2),
      )
    else {
      const { z } = await import('zod')
      const { classSchema } = await import('./entities/contracts.js')
      const unknownClasses: unknown = JSON.parse(await readFile(target, 'utf8'))
      const classes = z.array(classSchema).parse(unknownClasses)
      const input = command === 'classify-text' ? value : { image: await readFile(value) }
      console.log(JSON.stringify(await client.classify({ input, classes }), null, 2))
    }
  } finally {
    await client.dispose()
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Command failed')
  process.exitCode = 1
})
