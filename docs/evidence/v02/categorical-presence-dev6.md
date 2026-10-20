# Categorical-presence split-port DEV6 pilot

The run completed all six exposed development cases, but it fails the predeclared pilot gate for moving to a full DEV40 run. The gate required at least one correctly located positive and zero false locations among four negatives. There were **0/2 positive locations**, so the candidate is not eligible for full DEV40.

The independent classification score was **4/6** (2/2 positives and 2/4 negatives); two negative cases were classified present. All six whole-object location results were `unknown`; no box or mask was returned. Thus the run provides no measured box or cutout accuracy.

The run used 39 physical calls at a reconciled known cost of **$0.239192**, with no unknown-cost or in-flight calls. Latency was marked unranked. This was a six-case DEV pilot, not a release or heldout result.

| Case                 | Truth   | Classification    | Locate  | Reason                 |
| -------------------- | ------- | ----------------- | ------- | ---------------------- |
| photo-dev-present-01 | present | present (correct) | unknown | extent-uncertain       |
| photo-dev-present-02 | present | present (correct) | unknown | uncertain-presence     |
| photo-dev-absent-01  | absent  | absent (correct)  | unknown | candidate-union-empty  |
| photo-dev-absent-02  | absent  | present (wrong)   | unknown | extent-uncertain       |
| photo-dev-absent-03  | absent  | absent (correct)  | unknown | candidate-union-empty  |
| photo-dev-absent-04  | absent  | present (wrong)   | unknown | contradictory-evidence |

Raw producer artifacts are unchanged. The JSON evidence includes both the canonical summary digest sealed by the run marker and the pretty-file digest, plus the run manifest, completion marker, selected-input, parent-cohort and DEV-truth pins. No producer truth, queries or outputs were rewritten.
