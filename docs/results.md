# Recorded model results

This report is historical evidence for the optional Jev integration. Current native Luna Decisions and ordinary vision model comparisons are in [tested models](vision-results.md); these figures do not qualify a different backend.

These are measured outcomes, including mistakes and failures. They are not a claim that the wrapper improves Jev's classification accuracy, that photographic accuracy transfers to games, or that a selected cell is a segmented object.

## Full corpus: live-v1

The run completed on 2026-10-17 UTC with the source hashes in the [manifest](evidence/live-v1-manifest.json). It used the original strict probability-sum validator. The [complete report](evidence/live-v1-report.json) retains every sample, split, error, timing and joined ground-truth result. Corpus preparation and attribution are described in [benchmarks](benchmarks.md).

The corpus contains 60 licensed photographs (20 dev / 40 heldout; 25 requested object classes) and 30 authored text-intent fixtures (10 dev / 20 heldout). The text fixtures are not real customer conversations. Public heldout can overlap provider training; it was only held out from local development. There was no independent human re-annotation or perceptual duplicate audit.

| Classification        | Library         | Independent native Jev Choice |
| --------------------- | --------------- | ----------------------------- |
| Photographs correct   | 55/60 (91.67%)  | 55/60 (91.67%)                |
| Photograph macro-F1   | 0.84367         | 0.84367                       |
| Text fixtures correct | 30/30           | 30/30                         |
| Photograph p50 / p95  | 2.835 / 4.287 s | 2.615 / 3.804 s               |
| Text p50 / p95        | 0.283 / 0.323 s | 0.293 / 0.333 s               |

Photo presence classification: TP 48, FN 2, TN 7, FP 3. Dev 18/20, heldout 37/40. Text dev 10/10, heldout 20/20. The chosen class agreed across all 90 library/native pairs. The native baseline makes a separate provider call with an identical request; it is not a copied answer. Values can vary between calls.

## Locator and stage trade-off

A positive hit means the **selected cell's center** lies in at least one annotated bounding box. This evaluates an area hypothesis, not the object's center or segmentation; a source bounding box can include background. Multiple matching instances are allowed. Prefix results reuse the same stage answers and are correlated ablations without the final candidate check.

| Metric                                  | First-stage prefix | Two-stage prefix  | Full three stages |
| --------------------------------------- | ------------------ | ----------------- | ----------------- |
| Successful, including correct negatives | 46/60              | 31/60             | 27/60             |
| Hits over all positive photos           | 39/50              | 24/50             | 20/50             |
| Protocol failures                       | 1                  | 22                | 23                |
| Unknown outcomes                        | 0                  | 0                 | 7                 |
| False coordinates on absent targets     | 3/10               | 2/10              | 1/10              |
| p50 / p95                               | 5.189 / 7.437 s    | 11.654 / 18.930 s | 13.642 / 22.229 s |
| Median selected image-area fraction     | 6.25%              | 0.418%            | 0.513%            |

For the full locator, 20 of 21 returned regions on positive photos hit a reference box. That conditional 95.24% excludes failures and abstentions; the result over **all 50 positives is 20/50**. Do not market the conditional percentage as overall accuracy. A larger first-stage region can achieve easier containment and does not offer the same spatial granularity.

| Stratum (10 photos each) | Classification correct | First stage success | Two stages | Three stages |
| ------------------------ | ---------------------- | ------------------- | ---------- | ------------ |
| Baseline                 | 9                      | 10                  | 4          | 2            |
| Repeated instances       | 9                      | 9                   | 6          | 5            |
| Edge truncation          | 10                     | 9                   | 8          | 7            |
| Absent target            | 7                      | 7                   | 7          | 7            |
| Occlusion                | 10                     | 8                   | 4          | 3            |
| Small target             | 10                     | 3                   | 2          | 3            |

## Protocol correction and final smoke

All 321 full-run HTTP responses were 200, with no timeouts. The strict adapter rejected 23 answers (`INVALID_RESPONSE`: stage 1 = 1, stage 2 = 21, stage 3 = 1). Their original raw rejected bodies were not saved. Therefore the cause of every rejection cannot be established retrospectively.

Two later diagnostic calls on saved request inputs produced one 153-option response whose 0.01-rounded values sum to 0.99, and one valid five-option response. They are new independent responses, not recovered original failures. The final adapter preserves raw scores and accepts only explicitly annotated quantization whose half-step intervals admit unit probability mass. No prompts, crops, rankings or geometry were changed. The exact 153-option response is covered by a regression. See [API](api.md) and [probe evidence](evidence/protocol-probes.json).

The final corrected runtime then completed a separate [smoke run](evidence/live-release-smoke-report.json): 2 dev photos + 2 dev texts, 14 HTTP calls, zero protocol failures. Photo classification was 1/2 for both library/native, texts 2/2 for both; localization returned one valid box hit and one `unknown`. This checks the corrected integration, **not a new full-corpus accuracy estimate**. The old failures remain unchanged. A full final-version quality benchmark remains future work within an explicitly funded run.

## Calls, route and cost

| Run               | HTTP calls | Known reported cost | Calls with unknown cost |
| ----------------- | ---------- | ------------------- | ----------------------- |
| Full live-v1      | 321        | $0.073546662        | 23                      |
| Diagnostic probes | 2          | $0.001420734        | 0                       |
| Final smoke       | 14         | $0.004080510        | 0                       |
| Total             | 337        | $0.079047906        | 23                      |

Adding the local $0.02 reservation for each unknown-cost call gives accounted exposure **$0.539047906**, not the actual final provider bill. The aggregate remains within the authorized 360-call / $1 diagnostic envelope. Local reservations do not enforce an account-wide spending cap.

The 298 accepted full-run responses and all 14 smoke responses report `typesafe/jev-1.14-20261014` / TypeSafe; the adapter requests `typesafe/jev-1.14`, only TypeSafe, without fallback/retry. The two probes also used the fixed route. Missing metadata is never silently assumed to prove routing or zero cost. Pricing was checked against the [dated primary-source snapshot](evidence/jev-pricing-2026-10-18.json).

Latencies include image preparation and benchmark artifact writes; measurements of the HTTP response headers alone are stored separately. They are not a service-level guarantee or evidence of sub-second localization.
