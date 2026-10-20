# Fresh independent development results

These frozen runs use 20 new licensed Open Images photographs and 10 controlled real Geany UI cases with an independent accessibility/pixel oracle. No heldout cases were inspected. The map stratum is separate and was not included in these 30-case runs. Classification and localization are separate requests; classification does not supply localization with a label.

| Variant                                                                           | Classification | Whole photos | Whole UI | False locations | Unknown / failed localization | Physical calls | Known USD / unknown costs |
| --------------------------------------------------------------------------------- | -------------: | -----------: | -------: | --------------: | ----------------------------: | -------------: | ------------------------: |
| [Numeric intervals](fresh-native-numeric/evaluation-root-v1.json)                 |          26/30 |         0/16 |      0/7 |             0/7 |                        15 / 6 |            124 |             0.0496704 / 6 |
| [Outlined seed and axis views](fresh-native-outline-axis/evaluation-root-v1.json) |          26/30 |         1/16 |      0/7 |             0/7 |                        14 / 8 |            124 |             0.0585901 / 8 |

A whole-object success requires both IoU ≥0.5 and visible reference coverage ≥0.9 for the same independently labeled instance. A returned fragment does not count. Every planned positive remains in the denominator, including unknown, not-found, provider error and timeout. Zero false locations alone does not establish useful localization.

Each directory retains the exact producer summary, frozen source/route/prompt manifest, independent evaluation and raw-file SHA256 values. Native routes use Luna Decisions/OpenAI with no retries or fallback. The unknown-cost reservation is USD 0.02 per physical request, giving accounted exposures of USD 0.1696704 and USD 0.2185901 respectively. A reservation is not a provider invoice.

Both runs occurred during concurrent development/native work; their timing is diagnostic and excluded from latency ranking. Neither result qualifies a production vision winner. Earlier successful Car examples and failed pilots remain in [the older development report](boundary-variants.md).

The next private diagnostic tests whether actual mask candidates can recover an entire object from the existing seed, then lets a closed decision select an actual candidate. Mask coordinates come from pixels. Ground truth is read only by a separate evaluator after durable predictions exist. Oracle-best candidate scores measure available potential, not end-to-end quality or a model selection success.
