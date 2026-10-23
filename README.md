# Zorya Classifier

[![npm version](https://img.shields.io/npm/v/zorya-classifier)](https://www.npmjs.com/package/zorya-classifier)

Provider-independent text/image classification for Node.js and TypeScript, with experimental, unqualified spatial localization and object extraction. MIT application code. The library never selects or connects a model for you: create a client with an explicit `DecisionPort`, either injected by your application or built with an adapter you configure. The model and provider shown in examples are examples, not defaults. Ordinary vision language models and native decision APIs are both supported for closed classification.

Use an explicitly configured image-capable model through a supported adapter, or implement the small `DecisionPort` for another protocol. OpenRouter is an optional adapter, not a mandatory service. A more capable model may help on a task, but model strength does not guarantee a monotonic accuracy improvement. Compatibility and quality vary; see the exact [tested models/results](docs/vision-results.md), [acceptance](docs/acceptance.md), and historical [Jev baseline](docs/results.md).

[Русское руководство](docs/README.ru.md) · [API](docs/api.md) · [Architecture](docs/architecture.md) · [Архитектура (RU)](docs/architecture.ru.md) · [Разработка (RU)](docs/development.ru.md) · [Benchmarks](docs/benchmarks.md)

Version 0.2 adds region-seeded segmentation, mask-derived bounds and optional transparent cutouts, with a closed completeness check and one bounded mask expansion. See the [usage guide](docs/v02-usage.md) for contracts, backend ownership and CLI.

The [frozen 80-case evaluation](docs/evidence/v02/region-seeded-heldout-v3/README.md) passed its predeclared admission criteria, but localization remains limited: 26/60 positive seed hits and 8/60 complete object boxes; no false seeds or cutouts on 20 negatives. Eight of 30 reference masks reached IoU 0.8, three failed and 19 had no predicted mask. These results describe one explicit caller-configured Luna/OpenAI + MobileSAM recipe, not every model or game.

Six experimental encodings for text-only models were also tested on fresh photos and real UI captures. None qualified for image localization; see the [measured comparison](docs/evidence/v02/fresh-text/README.md). They remain research code rather than an advertised replacement for a vision model.

## Install

Node.js 22.12+ is required. Source: [zoomplus/zorya-classifier](https://github.com/zoomplus/zorya-classifier). Package: [zorya-classifier](https://www.npmjs.com/package/zorya-classifier).

```sh
npm install zorya-classifier
```

The release archive also installs with `npm install ./zorya-classifier-0.2.0.tgz` (filename follows `package.json` version; not a claim of a newly published release). Runtime dependencies are Zod and Sharp; model weights, Electron, a database and background services are not included. Optional local segmentation backends and their model assets are a separate responsibility of the caller; the library does not download or choose them.

## Capability and status

Further accuracy experiments on spatial workflows are stopped; no localization, extraction, or proposal strategy is promoted for general use. Historical metrics below and in `docs/evidence/**` are preserved as recorded.

| Capability                                                      | Status       | Notes                                                                 |
| --------------------------------------------------------------- | ------------ | --------------------------------------------------------------------- |
| `classify` with an explicit `DecisionPort` / supported adapters | Supported    | Closed class ID; no universal model accuracy claim                    |
| Default `locate` (region grid search)                           | Experimental | Hypothesized grid cell, not whole-object geometry or proof of absence |
| `RefinementPort`                                                | Experimental | No general quality qualification                                      |
| `locate({ mode: 'whole-object' })`                              | Experimental | Interval or segmentation paths; unqualified                           |
| `extract`, `SegmentationPort`, box-check composition            | Experimental | Structural checks ≠ semantic object or mask quality                   |
| `objectProposals` / native segmentation factories               | Experimental | Caller-owned; unqualified                                             |
| `representation: { type: 'experimental-text', … }`              | Rejected     | `UNSUPPORTED` until a profile qualifies                               |

Heldout region-seeded metrics (one documented recipe, not universal): 26/60 positive coarse seed hits; 8/60 complete whole-object boxes; 0 false seeds on 20 negatives. Among 30 exact-canvas masks: 8 reached IoU 0.8, 3 failed, 19 had no predicted mask. H8 DEV reported 7/9 positives with 2/3 false outputs and did not qualify. A narrow historical admission pass is not broad spatial qualification.

## Example: Luna Decisions

This example uses the typed **Decisions API** with genuine Choice probabilities. Model and provider are explicit; there are no automatic retries or fallbacks. It illustrates one integration and is not a library default. Jev is optional and is not used by this example.

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

## Locate an object (experimental)

Default region `locate` is experimental and unqualified. With either configured client:

```ts
const result = await client.locate({
  image: await readFile('photo.jpg'),
  target: 'a red backpack on the chair',
})
if (result.status === 'located') console.log(result.region)
```

`region` uses EXIF-oriented source pixels. It is a selected grid cell containing a hypothesized object fragment, not a tight box, segmentation mask or object-center guarantee. `unknown` is distinct from absence; transport/protocol errors throw `ClassifierError`.

The locator uses up to three sequential calls: coarse 4×4 regions, fine grids in four padded regions, then four enlarged candidates. Coordinates come from code, never free-form model coordinates. Ordinary-model rankings select candidates; independent present/absent/unknown answers govern abstention. Multiple matching physical instances are allowed; one candidate is returned. Localization requires the model/endpoint to accept multiple images per call (up to nine); single-image-only endpoints can still support `classify`.

## Extract a mask-derived object (experimental)

Extraction and caller-owned segmentation are experimental and unqualified. For a visible object box, center, or transparent cutout, use `extract` with an explicitly configured caller-owned segmenter. The existing region locator supplies a seed; the segmenter receives that seed while processing the full oriented source image. The library derives the returned box and center from actual mask pixels only. After segmentation, the caller's decision port checks the full source with the mask-derived box and original seed anchor: `complete` yields the result (optional cutout); `needs-expansion` allows at most one enclosing-mask expansion and one final check (a final `complete` can still produce the result); unresolved checks, missing expansion support, no valid enclosing mask, or a failed final check yield `unknown` with no second expansion. Crops, resize and padding preserve source/mask alignment; box-check rendering uses injected `RasterPort.imageState` on the full canvas. This adds one or two closed checks to the normal region requests, without model-generated coordinates or an extent search. See the [0.2 usage guide](docs/v02-usage.md) and runnable [`extract-object.ts`](https://github.com/zoomplus/zorya-classifier/blob/main/examples/extract-object.ts). The classifier and segmenter are separately caller-owned and both must be disposed.

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

A model must understand the input, follow instructions and produce the checked answer shape. JSON Schema/JSON-object modes are opt-in when the chosen endpoint supports them; prompt-only mode does not require structured-output support. No universal accuracy, calibration or sub-second guarantee is asserted. Legacy region refinement uses `RefinementPort`; the 0.2 explicit `extract` workflow uses a caller-owned `SegmentationPort`.

See [CONTRIBUTING](https://github.com/zoomplus/zorya-classifier/blob/main/CONTRIBUTING.md), [SECURITY](https://github.com/zoomplus/zorya-classifier/blob/main/SECURITY.md), [NOTICE](NOTICE.md), and [LICENSE](LICENSE).
