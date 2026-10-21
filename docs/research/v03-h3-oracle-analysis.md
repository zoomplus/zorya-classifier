# H3 candidate-availability oracle analysis

This evaluator measures whether the frozen H3 GroundingDINO-T + SAM2-Tiny run produced any mask candidate whose source-pixel foreground box could satisfy the existing DEV12 whole-object rule. It is an offline, evaluator-only ceiling analysis. It does not change or relabel H2c production outcomes, does not select a candidate for production, and does not turn candidate availability on a negative into a false-positive localization.

## Frozen input and output boundary

The evaluator consumes the existing opaque DEV12 producer manifests, the completed H3 `run.json`, its per-case JSON rows, and the referenced source-canvas mask PNGs. It verifies the run cohort/schema, pinned manifest hashes and IDs, H3 source-freeze identity, each case row receipt, each input image SHA-256 and dimensions, each detector box, and every mask SHA-256 before scoring. Rows for all twelve planned cases are emitted even when the run or an individual worker failed, timed out, was truncated, emitted zero candidates, or lacks a row. Invalid or missing mask artifacts remain explicit errors and cannot contribute a match.

Ground truth is opened only after run closure and joins by opaque `caseId` and source image identity. Producer labels, targets, paths, or model scores never determine which reference instance is evaluated. No H3 output is sent back to the producer or used to edit the frozen run.

## Oracle-ceiling metrics

For each candidate, decode the actual 8-bit grayscale PNG and derive its binary foreground bounds on the original source canvas. Validate exact source dimensions, binary values, nonempty foreground, path containment, and the recorded mask hash. Do not trust `mask_box_xyxy` as the source of geometry; compare it with the decoded-pixel bounds as a consistency check. Candidate detector boxes are retained as a separate diagnostic and are never substituted for mask-derived bounds.

For each positive case, report (1) whether any mask-derived box passes the fixed whole-object condition against one same-instance reference—IoU >= 0.50 and reference-box coverage >= 0.90, (2) each candidate's standalone maximum box IoU, and (3) maximum pixel mask IoU against the independently pinned reference mask when one exists. Report detector-box IoU separately as a diagnostic. Missing masks, errors, timeouts, and zero candidates produce no match and remain in the nine-positive denominator. For a negative case, report candidate count and worker status only; candidate existence is not a final false positive because no selection/localization policy was run.

The ceiling is an optimistic availability upper bound: it assumes a perfect downstream selector can choose a matching mask when one exists. It is not a production prediction or a paired recipe score. Report raw per-case candidate values and photo/UI/map stratum counts beside the overall 9-positive/3-negative totals. Do not use bootstrap or significance claims on this twelve-case diagnostic.

## Validation and tests

Focused tests cover actual PNG pixel decoding and foreground bounds, exact source-canvas geometry, descriptor mismatch, hash mismatch, failures and missing rows in the full denominator, zero candidates, negative candidate reporting without false-positive conversion, and mask-reference IoU. The evaluator reads decoded source-canvas pixels rather than trusting a producer-supplied bounding box, and imports no producer code.

## Closed-run DEV12 diagnostic

The corrected run closed with all 12 cases complete. Its external `run.json` SHA-256 is `df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401`; the pinned producer and environment-freeze hashes are `7695cb42cd6e4e583f6cb5bab08d93d40c18d08c188651948b4fed0b43fdc8b5` and `b4f15b3a61228eb660a26e78c88684f7a448624461f3241feb56780de40cac2f`. The evaluator output, including each candidate's detector box, pixel-derived mask box, box scores, and artifact validation, is [v03-h3-grounded-proposals-run-02.json](v03-h3-grounded-proposals-run-02.json).

Five of nine positive cases had at least one candidate mask whose pixel-derived box met the IoU >= 0.50 and coverage >= 0.90 condition (55.6%). Availability was 3/3 photos, 0/3 UI, and 2/3 maps. All 12 worker rows were complete; there were no zero-candidate cases or truncations. All three negatives had candidates, 20 in total; these are availability counts and not false-positive judgments. One positive has an independent mask reference: its best candidate mask IoU was 0.902. The other eight positives have no independent mask reference in this pilot.

This is a candidate-availability ceiling, not a selected-output score. The strong photo/map availability and zero UI availability suggest that any downstream H3b benefit will be highly stratum-dependent; the UI cases provide no candidate capable of meeting the whole-object gate. Do not infer the final production score from this ceiling.

The first closed attempt remains a separate technical failure record: `grounded-proposals-h3-run-01` had all 12 cases recorded as errors before inference, and its `run.json` SHA-256 is `b5bd4e12264a620ebdfb783a70f6d0a4a064c9fdc701d717664ce9464005ea0d`. It was excluded from the corrected-run performance metrics and retained as failure evidence.

The exact evaluation command used the source/cache root that holds the pinned reference raster:

```sh
node --import tsx benchmarks/v03/evaluate-grounded-proposals-pilot.ts \
  --run /root/work/zorya-classifier/.run/v03/grounded-proposals-h3-run-02 \
  --run-sha256 df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401 \
  --image-root /root/work/zorya-classifier-worktrees/v02/corpus \
  --output /tmp/v03-grounded-proposals-h3-evaluation.json
```
