# Native segmentation resource smoke harness

`native-smoke.ts` is a manual CLI. Importing it does not start a timer, native worker, model, or benchmark. It defaults to a 600-second warmup, 7,200 seconds of measured inference, five-second parent sampling, no forced GC, and one owned child per operation. Child memory is sampled inside the worker at startup, once per second while telemetry is requested, and after inference. The runner subscribes only during the measured phase and reports parent/child RSS, heap, external memory, array buffers, latencies, operation counts, and child ownership after two adapter disposals. It also runs bounded positive, absent-target short-circuit, cancellation, queue-overload, bad-input, missing-asset and repeated-disposal checks before warmup.

Run only when the pinned assets and sufficient time are available. This launches native work and the default takes about 2 hours 10 minutes:

```sh
node --import tsx benchmarks/v02/native-smoke.ts \
  --backend=mobile-sam \
  --encoder=/path/to/mobile_sam_image_encoder.onnx \
  --decoder=/path/to/sam_mask_decoder_multi.onnx \
  --fixtures=/path/to/licensed-fixtures.json \
  --out=/path/to/mobile-sam-resource-report.json
```

For GrabCut, use `--backend=grabcut --opencv=/path/to/opencv.js`. Use smaller explicit `--warmup-seconds`, `--duration-seconds`, and `--sample-ms` values for harness verification; the 2-hour run has not been started by this change. Run each backend in a fresh process and retain its exact command and output. Do not compare a CPU run with a DirectML run as though they used the same provider.

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
  "referenceMaskSha256": "64 lowercase hex characters"
}
```

Regions use oriented source pixels. A reference mask is optional, but when supplied it must be exactly one binary byte per oriented source pixel. Paths are relative to the manifest. The report retains source URL, declared license and input hash, not the local path. The built-in synthetic panel has exact binary truth and serves as a wiring check, not public-image accuracy evidence. Absence is exercised as a locator short-circuit so the harness never presents a guessed segmentation box as a valid absent-target result. Existing benchmark corpus policy remains in force; the harness does not acquire or reinterpret corpus labels.
