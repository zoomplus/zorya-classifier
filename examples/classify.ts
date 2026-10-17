import { createClassifier } from 'zorya-classifier'
import { createOpenRouterDecisions } from 'zorya-classifier/openrouter'
const apiKey = process.env['OPENROUTER_API_KEY']
const model = process.env['ZORYA_MODEL'],
  provider = process.env['ZORYA_PROVIDER']
if (!apiKey || !model || !provider)
  throw new Error('Set OPENROUTER_API_KEY, ZORYA_MODEL and ZORYA_PROVIDER')
const client = createClassifier({
  decision: createOpenRouterDecisions({ apiKey, model, provider }),
})
try {
  console.log(
    await client.classify({
      input: 'Where is my order?',
      classes: [
        { id: 'delivery', description: 'Questions about delivery or tracking' },
        { id: 'other', description: 'All other requests' },
      ],
    }),
  )
} finally {
  await client.dispose()
}
