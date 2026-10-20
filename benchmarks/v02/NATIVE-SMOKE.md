# Native segmentation resource smoke harness

`native-smoke.ts` is a manual CLI. Importing it does not start a timer, native worker, model, or benchmark. Its default planned phases are 600 seconds of warmup, two 30-second idle windows around 6,540 seconds of measured inference, and five-second parent sampling (two hours of phase time, plus setup and lifecycle checks). **Each segmentation call starts a fresh child and initializes its native runtime/model; there is no warm worker or reusable model session.** Parent RSS, heap, external memory, and array buffers are sampled continuously across both idle windows and the busy phase, independently of the short-lived child processes. Each sample records a timestamp and phase. The report includes median heap/external/array-buffer/RSS values for both idle windows and peak values during the run. No forced GC is used. A rise exceeding 10% or 16 MiB in median heap, external memory, or array buffers calls for investigation; an RSS rise exceeding 20% or 128 MiB also calls for investigation and is not automatically classified as a leak. Child memory is sampled inside each worker at startup, once per second while telemetry is requested, and after inference. The report includes child peaks, latencies, operation counts, and child ownership after two adapter disposals. Bounded positive, absent-target short-circuit, cancellation, queue-overload, bad-input, missing-asset and repeated-disposal checks run before warmup.

Run only when the pinned assets and sufficient time are available. This launches native work and the default takes about 2 hours 10 minutes:

```sh
node --import tsx benchmarks/v02/native-smoke.ts \
  --backend=mobile-sam \
  --encoder=/path/to/mobile_sam_image_encoder.onnx \
  --decoder=/path/to/sam_mask_decoder_multi.onnx \
  --fixtures=/path/to/licensed-fixtures.json \
  --out=/path/to/mobile-sam-resource-report.json
```

For GrabCut, use `--backend=grabcut --opencv=/path/to/opencv.js`. Use smaller explicit `--warmup-seconds`, `--duration-seconds`, `--idle-seconds`, and `--sample-ms` values for harness verification; the 2-hour run has not been started by this change. Run each backend in a fresh process and retain its exact command and output. Do not compare a CPU run with a DirectML run as though they used the same provider.

This worktree includes `native-dev-photo-fixtures.json`, a five-photo development panel using independent Open Images V5 instance masks. Its image and mask bytes live in the sibling corpus worktree's gitignored cache, so it is usable when that checkout is alongside this worktree under the same `v02` worktree directory; it is not a portable bundled fixture. The manifest records photo source/license and image hash, and the harness checks each mask PNG hash before decoding. These are development smoke cases, not held-out accuracy evidence. The masks are source-sized binary 0/255 PNGs and are compared with independently supplied instance masks.

The optional fixture manifest is a JSON array with one entry per positive, licensed photo fixture:

```json
{
  "id": "local-case-id",
  "imagePath": "photo.png",
  "sha256": "64 lowercase hex characters",
  "sourceUrl": "https://public-source.example/image-page",
  "license": "declared per-image license",
  "target": "the visible object",
  "seedRegion": { "left": 10, "top": 12, "width": 12, "height": 12 },
  "wholeRegion": { "left": 1, "top": 1, "width": 40, "height": 55 },
  "referenceMaskPath": "photo.mask.u8",
  "referenceMaskFormat": "binary-u8",
  "referenceMaskSha256": "64 lowercase hex characters"
}
```

Regions use oriented source pixels. A reference mask is optional. `binary-u8` masks contain exactly one 0/1 byte per oriented source pixel; `png-binary` masks must decode to source-sized grayscale pixels containing only 0/255. Paths are relative to the manifest. The report retains source URL, declared license and input hash, not the local path. The built-in synthetic panel has exact binary truth and serves as a wiring check, not public-image accuracy evidence. Absence is exercised as a locator short-circuit so the harness never presents a guessed segmentation box as a valid absent-target result. Existing benchmark corpus policy remains in force; the harness does not acquire or reinterpret corpus labels.
