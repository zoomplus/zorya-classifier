# Region-seeded masks and extraction (0.2)

The [accepted plan](0.2.0-plan.md) and [acceptance status](acceptance.md) distinguish implementation, offline checks, live quality and platform qualification. The frozen caller recipe passed admission with only 8/60 complete positive object boxes; 19/30 mask references had no prediction. Configure and test the model and segmenter for your own data. No text-image encoder qualified.

The library does not select or connect a model. Supply a `DecisionPort` to `createClassifier`, either by implementing the port or explicitly constructing a provider adapter. The Luna examples below are reproducible integration recipes, not defaults or a claim that one model is always more accurate; stronger model capability does not guarantee monotonic accuracy gains. Optional local segmenters and proposal generators are configured separately, and their runtime packages and model assets remain the caller's responsibility.

## Choose the operation

| Operation                                               | Result                                                                       | Model requests                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| `classify`                                              | One supplied class                                                           | One                                            |
| `locate` (default / `mode: 'region'`)                   | A grid cell that may contain an object fragment                              | Up to three                                    |
| `locate` with `mode: 'whole-object'` and `segmentation` | Visible bounds and center derived from a mask                                | Up to five, plus local segmentation/correction |
| `extract` with `segmentation`                           | Mask-derived bounds, center, transparent PNG, cropped mask and source offset | Up to five, plus local segmentation/correction |

The primary object workflow is the unchanged region locator followed by an explicitly configured segmenter. Segmentation receives the locator's seed prompt on the full EXIF-oriented source image; it does not receive a seed crop or treat the seed as an object box. Bounds and center come from actual foreground mask pixels. After the initial mask, a closed decision checks the original image with the actual mask box and original seed anchor: `complete`, `needs-expansion`, or `unknown`. It reuses the caller-supplied `DecisionPort`. An incomplete box permits one actual enclosing-mask correction and one final check; there is no separate extent search or generated model geometry. Default `locate` behavior remains compatible.

## Primary workflow: region seed to mask-derived result

Configure the caller's `DecisionPort` and local segmenter, then call `extract`:

```ts
const client = createClassifier({ decision, segmentation: segmenter })
try {
  const result = await client.extract({ image, target: 'the backpack' })
  if (result.status === 'extracted') {
    console.log(result.region, result.center, result.offset)
    // result.png is transparent; result.mask contains the matching cropped binary mask.
  } else {
    console.log(result.status, result.reason)
  }
} finally {
  try {
    await client.dispose()
  } finally {
    await segmenter.dispose()
  }
}
```

`result.region` is the mask-derived half-open rectangle in source coordinates. `result.center` is its pixel center, and `result.offset` maps the cropped mask and PNG back to the source. Empty or seed-ungrounded masks return `unknown/segmentation-uncertain`; a locator rectangle is never substituted. The same unknown is returned when containment cannot be confirmed, expansion is unavailable, or the corrected mask still fails its check. Successful primary results use `method: 'region-checked-segmentation-v1'`. `verification.checks` retains the one or two closed decisions with raw scores/ranks and actual request metadata; `verification.expansion` reports `not-needed`, `unsupported`, `no-enclosing-mask`, `rejected-mask`, or `expanded`. Verification decision costs are included in `location.metadata`. A confirmed box is separate from pixel-perfect mask quality. Native and resource errors remain typed failures. `locate({ mode: 'whole-object' })` uses the same mask path when a segmenter is explicitly configured.

The decision port, optional custom `segmentationBoxCheck`, and segmenter remain caller-owned. The classifier cancels and joins its operations but does not dispose an injected segmenter. Dispose both resources when the application owns both. Model/provider selection is also explicit; examples below show one caller-configured route, not a library default or accuracy guarantee.

### Optional caller presence guard

The tested v3 caller composition first classifies the target as `present` or `absent`, then calls `extract` only for `present`. This is caller logic: direct `extract` uses up to three region requests plus one or two containment checks; the guard adds one classification request. The [complete heldout comparison](evidence/v02/region-seeded-heldout-v3/README.md) preserves all errors and unknown outputs. Earlier v2 results predate containment checks and remain historical. A classification error remains an error; it must not be converted to absence. Keep both calls under one caller-owned absolute deadline and abort signal.

```ts
// image, target and signal are owned by this application's operation.
const presence = await client.classify({
  input: { image, text: target },
  classes: [
    { id: 'present', description: 'The target is visible in this image.' },
    { id: 'absent', description: 'The target is not visible in this image.' },
  ],
  signal,
})
if (presence.choice === 'present') {
  const result = await client.extract({ image, target, signal })
  // Handle the actual result; do not substitute the seed for a failed mask.
  console.log(result.status)
}
```

This illustrates caller composition rather than a new package default. Exact benchmark tasks, prompts, timeouts, route and preserved failures are pinned in the historical [v2 development evidence](evidence/v02/region-seeded-dev-v2/README.md) and current [checked-flow v3 comparison](evidence/v02/region-seeded-dev-v3-control-r2/README.md). The latter records 6/30 positive whole-object box matches and 1/7 passing exact-canvas masks; it does not guarantee accurate cutouts for every object. Changing the caller's model, segmenter or prompt requires its own quality measurement.

A baseline Linux CPU wiring smoke with the pinned MobileSAM assets used a synthetic 192×128 image. A colored rectangle produced a 2,800-pixel mask with bounds `[70, 34, 120, 90]`; an all-transparent input produced a full-size empty mask. Three child starts matched three closes. This verifies adapter wiring only, not photo accuracy.

## Legacy interval and proposal strategies

The earlier boundary-interval `whole-object` strategy and `objectProposals` mask-choice strategy remain optional legacy/research paths. They are not required by the primary seed-region segmentation workflow and have their own model-confirmation steps and historical evidence. The interval strategy asks closed Choices over integer boundaries after the region seed. Each axis has at most sixteen intervals plus `unknown`; up to three passes refine the intervals. It returns interval-derived geometry, not a segmented mask.

The optional `objectProposals` adapter computes packed MobileSAM masks from nine seed points, then asks the configured model to select a supplied candidate and confirm its rectangle. Its box checks and mask quality are separate from direct seed-prompt segmentation. Default region and classification operations are unchanged.

## Extract with an explicit local backend

Core runtime dependencies remain Sharp and Zod. MobileSAM requires the optional peer:

```sh
npm install onnxruntime-node@1.23.2
```

Obtain the exact licensed assets yourself; [pinned sizes, SHA256 and provenance](evidence/v02/segmentation/README.md) are recorded separately. Asset files, optional ONNX Runtime installation and backend availability are caller-owned prerequisites; importing or configuring the package does not fetch model weights. Imports never download models or start workers. CPU is the default provider within this explicitly constructed adapter; `executionProvider: 'dml'` is an opt-in Windows route and fails when unavailable. No CPU/model fallback is attempted.

```ts
import { readFile, writeFile } from 'node:fs/promises'
import { createClassifier } from 'zorya-classifier'
import { createOpenRouterDecisions } from 'zorya-classifier/openrouter'
import { createMobileSamSegmenter } from 'zorya-classifier/segmentation'

const apiKey = process.env.OPENROUTER_API_KEY
const encoderPath = process.env.MOBILE_SAM_ENCODER
const decoderPath = process.env.MOBILE_SAM_DECODER
if (!apiKey || !encoderPath || !decoderPath)
  throw new Error('Configure credentials and asset paths')
const segmenter = await createMobileSamSegmenter({
  encoderPath,
  decoderPath,
  executionProvider: 'cpu',
  threads: 2,
})
const client = createClassifier({
  decision: createOpenRouterDecisions({
    apiKey,
    model: 'openai/gpt-6-luna-decisions',
    provider: 'openai',
  }),
  segmentation: segmenter,
})
try {
  const result = await client.extract({
    image: await readFile('photo.jpg'),
    target: 'the backpack',
  })
  if (result.status === 'extracted') {
    await writeFile('backpack.png', result.png, { flag: 'wx' })
    await writeFile('backpack.mask.u8', result.mask.data, { flag: 'wx' })
    console.log(result.region, result.offset, result.mask.width, result.mask.height)
  } else console.log(result.status, result.reason)
} finally {
  try {
    await client.dispose()
  } finally {
    await segmenter.dispose()
  }
}
```

The mask is cropped to its visible bounds, row-major, one byte per pixel (`0` or `1`), with its own width/height and `format: 'binary-u8'`. `offset` maps its origin back to the source. PNG pixels inside the mask preserve source RGBA; pixels outside have zero RGBA. Transparent source pixels cannot substantiate an object. Invalid dimensions, nonbinary values, hard-ROI escape and masks missing the visible seed fail validation. Empty or ungrounded masks return `unknown/segmentation-uncertain`; a rectangle is never substituted for a mask. Protocol, native and resource errors remain typed failures.

`createGrabCutSegmenter({ assetPath })` selects the separately supplied pinned OpenCV 4.13.0 JS asset. It does not require ONNX Runtime. This is an explicit alternate algorithm. A custom `SegmentationPort` can integrate other backends with the same validation.

The caller owns a segmenter and may share it between clients. `client.dispose()` cancels and joins that client's operations without disposing the segmenter. Each `segment()` promise must remain pending until its own physical work settles, including cancellation. `segmenter.settle()` joins admitted work; `segmenter.dispose()` closes its own resources. Dispose both when the application owns both.

Built-in adapters probe the backend on explicit factory calls and run each admitted inference in a fresh owned child. They currently do not reuse sessions: measured inference includes cold child/model startup. One active task and two waiters bound native work. Cancellation retains the slot through child close, with 250 ms grace before owned-child termination; each task has a 10-second native limit inside the client's absolute deadline. Consult measured evidence for latency-sensitive deployment.

MobileSAM uses the seed region's center as a positive point on the full source and selects the mask with the greatest finite native quality score, using stable ties. It is a geometric point-prompt model; it does not interpret the target's text. Its raw quality score estimates a mask, not target identity or completeness. In the exposed development set it sometimes selected a part, such as a car's headlight, rather than the whole car. `status: 'extracted'` means that the returned mask and artifacts passed structural/source validation; it is not a semantic correctness guarantee. The [independent quality report](evidence/v02/region-seeded-dev-v2/README.md) measures that distinction. A caller-owned `SegmentationPort` can supply a different or text-guided backend without changing region search or connecting a model inside the library.

## CLI

Set explicit model/provider variables as in the [main guide](../README.md). Arguments are validated before native composition or model dispatch.

```sh
# Optional legacy interval-boundary location without an explicit segmenter.
zorya-classifier locate photo.jpg 'the backpack' --mode whole-object
# Primary region-seeded segmentation and cutout flow.
zorya-classifier extract photo.jpg 'the backpack' --output backpack \
  --backend mobile-sam --encoder /models/encoder.onnx --decoder /models/decoder.onnx
zorya-classifier extract photo.jpg 'the backpack' --output backpack \
  --backend grabcut --opencv /models/opencv.js
```

Successful extraction writes `<prefix>.png`, `<prefix>.mask.u8` and `<prefix>.json`. Destinations are reserved exclusively before writing; existing files are preserved. JSON contains dimensions, source geometry, metadata and file paths rather than serialized binary arrays. Output failure removes only destinations created by that operation. Parent directories must exist. SIGINT/SIGTERM cancels work and disposes CLI-owned resources.

## Experimental text-only images

The reserved selector is `representation: { type: 'experimental-text', profile: 'text-image-v1' }`. Public composition currently rejects image operations with `UNSUPPORTED` before dispatch because no encoder is qualified. Ordinary text classification remains usable.

Research candidates compare normalized luma ASCII, color palette grids, SVG color runs, strict pixel RLE, binary/edge ASCII, and layered ASCII + SVG. No OCR, semantic helper or hidden vision call supplies object facts. Text adapters reject image parts rather than silently dropping them. Complete encoded views and metadata have a 64 KiB UTF-8 budget, allocated before encoding; output is never truncated to fit. Indistinguishable geometry returns a named unknown.

Only a candidate that passes development selection and frozen independent heldout qualification may be promoted. Other candidates, bulk images and model weights stay outside npm. A grammar roundtrip or syntactically valid LLM answer alone does not qualify photo localization.
