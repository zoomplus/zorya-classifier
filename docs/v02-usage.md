# Whole-object location and extraction (0.2 source branch)

These APIs are implemented on the 0.2 development branch. They are not a claim that npm `latest` already contains them. The [accepted plan](0.2.0-plan.md) and [acceptance status](acceptance.md) distinguish implementation, offline checks, live quality and platform qualification. No text-image encoder has passed release qualification yet.

The library does not select or connect a model. Supply a `DecisionPort` to `createClassifier`, either by implementing the port or explicitly constructing a provider adapter. The Luna examples below are reproducible integration recipes, not defaults or a claim that one model is always more accurate; stronger model capability does not guarantee monotonic accuracy gains. Optional local segmenters and proposal generators are configured separately, and their runtime packages and model assets remain the caller's responsibility.

## Choose the operation

| Operation                             | Result                                              | Model requests                                                    |
| ------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| `classify`                            | One supplied class                                  | One                                                               |
| `locate` (default / `mode: 'region'`) | A grid cell that may contain a fragment             | Up to three                                                       |
| `locate` with `mode: 'whole-object'`  | Conservative visible bounds of one seeded instance  | Up to six                                                         |
| `extract`                             | Transparent PNG, cropped binary mask, source offset | Whole-object calls plus the explicitly configured local segmenter |

Default region behavior remains compatible. A whole-object box covers the visible object within the hard ROI; it does not reconstruct hidden parts. A mask is produced only by `extract`. No operation promises exact semantic understanding for every photo or map.

Runnable source examples are [whole-object location](../examples/locate-whole-object.ts) and [PNG extraction](../examples/extract-object.ts). The extraction example uses the explicit CPU backend and preserves an existing output file. It prints geometry and mask dimensions instead of serializing binary mask bytes. Install the optional runtime and obtain the pinned assets yourself before running it; the library does not select, download or install segmentation assets. Source examples are maintained in the repository rather than bundled into the npm archive.

## Locate the complete visible object

Use an existing client configured with a `DecisionPort`:

```ts
const result = await client.locate({
  image: await readFile('photo.jpg'),
  target: 'the backpack on the nearest chair',
  mode: 'whole-object',
  boxTolerancePx: 8,
  maxExtentPasses: 3,
  signal: AbortSignal.timeout(45_000),
})
if (result.status === 'located') {
  console.log(result.region, result.seedRegion, result.bounds, result.completeness)
}
```

Coordinates reference the EXIF-oriented source image. `left` and `top` are inclusive; `left + width` and `top + height` are exclusive. Optional integer `roi` is a hard search boundary in that same space.

The seed uses the existing three-stage locator. Each following request asks four closed Choices over actual integer boundary intervals and, on the first pass, a same-instance question. Each axis has at most sixteen intervals plus `unknown`. Up to three passes refine the selected intervals; `boxTolerancePx` is 1–64, default 8. All requests share one deadline, including queue time.

`bounds` contains half-open intervals for the four extreme visible pixels; the rectangle conservatively covers those intervals. The seed must intersect the object, rather than contain it. Reversed bounds, ROI escape or a box missing the seed return `unknown/extent-inconsistent`; they are never sorted or clamped. Ambiguous identity gives `instance-ambiguous`; insufficient resolution or uncertain boundaries give `extent-uncertain`. `boundary-limited` warns that source/ROI edges may clip the visible extent.

## Select whole-object bounds from pixel masks

An explicit `objectProposals` adapter enables `pixel-mask-proposals-v1` instead of the boundary-interval algorithm. It first obtains a seed with the compatible region locator, computes 36 MobileSAM masks from nine seed points, then asks the configured model to choose a supplied mask or `none` and independently confirm completeness. The native process closes before the model request. Mask aliases and actual image pixels determine the result; the model never invents coordinates. Default region and classification operations are unchanged.

```ts
import { createClassifier } from 'zorya-classifier'
import { createMobileSamObjectProposals } from 'zorya-classifier/segmentation'

// decision is an explicitly configured DecisionPort; asset paths identify pinned local files.
const proposals = await createMobileSamObjectProposals({ encoderPath, decoderPath, threads: 2 })
const client = createClassifier({ decision, objectProposals: proposals })
try {
  const result = await client.locate({ image, target: 'the backpack', mode: 'whole-object' })
  // extract performs its own localization and reuses that operation's selected mask.
  const cutout = await client.extract({ image, target: 'the backpack' })
  console.log(result.status, cutout.status)
} finally {
  try {
    await client.dispose()
  } finally {
    await proposals.dispose()
  }
}
```

This adapter requires the same explicit pinned assets and optional ONNX Runtime installation described below. Asset selection, verification and installation belong to the caller. The proposal factory currently supports CPU only, at most 2,097,152 oriented source pixels, one active native task and two waiters. It returns at most 36 masks packed as row-major `binary-lsb0` bits, at most 10 MiB in total. A source larger than this fails explicitly rather than being silently resized. Up to four bounded presentation PNGs supplement the source image. All native work, rendering and model requests share the classifier deadline; up to five model requests are possible. The library performs no model/provider fallback or retry.

A [caller-owned categorical presence example](categorical-presence-port.md) shows how to express binary propositions as closed Choice questions in the same injected-port call. It uses only public imports, selects no model/provider, and is a repository source example rather than an npm export. Development selection and fixture tests remain separate from blind quality qualification.

The returned `bounds` are one-pixel intervals around the selected raster mask. This describes the mask's actual bounds, not a guarantee that the model found the true semantic boundary. `boxTolerancePx` and `maxExtentPasses` apply to the interval strategy, not this strategy. A correct box does not prove a good cutout: mask quality is measured separately. Empty, seed-disjoint or unconfirmed selections return a named `unknown`; native/backend errors throw.

`ObjectProposalPort` supports other caller-owned proposal generators with the same limits. Its `propose` promise must settle only after its physical work closes. `packBinaryMask` and `unpackBinaryMask` from the segmentation entry validate and convert mask bytes. Importing them does not load ONNX Runtime. The caller disposes a shared proposal adapter; the classifier only cancels and joins its own operations. If both `objectProposals` and `segmentation` are explicitly configured, the selected proposal supplies the whole-object box and the segmenter performs a separate refinement; a refinement failure never falls back to the proposal mask.

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

## CLI

Set explicit model/provider variables as in the [main guide](../README.md). Arguments are validated before native composition or model dispatch.

```sh
zorya-classifier locate photo.jpg 'the backpack' --mode whole-object
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
