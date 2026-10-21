# Independent H3c grounded-mask evaluation

The sealed H3c run completed and matched its pre-dispatch freeze. The run SHA-256 is `c2124d22cdddf6df2c370c040c5236fbe25a46375908abe71be4eb8a59f6be3b`; the freeze SHA-256 is `b2beb045e312d39d0c358138a2986e961e6c4925d45e5f5ce784c789865afe19`. The H3c profile lock passed, including the unchanged H3b selector hash and closed verifier source. The independent evaluator was run offline against the exact cohort and source images.

## Aggregate result

| Measure                                                              |                                                                          Result |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------: |
| Planned cases                                                        |                                                                              12 |
| Positive cases with valid complete output                            |                                                                           0 / 9 |
| Negative cases correctly returning `none`                            |                                                                           0 / 3 |
| Negative valid-complete outputs                                      |                                                                           1 / 3 |
| Final verifier verdicts                                              | 1 `match-complete-pure`, 3 `wrong-object-or-contaminated`, 6 `match-incomplete` |
| Unresolved or missing                                                |                                                                          9 / 12 |
| Physical calls / cap                                                 |                                                                         22 / 24 |
| Known cost                                                           |                                                                      $0.0062857 |
| Unknown-cost calls / in-flight calls / recorder persistence failures |                                                                       0 / 0 / 0 |

The one `match-complete-pure` output is on the verified-absent photo query `pilot-v03-photo-04`. Its final mask and cutout passed the independent artifact checks, but this is a false-complete negative and remains a quality failure. No positive query produced a qualifying output. The evaluator's fixed positive gate remains same-instance whole-box IoU ≥0.50 and reference coverage ≥0.90 on a valid completed final output.

The [full evaluator JSON](../evidence/v03/h3c-grounded-mask-selection-evaluation.json) contains all 12 case rows, dispositions, costs, verifier verdicts, and lock hashes. It was generated with evaluator commit `0ff44e7` using the explicit Node 24 runtime and the frozen corpus image root.

## Retained-mask diagnostic: photo 02

`pilot-v03-photo-02` selected candidate `C00` and persisted a verifier-view mask, but the final row is `status: unknown`, `finalVerifierVerdict: match-incomplete`, and has no cutout. It therefore remains a missing/non-location output in the main score. Separately inspecting that retained mask does not promote it to a delivered result.

The retained mask has SHA-256 `1680deae5eda207cc9b5958dd2fb08864e7987fd8065284a754e2a2909654db3`. Its decoded 1024×683 pixels are exactly equal to the frozen native `C00` mask pixels (the PNG byte hashes differ because the files are encoded differently). Against the independently pinned reference mask, its pixel IoU is `0.902043` (23,666 intersection pixels; 23,755 predicted; 26,147 reference). Its pixel-derived box `(357, 227, 342, 223)` has IoU `0.953923` and reference-box coverage above `0.90` against the authored positive box. This establishes a real verifier-versus-mask diagnostic discrepancy: the H3c verifier rejected an actual mask that passes the geometric gates and has high reference-mask overlap. It does not establish why the verifier called the object incomplete, nor override that final verdict.

## Reproduction

```sh
PATH=/root/.nvm/versions/node/v24.12.0/bin:$PATH node --import tsx benchmarks/v03/evaluate-grounded-mask-selection.ts \
  --run /root/work/zorya-classifier-runs/v03/h3c-grounded-masks-a5fc42c6-c069-4b30-a0a2-dbf7938c6589 \
  --run-sha256 c2124d22cdddf6df2c370c040c5236fbe25a46375908abe71be4eb8a59f6be3b \
  --freeze-sha256 b2beb045e312d39d0c358138a2986e961e6c4925d45e5f5ce784c789865afe19 \
  --image-root /root/work/zorya-classifier-worktrees/v02/corpus \
  --output /tmp/v03-h3c-eval.json
```

The command makes no provider calls. The retained-mask diagnostic was separately decoded from the closed run and compared with the freeze-pinned native candidate and reference mask.
