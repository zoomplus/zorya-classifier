# H2c paired end-to-end semantic mask screen

**Decision: reject H2c as an accuracy improvement.** The five-photo H2b probe showed that semantic selection could choose a better native mask when given a useful seed. That gain did not survive the full pipeline on the frozen DEV12 cohort. Both the v0.2 control and the semantic-mask candidate returned a correct whole-object result in only 1/9 positive cases.

## Fixed recipe and results

The candidate preserved the existing locator, sampled four MobileSAM masks at the seed center, selected one through the injected Luna Decisions/OpenAI route, and retained the independent whole-box check. Labels occupied an added margin, repairing the earlier H2b presentation defect. The control retained the existing native sampling and selection. Inputs, negatives, whole-box thresholds and reference masks were unchanged. Model weights and provider selection remained explicit benchmark inputs.

| Measurement                                   |    v0.2 control | H2c semantic selection |
| --------------------------------------------- | --------------: | ---------------------: |
| Planned cases                                 |              12 |                     12 |
| Correct whole-object boxes, all positives     |             1/9 |                    1/9 |
| Photos / UI / maps                            | 1/3 · 0/3 · 0/3 |        1/3 · 0/3 · 0/3 |
| Seed intersections, all positives             |             5/9 |                    5/9 |
| Extracted masks, correct or incorrect         |               4 |                      3 |
| False boxes/cutouts, negatives                |             0/3 |                    0/3 |
| Independent masks with IoU >=0.80             |             0/1 |                    0/1 |
| Physical provider calls                       |              51 |                     53 |
| Known provider cost, USD                      |       0.0225903 |              0.0252807 |
| Unknown charges / in-flight requests at close |           0 / 0 |                  0 / 0 |

All 24 planned rows were retained. There were no invalid mask artifacts, invalid result rows or cleanup errors. Missing mask predictions remained zero in the independent-mask denominator. Classification alone was insufficient: some absent queries were classified as present, although neither profile ultimately emitted a false box or cutout on the three negatives. Three negatives cannot establish a low general false-positive rate.

Diagnostic case latency was p50/p95 12.938/44.811 seconds for the control and 14.847/95.349 seconds for H2c. These include provider variability and concurrent native work; they are not a controlled performance comparison. Total known provider cost was USD 0.047871 across 104 physical calls.

## Frozen evidence and evaluator repair

Raw evidence is preserved under ignored `.run/v03/semantic-pilot/semantic-segmentation-4af06564-1ce9-4c53-a8be-003422bb3154`. Its `summary.json` SHA-256 is `f5be08ab905a8cf962507c1c83602a7ed1f0ab1d0d8bf1e07910facec5a1b6e8`; the 58-file producer closure SHA-256 is `a8401530e1fd5f6e1eb243886b74c57108c429aef95f5731635c43731a7b3c97`. The post-run source check matched. `baseline/evaluation.json`, `semantic/evaluation.json` and `paired-evaluation.json` were written after closure from persisted rows and actual mask pixels. Physical dispatch records, admissions, receipts, budgets and zero in-flight requests were cross-checked independently.

The evaluator initially rejected the existing frozen reference-mask policy because its wording contains “to the acquired” rather than “to acquired”. A narrow parser repair accepts the optional article; a regression using the actual frozen policy fails before and passes after the repair. No reference bytes, annotations, producer outputs or numerical thresholds changed. The failed evaluation and its regression logs remain preserved.

## Implication

Better mask ranking alone cannot recover an object when the initial seed is wrong or the useful object mask is absent. H2b remains evidence for that isolated mechanism, not evidence of end-to-end accuracy. Continue with the separately planned H3 text-conditioned proposals and H4 UI proposals; do not promote H2c as a better default. These twelve exposed cases are a development screen, not independent qualification.
