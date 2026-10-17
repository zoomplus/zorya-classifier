# Zorya Classifier

[![npm version](https://img.shields.io/npm/v/zorya-classifier)](https://www.npmjs.com/package/zorya-classifier)

Provider-independent text/image classification and coarse-to-fine object localization for Node.js and TypeScript. MIT application code. **Native decision models are the primary integration**, with Luna Decisions as the main example; ordinary vision language models are also supported without a native classification API.

Use any image-capable instruction-following model through an OpenAI-compatible API, or implement the small `DecisionPort` for another protocol. OpenRouter is an optional adapter, not a mandatory service. Model compatibility and accuracy vary; see the exact [tested models/results](docs/vision-results.md), [acceptance](docs/acceptance.md), and historical [Jev baseline](docs/results.md).

[Русское руководство](docs/README.ru.md) · [API](docs/api.md) · [Architecture](docs/architecture.md) · [Benchmarks](docs/benchmarks.md)

## Install

Node.js 22.12+ is required. Source: [zoomplus/zorya-classifier](https://github.com/zoomplus/zorya-classifier). Package: [zorya-classifier](https://www.npmjs.com/package/zorya-classifier).

```sh
npm install zorya-classifier
```

The release archive also installs with `npm install ./zorya-classifier-0.1.0.tgz`. Runtime dependencies are Zod and Sharp; model weights, Electron, a database and background services are not included.

## Quickstart: Luna Decisions

This example uses the typed **Decisions API** with genuine Choice probabilities. Model and provider are explicit; there are no automatic retries or fallbacks. Jev is optional and is not used by this example.

```ts
import { createClassifier } from 'zorya-classifier'
import { createOpenRouterDecisions } from 'zorya-classifier/openrouter'

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) throw new Error('Set OPENROUTER_API_KEY')
const client = createClassifier({
  decision: createOpenRouterDecisions({
    apiKey,
    model: 'openai/gpt-6-luna-decisions',
    provider: 'openai',
  }),
})
try {
  const result = await client.classify({
    input: 'Where is my order?',
    classes: [
      { id: 'delivery', description: 'Delivery or tracking questions' },
      { id: 'other', description: 'All other requests' },
    ],
  })
  console.log(result.choice, result.probabilities)
} finally {
  await client.dispose()
}
```

For an image: `input: { image: await readFile('photo.jpg'), text: 'Which class fits?' }` with `readFile` from `node:fs/promises`. Define 2–255 distinct class IDs/descriptions and an explicit `none`/`other` class if needed. The API selects one class; it does not discover an unknown taxonomy or enumerate all objects.

Native Choices retain the provider distribution and select a maximum; ties use supplied class order. There is no universal0.8 cutoff across competing classes.

## Ordinary vision models are also supported

Use the same `createClassifier` with `createOpenRouterVision` from `zorya-classifier/openrouter`, for example `{ apiKey, model: 'openai/gpt-6-luna', provider: 'openai', reasoningEffort: 'none' }`. This adapter uses ordinary chat completions. Choose prompt/JSON-object/JSON-schema mode to match server support.

Ordinary chat models return a closed ranking, **not manufactured probabilities**. `choice` is its first ID, `ranking` contains the returned ordered IDs, and `probabilities` / `nativeChoice` are `null`. Invalid IDs, duplicates, missing answers, refusals, truncation and malformed JSON fail validation. A valid structured answer is still not proof of factual correctness. Classification/final selection request one ranked ID; spatial beam stages request four. These rank-only results remain distinct from native probability-valued results.

## Direct providers and local servers

There is no OpenRouter account requirement for this entry point:

```ts
import { createClassifier } from 'zorya-classifier'
import { createOpenAICompatibleVision } from 'zorya-classifier/openai-compatible'

const endpoint = process.env.VISION_CHAT_ENDPOINT
const model = process.env.VISION_MODEL
if (!endpoint || !model) throw new Error('Set your server endpoint and deployed model ID')
const apiKey = process.env.VISION_API_KEY
const client = createClassifier({
  decision: createOpenAICompatibleVision({
    endpoint,
    model,
    ...(apiKey ? { apiKey } : {}),
  }),
})
try {
  console.log(
    await client.classify({
      input: 'Please refund my purchase',
      classes: [
        { id: 'refund', description: 'A request for money back' },
        { id: 'other', description: 'All other messages' },
      ],
    }),
  )
} finally {
  await client.dispose()
}
```

Supply the **full trusted chat-completions URL**, such as your local `http://localhost:8000/v1/chat/completions`, and the actual deployed model ID. Anonymous local servers can omit the key; custom headers support other authentication. These are integration examples, not a claim that every provider/model has been live-qualified. Other wire protocols can implement the exported `DecisionPort`. Keep keys on a trusted server, outside frontend bundles and Git.

## Locate an object

With either configured client:

```ts
const result = await client.locate({
  image: await readFile('photo.jpg'),
  target: 'a red backpack on the chair',
})
if (result.status === 'located') console.log(result.region)
```

`region` uses EXIF-oriented source pixels. It is a selected grid cell containing a hypothesized object fragment, not a tight box, segmentation mask or object-center guarantee. `unknown` is distinct from absence; transport/protocol errors throw `ClassifierError`.

The locator uses up to three sequential calls: coarse 4×4 regions, fine grids in four padded regions, then four enlarged candidates. Coordinates come from code, never free-form model coordinates. Ordinary-model rankings select candidates; independent present/absent/unknown answers govern abstention. Multiple matching physical instances are allowed; one candidate is returned. Localization requires the model/endpoint to accept multiple images per call (up to nine); single-image-only endpoints can still support `classify`.

## Development and limits

```sh
npm ci --ignore-scripts
npm run prepare
npm run check
npm run pack:check
npm run format:check
```

CLI uses explicit `ZORYA_MODEL` and defaults to `ZORYA_MODE=decisions`. OpenRouter also requires `ZORYA_PROVIDER` and `OPENROUTER_API_KEY`. For ordinary models set `ZORYA_MODE=chat`; direct chat servers use `ZORYA_ENDPOINT` and an optional separate `ZORYA_API_KEY`. Run `zorya-classifier --help` for commands.

Tests are offline. Examples, CLI and explicitly authorized model benchmarks make paid calls. Default operation limits: 45-second absolute timeout, two active operations, sixteen waiters, bounded image/request/response sizes. Honor cancellation and call `dispose` on shutdown. The library has no import-time network request, hidden model switching or automatic retry.

A model must understand the input, follow instructions and produce the checked answer shape. JSON Schema/JSON-object modes are opt-in when the chosen endpoint supports them; prompt-only mode does not require structured-output support. No universal accuracy, calibration or sub-second guarantee is asserted. Optional segmentation/refinement is a caller-owned `RefinementPort`.

See [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), [NOTICE](NOTICE.md), and [LICENSE](LICENSE).
