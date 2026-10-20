# MobileSAM short CPU smoke evidence

Run on 2026-10-20 with Node 24.12.0, CPU provider, Linux, no forced GC, zero warmup, a 15-second busy window, two 30-second idle windows, and 250 ms resource sampling. This was a wiring and resource-lifecycle smoke, not a long soak or an accuracy evaluation.

The pinned assets were `mobile_sam_image_encoder.onnx` SHA-256 `580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749` and `sam_mask_decoder_multi.onnx` SHA-256 `8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe`.

The run command was:

```sh
node --import tsx benchmarks/v02/native-smoke.ts \
  --backend=mobile-sam \
  --encoder=/path/to/mobile_sam_image_encoder.onnx \
  --decoder=/path/to/sam_mask_decoder_multi.onnx \
  --fixtures=benchmarks/v02/native-dev-photo-fixtures.json \
  --warmup-seconds=0 --duration-seconds=15 --sample-ms=250 \
  --out=.run/native-smoke-photos.json
```

The run completed 12/12 operations with no unknown or failed results, measured p50 1,261 ms and p95 1,403 ms per operation. This per-call timing includes fresh child startup, native runtime/model initialization, and inference; every call uses a new child. Per-case mask IoU against independent Open Images instance masks was: photo-dev-present-06 0.878, -08 0.859, -09 0.943, -13 0.670, and -15 0.947. The synthetic wiring case scored 1.000. The weaker hat score is visible evidence that these numbers must not be presented as overall accuracy.

Lifecycle controls returned `not-found` without segmentation for the negative locator result, `ABORTED` for cancellation, rejected one overloaded call with `CAPACITY`, rejected malformed input with `INVALID_INPUT`, reported a missing model as `UNSUPPORTED`, and tolerated repeated disposal. The resource report counted 12 child starts and 12 closes, with zero children still owned. Peak parent RSS was 283 MB; peak child RSS was 559 MB. Parent samples were collected throughout both idle windows and the busy window, independent of the short child lifetimes. Median parent heap/external/array-buffer/RSS values changed from 12.3/38.8/36.2/258.4 MB in the first idle window to 16.3/49.9/38.4/282.8 MB in the second. Those short-run differences stay below the documented investigation thresholds and do not establish long-run behavior.

The five photo bytes and source-sized mask PNGs came from the neighboring corpus worktree's gitignored cache and are intentionally not included in this source archive. The tracked fixture manifest records hashes and per-photo source/license. The cat reference mask was verified against the selected first-cat box by its annotated source-sized extent before this run. This run made no network or paid model calls. It did not exercise DirectML, Windows, the default 10-minute warmup, meaningful idle-window trend thresholds, or the planned long soak.
