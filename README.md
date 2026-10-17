# Zorya Classifier

Typed text/image classification and coarse-to-fine object localization for Node.js, powered by **Jev 1.14**. MIT licensed application code. Jev is a remote model, requires your own OpenRouter key, and is billed by its provider. No model weights are included.

**Status:** standalone 0.1.0 preview prepared for publication; see [acceptance](docs/acceptance.md) for executed checks and real-provider results. This is not a claim of universal detection accuracy or superiority to Jev. `classify` uses Jev's native Choice; `locate` composes three Choices with source-pixel geometry.

[Русское руководство](docs/README.ru.md) · [API](docs/api.md) · [Architecture](docs/architecture.md) · [Benchmarks](docs/benchmarks.md) · [Measured results](docs/results.md)

## Install from the prepared archive

Node.js 22.12+ is required. The repository is prepared for npm publication; do not assume the package has already been published.

```sh
npm install ./zorya-classifier-0.1.0.tgz
```

There are two runtime dependencies: Zod and Sharp. Sharp installs its platform-specific prebuilt native dependency through npm. No Electron, database, game assets, OpenCV, ONNX weights or background service is required.

## Classify text, an image, or both

```ts
import { createClassifier } from 'zorya-classifier'
import { createOpenRouterJev } from 'zorya-classifier/openrouter'

const client = createClassifier({
  decision: createOpenRouterJev({ apiKey: process.env.OPENROUTER_API_KEY! }),
})
try {
  const answer = await client.classify({
    input: 'Where is my order?',
    classes: [
      { id: 'delivery', description: 'Delivery or tracking questions' },
      { id: 'other', description: 'All other requests' },
    ],
  })
  console.log(answer.choice, answer.probabilities)
} finally {
  await client.dispose()
}
```

For an image, use `input: { image: await readFile('photo.jpg'), text: 'Which class fits?' }`. Provide mutually exclusive class definitions. The API chooses one class; it does not discover unknown classes or enumerate every object. Define an explicit `none`/`other` class when needed.

## Locate an object

```ts
import { readFile } from 'node:fs/promises'
import { createClassifier } from 'zorya-classifier'
import { createOpenRouterJev } from 'zorya-classifier/openrouter'

const client = createClassifier({
  decision: createOpenRouterJev({ apiKey: process.env.OPENROUTER_API_KEY! }),
})
try {
  const result = await client.locate({
    image: await readFile('photo.jpg'),
    target: 'a red backpack on the chair',
  })
  if (result.status === 'located') {
    console.log(result.region) // { left, top, width, height } in oriented source pixels
  }
} finally {
  await client.dispose()
}
```

A located region is a **selected grid cell containing a hypothesized object fragment**, not a tight bounding box, segmentation mask, center or identity guarantee. Multiple matching instances are allowed; one is selected. `unknown` is distinct from absence and transport errors throw `ClassifierError`.

The default locator makes up to three sequential remote requests: a coarse 4×4 grid, fine grids within four padded regions, then enlarged candidates A–D/none. Presence checks share each request; they are not separate network calls. Exact ties use stable input order, without a universal probability threshold.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run pack:check
npm run format:check
```

Tests are offline by default. Running examples/CLI with a key makes paid provider requests. Photographs and real benchmark requests are opt-in; see [benchmark instructions](docs/benchmarks.md). Credentials and image data are never logged by the library. Keep API keys in your server environment, never browser code.

## Limits

Jev image support is experimental. The adapter pins `typesafe/jev-1.14` to TypeSafe without provider/model fallback. No automatic retries are made. Images are decoded with bounded pixel counts, oriented, converted to presentation copies within the provider's supported dimensions, and mapped to source coordinates. Classification normally uses one request; localization has no sub-second guarantee.

Optional refinement is an injected `RefinementPort`; no heavy segmentation model is bundled. Platform-specific CI is configured for Windows/Linux; executed evidence is listed separately from configured jobs.

See [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), [NOTICE](NOTICE.md), and [LICENSE](LICENSE).
