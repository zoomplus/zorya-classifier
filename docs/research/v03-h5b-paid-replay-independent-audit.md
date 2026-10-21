# H5b paid replay independent audit

Post-run evidence clarification: the historical trace sanitizer omitted separate `decision-trace` files for D/U aliases. Raw choices/distributions remain in the run rows, and the checks below verified physical receipts, source closure and output-mask provenance; they did not independently replay separate raw answer traces. This limitation does not change the measured mask scores or justify rerunning this rejected recipe. See the [subsequent transport diagnostic](v03-multi-image-reference-probe-audit.md) and the prospective bounded trace-schema repair for H6.

The closed H5b replay does not support advancing this profile to qualification. The pipeline selected a gate-passing same-source mask for 3/9 positive cases and returned a located result for all three negative cases. All 12 rows completed without runner errors; three positive rows ended `unknown` with `none-selected`.

| Positive stratum  | Same-mask candidate available | Passing candidate nominated | Passing mask selected |
| ----------------- | ----------------------------: | --------------------------: | --------------------: |
| Photo             |                           3/3 |                         3/3 |                   2/3 |
| UI                |                           3/3 |                         2/3 |                   1/3 |
| Map               |                           2/3 |                         1/3 |                   0/3 |
| **All positives** |                       **8/9** |                     **6/9** |               **3/9** |

The stage breakdown preserves where each loss occurred. `pilot-v03-map-02` had no same-candidate mask meeting the unchanged IoU ≥ 0.50 and reference coverage ≥ 0.90 gate. `pilot-v03-ui-03` and `pilot-v03-map-01` had passing candidates in the generated union but none among the nominated aliases. `pilot-v03-photo-03` nominated a passing candidate but ended with `none-selected`; `pilot-v03-ui-02` and `pilot-v03-map-03` selected masks that failed the same-mask gate. The counts describe this H5 pipeline at each stage; they are not standalone ranker accuracy claims.

All three absent-object cases (`photo-04`, `ui-04`, `map-04`) returned `located`, so negative handling was 0/3 correct unknowns and 3/3 false outputs. This DEV pilot is too small for qualification, but the observed positives and negatives do not justify advancing the current H5 replay profile. No threshold or truth changes were made.

The run completed all 12 rows with 32 physical calls and 32 logical calls on the pinned OpenAI route. Recorded cost was $0.0149639, with zero unknown-cost calls, zero in-flight calls, and no persistence failures. Per-row replay time summed to 115.9 seconds (median 9.7 seconds, maximum 20.3 seconds). Native generation time was recorded separately and summed to 42.3 seconds over the non-UI sources.

The independent verifier checked the run and pre-run freeze bytes, the executable-source closure, 288 frozen input artifacts, all 32 sets of provider admission/HTTP/receipt files against the run ledger and logical-call links, and the selected mask artifacts for all nine located positive and negative rows. Each selected output mask matched its nominated frozen source mask by SHA-256, dimensions, binary pixels, and source provenance. The verifier also checked the H5a, H3b, H4e, corpus, producer, and candidate-mask hashes before scoring.

| Lock                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| H5b run                   | `e97c61da98313e49525b43ff8efc89e6da76b16600a01dbde5674aefbb2a574a` |
| H5b pre-run freeze        | `356630a9dd3e2961fdddc94ac925977254f782b523f674609e86f62d05c93571` |
| Executable source closure | `b1eabe5e772e5f1136e0dd4dc7ee20ab22e1d97f40ad07db56d9dcbf0c8bb27b` |

The complete per-case stage scores, provenance checks, budget counters, and provider artifact hashes are in [the machine-readable evaluation](../../evidence/v03/h5b-paid-replay-independent-evaluation.json). Reproduce it after a closed run with:

```sh
PATH=/root/.nvm/versions/node/v24.12.0/bin:$PATH npx tsx benchmarks/v03/evaluate-h5-selection.ts \
  /root/work/zorya-classifier-runs/v03/h5b-grouped-masks-ba42dabb-588e-4721-bf39-816c79fd2eec \
  /root/work/zorya-classifier \
  docs/evidence/v03/h5b-paid-replay-independent-evaluation.json
```
