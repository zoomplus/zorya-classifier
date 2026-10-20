# Whole-object location and extraction (0.2 source branch)

These APIs are implemented on the 0.2 development branch. They are not a claim that npm `latest` already contains them. The [accepted plan](0.2.0-plan.md) and [acceptance status](acceptance.md) distinguish implementation, offline checks, live quality and platform qualification. No text-image encoder has passed release qualification yet.

## Choose the operation

| Operation                             | Result                                              | Model requests                                                    |
| ------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| `classify`                            | One supplied class                                  | One                                                               |
| `locate` (default / `mode: 'region'`) | A grid cell that may contain a fragment             | Up to three                                                       |
| `locate` with `mode: 'whole-object'`  | Conservative visible bounds of one seeded instance  | Up to six                                                         |
| `extract`                             | Transparent PNG, cropped binary mask, source offset | Whole-object calls plus the explicitly configured local segmenter |

Default region behavior remains compatible. A whole-object box covers the visible object within the hard ROI; it does not reconstruct hidden parts. A mask is produced only by `extract`. No operation promises exact semantic understanding for every photo or map.

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

## Extract with an explicit local backend

Core runtime dependencies remain Sharp and Zod. MobileSAM requires the optional peer:

```sh
npm install onnxruntime-node@1.23.2
```

Obtain the exact licensed assets yourself; [pinned sizes, SHA256 and provenance](evidence/v02/segmentation/README.md) are recorded separately. Imports never download models or start workers. CPU is the default provider; `executionProvider: 'dml'` is an opt-in Windows route and fails when unavailable. No CPU/model fallback is attempted.

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
