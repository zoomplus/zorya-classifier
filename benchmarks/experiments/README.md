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
