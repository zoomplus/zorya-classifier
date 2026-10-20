# Private MobileSAM point-proposal experiment

These scripts are private offline research tools. They do not change the public classifier API or the shipped native segmentation worker.

`mobilesam-point-proposals.mjs` accepts a seed-only manifest with five or fewer cases. Each case provides a stable ID, source image path and SHA-256, oriented source dimensions, the actual `geometry.seedRegion` from a fresh model call, and the ROI from that same call (or the full image when no ROI was recorded). The producer receives no target, annotation mask, or oracle box. It verifies the pinned MobileSAM encoder and multi-mask decoder, runs one CPU encoder pass and nine fixed 3×3 seed-grid point prompts per image, and records all four decoder candidates for every prompt. Label `-1` is the decoder's ignored padding point, not a negative click.

The producer owns one child process with a 60-second timeout and waits for its close event before removing its private temporary directory. The output keeps source-coordinate boxes, uncalibrated decoder quality values, point/token indexes, stable duplicate references, and previews no larger than 32×32. Full binary masks are stored once per exact unique mask in a separate gzip artifact. Research-only limits are 1,048,576 source pixels per case, 256 MiB decompressed unique masks, and 64 MiB compressed masks. These limits apply only to this experiment; the classifier's public request and native IPC budgets are unchanged.

`evaluate-mobilesam-point-proposals.mjs` is a separate process step. Run it only after proposal JSON and masks are durable. It accepts an independent reference-mask manifest, then reports the top raw-quality result, oracle best candidate, predicted-box IoU, candidate-union mask/box coverage, and per-candidate metrics. Raw model quality remains a ranking signal, not semantic truth. Oracle best-candidate measurements are component upper bounds, not end-to-end localization results.

For this recorded development panel, four fresh traces had confirmed actual seed regions (photos 06, 08, 09, and 15). Photo 13/Hat did not complete seed confirmation and is omitted; annotation-derived seeds must not be substituted. The producer input and separate trace proof files are retained with the run artifacts. The evaluator uses the corrected five-photo annotation manifest but evaluates only IDs present in the frozen producer output.

The CPU probe produced 36 candidates per confirmed case. Foreground hit counts, top-quality mask IoU, oracle-best mask IoU, best candidate box IoU, and proposal-union coverage were:

| Case | Foreground hits | Top-quality mask IoU | Oracle-best mask IoU | Best box IoU | Union mask coverage | Union box coverage |
| ---- | --------------: | -------------------: | -------------------: | -----------: | ------------------: | -----------------: |
| 06   |             6/9 |                0.758 |                0.810 |        0.708 |               0.984 |              1.000 |
| 08   |             0/9 |                0.000 |                0.000 |        0.000 |               0.000 |              0.000 |
| 09   |             9/9 |                0.134 |                0.945 |        0.957 |               0.954 |              0.996 |
| 15   |             9/9 |                0.369 |                0.942 |        0.962 |               0.999 |              1.000 |

For photos 09 and 15, the proposal set contains strong masks and boxes even though the top raw-quality candidate is poor. Photo 08's actual seed grid misses the annotated object entirely, so no proposal covers it. This is evidence about candidate availability under the recorded seeds; it does not show that a downstream selector can reliably pick the oracle candidate.

The frozen outputs are `.run/mobile-sam-point-actual-seeds-aba0f63-proposals.json` (SHA-256 `83d75738b98cf89ae83a9092028fff1345f329e2dfbd9f0bf06db82ea7bc7b3b`), `.run/mobile-sam-point-actual-seeds-aba0f63-masks.gz` (SHA-256 `cbe06e8ad646bb3e6dcb07d557da5e8392410481d3e408d84515d1b221c06bd0`), and `.run/mobile-sam-point-actual-seeds-aba0f63-eval-final.json` (SHA-256 `879cf3a4af1c290f08a706daa396877e967bcdb2ac93786c45a0c766f490638a`). The seed-only input manifest SHA-256 is `f1cd88c5809c702c87576e82ed55508f2dd405f1bf3e399711c959f4fc010d15`; its separate trace-proof file SHA-256 is `3ef095f885582663e224d0747a638ab06e8997d57ea24095302b5f129ddc0cff`.

`render-point-proposal-contact-sheets.mjs` is a separate truth-free presentation step. It reads only the frozen proposal JSON, compressed mask artifact, seed-only manifest, and source images; it does not open evaluator annotations or use candidate quality scores to filter or order candidates. It verifies the frozen artifact hashes, input dimensions, and each binary mask before rendering. The model-facing presentation uses only generic `case-01` paths, a generic page heading, and local `C00`–`C35` aliases. Immutable source candidate IDs and mask/box references stay under `cases[].internal`; an A5 request should send only `cases[].presentation.choiceIds`, its semantic descriptions, and the original/contact-sheet PNGs. Run it with a new output directory and manifest path:

```sh
node benchmarks/experiments/render-point-proposal-contact-sheets.mjs \
  --proposals=.run/mobile-sam-point-actual-seeds-aba0f63-proposals.json \
  --masks=.run/mobile-sam-point-actual-seeds-aba0f63-masks.gz \
  --seeds=/path/to/model-seed-proposals-input-v1/inputs.json \
  --source-root=/path/to/corpus \
  --out-dir=.run/point-proposal-contact-sheets-run1 \
  --manifest=.run/point-proposal-contact-sheets-run1.json
```

The output contains the oriented original PNG and three 12-tile sheets per confirmed case. Every choice has a stable local alias label, source-coordinate box, red translucent mask fill with cyan boundary on the original, and a transparent cutout. Exact duplicate masks are rendered once with all equivalent local aliases shown; every candidate alias remains selectable. `cases[].presentation.choiceIds` contains `none` and local aliases, while `cases[].presentation` exposes only generic image paths and choices. The separate internal mapping retains immutable candidate IDs, point/token provenance, source box, exact compressed-artifact reference (decompressed byte offset, byte length, and SHA-256), and contact-sheet page/tile coordinates and hashes. The entire renderer omits target/reference data.

Renderer limits are 64 MiB compressed masks, 256 MiB decompressed masks, 16 MiB proposal JSON, 32 MiB per source image, 1,048,576 pixels per image, five cases, and 36 candidates per case. It uses bounded gzip expansion and destroys Sharp pipelines after each image operation. A pre-alias renderer run visibly included development case IDs on sheets; preserve `.run/point-proposal-contact-sheets-aba0f63/`, `.run/point-proposal-contact-sheets-aba0f63-rerun/`, and their manifests only as rejected diagnostic outputs. The alias-safe artifact is at `.run/point-proposal-contact-sheets-alias-safe-final/`; its manifest SHA-256 is `2e46c49f1031340b0739b69ea0f7a0319328c97b8bbc9b73e707f52b8105f824`. It rendered 16 images in about 17 seconds on Linux. No paid model calls were made. Presentation assertions check that labels exclude fixture case IDs, source filenames, hashes, target-truth text, and reject non-alias IDs.

To screen candidate availability across the remaining confirmed actual seeds, the same producer was run on two additional frozen seed-only manifests from the existing 30-case outline run. Each manifest was processed independently and rendered with the alias-safe presentation. No evaluator annotations or GT were opened for these additional batches, no seed was replaced, and no model quality was used to choose candidates. Each four-case run produced 144 candidates and 16 images; the native child exited successfully and its private temporary directory was removed after close.

| Batch | Seed manifest SHA-256                                              | Proposal SHA-256                                                   | Mask gzip SHA-256                                                  | A5 manifest SHA-256                                                |
| ----- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 1     | `d61745e3231bcc5bda023934e62697748be39f0419af6e4721bb59e5edb26aab` | `eb4cdaa92671e87224ac6a021b46d1568f6df7af225b894d5c5f6da9157cab26` | `3e299ec46008605c6829e87977efc82f473835d6419bd041be39c01c7d57ad20` | `41aa57b4a8219b651405eacdf0a40cdb98b9d2704f0c083a928a1597be1829d0` |
| 2     | `fa215462f3ea6b280f39e6d8dce1ea9a771da799a77365faec48904aa7a394ab` | `560e4c9420e4475efcaaf0ce88dc5c63f75aba8bcad67a5448d7b7e53a70d34b` | `61aa61c5aaa5ba17e15612c7bbce85de97b356512e3df3950bce58c6ab697e7f` | `e7f43d60e3930003726d044b88a4bbebdf678da21c660e6b53eb7b5dfb5d0c6b` |

These are candidate-presentation diagnostics only. They do not establish semantic selection accuracy or end-to-end localization quality.
