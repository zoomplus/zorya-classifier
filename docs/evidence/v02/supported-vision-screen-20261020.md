# Supported vision screen: independent evaluation

This is a 20-photo DEV screen, not the full 40-photo DEV gate. Both routes are closed and were evaluated independently after the final run seal. Accuracy is the primary comparison; latency is unranked because the screen ran during the concurrent resource soak. Neither route qualifies for winner freeze or heldout evaluation from this screen alone.

## Frozen inputs and outputs

| Artifact                                  | SHA-256                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| Run manifest                              | `b97b44e9640ab37ae7269e24a91df4c84ba4b8e1c6f2ad0189440c0052ee0208` |
| Screen controller                         | `6442a38e24e51eefc12cf8e88bc21acf78f9723bb881c2c53bb8d1f735251c6b` |
| Final pair seal                           | `1e13039fd12cb136df5ab1f69475b627b368e4f76296cf82ad42121d89b367ec` |
| DEV photo inputs                          | `6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a` |
| Independent photo truth                   | `793e26845deaa2cb56748ef270b8cb02877218d680068573f02e5af92b26af6a` |
| Qwen profile summary                      | `a14b1d56a14e65337daa8080bbdbfd356e0096f25d8cb7165e95f6764a37ab9d` |
| GPT-6 Sol profile summary                 | `16304c8e8363dce36399c585c6831f3bc46fb3ed2e86ae93a4024e3597edd1ac` |
| Independent aggregate evaluation          | `df7450f763753aea2b2e1c93a1015967065d3b6a722723b47a039444ae19f721` |
| Sol per-reference box IoU/coverage detail | `c332f6583b842ca9152784ef38a794a41a0b95d092d30de41b8eff57a28bedf6` |

The evaluation verified the exact raw hashes, source file hashes, receipt ledgers, route completion markers, budgets, case IDs, input image hashes and truth hash. Producer source HEAD changed from `a6c2683af6615e5496fec449abb3f27f91d86050` to `03b8febe01cb242a23d87a50e0a7932915c7dfce` across a clean documentation-only change; all pinned producer source hashes remained unchanged. The pair made 166 physical calls at known cost `$1.717302148`, with zero unknown charges and zero in-flight calls. Latency ranking was disabled.

## Whole-object and classification results

All 20 cases were reported for each route: 16 positive photos and 4 verified negatives. The whole-object match rule requires both IoU ≥ 0.5 and visible-reference coverage ≥ 0.9 for the same instance. Classification is reported separately.

| Route                                                 | Classification | Positive whole-object matches | Negative false locations | Other localization outcomes                                                |
| ----------------------------------------------------- | -------------: | ----------------------------: | -----------------------: | -------------------------------------------------------------------------- |
| Qwen 3.7 Flash / Alibaba, JSON object, reasoning none |          19/20 |                          0/16 |                      0/4 | 19 `INVALID_RESPONSE` failures and 1 unknown; no positive box was returned |
| GPT-6 Sol / OpenAI, JSON schema, reasoning none       |          19/20 |                          6/16 |                      2/4 | 7 unknowns, 1 correct negative `not-found`, 0 transport/protocol failures  |

For GPT-6 Sol, the best reference-instance values for positive cases with returned boxes were:

| Case                        | Best IoU | Visible-reference coverage | Match   |
| --------------------------- | -------: | -------------------------: | ------- |
| `photo-dev-present-01`      |   0.8767 |                     0.9890 | Pass    |
| `photo-dev-present-02`      |   0.6855 |                     0.9787 | Pass    |
| `photo-dev-present-03`      |   0.3280 |                     0.3280 | Fail    |
| `photo-dev-present-04`–`06` |        — |                          — | Unknown |
| `photo-dev-present-07`      |   0.9629 |                     0.9636 | Pass    |
| `photo-dev-present-08`      |   0.0728 |                     0.1618 | Fail    |
| `photo-dev-present-09`      |   0.9762 |                     0.9762 | Pass    |
| `photo-dev-present-10`      |   0.4786 |                     0.4866 | Fail    |
| `photo-dev-present-11`–`12` |        — |                          — | Unknown |
| `photo-dev-present-13`      |   0.8753 |                     0.9900 | Pass    |
| `photo-dev-present-14`      |   0.9888 |                     0.9888 | Pass    |
| `photo-dev-present-15`      |   0.5477 |                     0.5477 | Fail    |
| `photo-dev-present-16`      |        — |                          — | Unknown |

The two false locations were on negative cases `photo-dev-absent-02` and `photo-dev-absent-04`; `photo-dev-absent-01` was unknown and `photo-dev-absent-03` was correctly not found. The complete per-instance box overlaps, including secondary reference instances, are retained in the pinned detail artifact above.

The negative labels remain the original frozen target categories. Two examples are semantically adjacent: the `Tree` negative shows a close-up plant fruit with a foreground trunk or stem, and the `Bowl` negative shows egg-shaped tableware. These are retained unchanged; the false-location count is specific to the authored target classes and should be interpreted with that ambiguity in mind.

## Extraction masks

The independent truth contains masks for 5 of 20 photos, covering 7 reference instances. Mask IoU uses a separate ≥ 0.8 threshold and does not follow from a correct box.

| Route          | Scored annotated cases | Scored reference instances | Instances passing IoU ≥ 0.8 | Other mask results                                                         |
| -------------- | ---------------------: | -------------------------: | --------------------------: | -------------------------------------------------------------------------- |
| Qwen 3.7 Flash |                    0/5 |                        0/7 |                           0 | All 5 annotated cases unavailable; route returned no extractable masks     |
| GPT-6 Sol      |                    4/5 |                        6/7 |             2/7, in 2 cases | One annotated case unavailable; mean IoU across 6 scored instances: 0.4131 |

GPT-6 Sol's scored reference-instance IoUs were 0 and 0.0002 for case 08; 0.9462 for case 09; 0.8041 for case 13; and 0.0048 and 0.7229 for case 15. Fifteen cases were unannotated and are excluded from mask-quality denominators.

## Interpretation

This screen establishes only these exact route outcomes on the pinned 20-photo DEV set. Qwen classification was mostly correct, but its object stage produced 19 response failures. GPT-6 Sol had better whole-object and mask results in this sample, with two false locations and seven unknowns; these results do not establish universal model superiority or monotonic gains from model strength. Full 40-case DEV, the remaining independent UI/map strata, resource/platform gates and a new winner freeze are still required before heldout evaluation.
