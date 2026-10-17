# Reproducible benchmarks

Current native Luna Decisions and ordinary vision comparisons are summarized in [tested models](vision-results.md). The fixed native-Jev runner below remains a historical/reproducibility tool, not the primary model configuration. New model-selection snapshots and budget continuations are retained separately; never label the Jev runner's output as evidence for Luna or another backend.

The optional corpus contains 60 licensed Open Images photographs and 30 authored text fixtures. Photographs cover 25 requested classes with ten each of baseline, absent target, small target, edge truncation, occlusion and repeated instances.20 photos/10 texts are development data;40/20 are reserved evaluation data. Public heldout does not guarantee exclusion from provider training.

Photo licenses and hashes are in benchmarks/corpus/ATTRIBUTION.md, licenses and manifests. Photo pixels and bulk CSVs are not shipped in npm or the source archive. Run the pinned fetch_photos.py script from benchmarks/corpus to obtain them; fetch_metadata.py acquires source CSVs for the independent audit. Image manifests use explicit human-verified negatives. Authored text cases are fixtures, not real customer traffic.

The benchmark is opt-in and must bound requests/costs before dispatch. Production library calls have no benchmark logger; a benchmark DecisionPort wrapper explicitly records input images, answers, errors and timing into an isolated run directory. The harness validates label files at startup; labels are used only by scoring and overlays after the corresponding producer results are recorded. They are never included in provider state, prompts, options or image filenames. Native classify uses a second call with the identical request; this tests wrapper parity and variance, not an expected accuracy gain. One/two-stage locate baselines reuse the exact successful prefix responses and are labeled correlated prefix ablations.

Metrics include classification accuracy/macro-F 1/confusion, errors in the denominator, any-instance point-in-reference-box, selected-region area, distance to reference boxes, negative false positives, p 50/p 95 and physical call/known/unknown costs. The point is the center of the selected cell for evaluation only, not a claimed object centroid. Bbox membership is a proxy and can include background; overlays and region sizes remain necessary. No all-instance recall is claimed.

Offline fixture tests validate mechanics only. Actual provider outcomes are recorded in [results](results.md), acceptance and the run reports. Keep failed and incomplete runs. Never silently retry errors, alter labels or discard difficult images to improve headline metrics.

## Current native Luna Decisions reproduction

For an independent fresh run of the selected non-Jev route, fetch the corpus, set your own `OPENROUTER_API_KEY`, then explicitly opt in:

```sh
node --import tsx benchmarks/model-selection.ts --allow-paid --fresh-native --out .run/luna-native-example
```

This caps admission at93 calls and$0.50:60 photos+30 texts, then at most three calls for one fixed positive locator smoke if classification meets the recorded target. It starts a new budget rather than importing the owner's historical runs. No retries/fallback or hidden key loading occur. The source-pinned snapshots in docs/evidence describe their original versions; future results can vary. Extension/completion flags in that script are historical budget-continuation tools and require the exact local earlier-run receipts; they are not needed for a fresh run.

## Historical Jev fixed-corpus runner

From the repository root, install development dependencies with `npm ci --ignore-scripts`. Fetch only the pinned public photo bytes, then run fixture mechanics:

```sh
python3 benchmarks/corpus/fetch_photos.py
node -e "require('node:fs').mkdirSync('.run',{recursive:true})"
node --import tsx benchmarks/run.ts --mode offline --split dev --limit 2 --out .run/offline-example
```

For a real run, set `OPENROUTER_API_KEY` in your shell/secret manager and explicitly opt in:

```sh
node --import tsx benchmarks/run.ts --mode live --allow-paid --max-calls 360 --max-cost-usd 1 --out .run/live-example
```

Each output directory must be new. The maximum is 60 × (two independent classifications + three locator calls) + 30 × two text calls = 360 provider calls; early absence can reduce it. No retries or resumes silently repeat paid requests. The runner stops further admission on budget exhaustion or evidence-write failure, keeps incomplete results, and exits unsuccessfully for an incomplete run. A completed run may still contain provider/model failures; those remain in accuracy denominators.

The budget reserves $0.02 before each request and retains that reservation for missing/invalid cost metadata. Current combined-context pricing gives a maximum input envelope of 262,144 × $0.000000042 = $0.011010048 per request; output tokens are free. See the [dated pricing snapshot](evidence/jev-pricing-2026-10-18.json), [provider context/pricing documentation](https://docs.typesafe.ai/models) and [OpenRouter image billing](https://openrouter.ai/docs/guides/community/multimodal-decisions). Recheck pricing before a future run. This is a local admission budget derived from published limits; it does not change the shared account's billing limits.

`manifest.json` pins source/corpus hashes and configuration. Per-case requests include public image data; receipts record validated answers or sanitized errors. A malformed answer rejected by the adapter is represented by its error, not silently repaired. `report.json` contains confusion matrices, failures, latency, known/unknown costs and all joined sample scores. Overlays show reference boxes and one/two/three-stage selected cells. Preserve raw evidence locally; share only reviewed public-corpus evidence.

The corpus README and validation report describe its frozen **pre-inference preparation**; measured model results live in this release's acceptance/report, not in that historical manifest.

## Protocol correction found during v1

The first live process is pinned to a pre-correction source snapshot: it rejected any probability sum farther than 1e-6 from 1. Two separate diagnostic replays captured an actual Jev 153-option response with sum 0.99 and a five-option response with unit mass. The release supports explicitly annotated quantization as described in the API; the exact 153-option response is covered by offline replay. The original live failures are retained and its metrics are not recomputed as successes. This correction changes response acceptance, not prompts, crops, argmax, geometry or model route. The release's complete future quality estimate still needs another frozen run; current figures describe the recorded v1 snapshot. The two diagnostic calls count toward the total call/cost accounting but not accuracy metrics.

The final corrected runtime smoke used `--mode live --allow-paid --max-calls 14 --max-cost-usd 0.1 --split dev --limit 2 --out .run/live-release-smoke`. Its 14 calls and the two diagnostic probes are accounted separately from the full run; neither is pooled into the original accuracy metrics.
