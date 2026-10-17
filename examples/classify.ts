import { createClassifier } from 'zorya-classifier'
import { createOpenRouterJev } from 'zorya-classifier/openrouter'
const apiKey = process.env['OPENROUTER_API_KEY']
if (!apiKey) throw new Error('Set OPENROUTER_API_KEY')
const client = createClassifier({ decision: createOpenRouterJev({ apiKey }) })
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
