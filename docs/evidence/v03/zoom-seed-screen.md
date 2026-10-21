# H1 overlapping zoom: rejected DEV screen

Run: `zoom-seed-pilot-2026-10-21T074242415Z-1620b48e`, completed 2026-10-21. This measures seed-region intersection, not object boxes or masks. There were twelve paired cases, three positives and one verified negative per photo/UI/map stratum. All twenty-four recipe executions completed; none failed or was dropped. The producer source hashes stayed unchanged during dispatch.

| Seed metric            | v0.2 presence + original region locator | Four overlapping zoom crops + original crop locator |
| ---------------------- | --------------------------------------- | --------------------------------------------------- |
| Positive hits          | 5/9                                     | 4/9                                                 |
| Photo hits             | 2/3                                     | 1/3                                                 |
| UI hits                | 0/3                                     | 0/3                                                 |
| Map hits               | 3/3                                     | 3/3                                                 |
| Negative false regions | 0/3                                     | 1/3                                                 |

The candidate did not improve the fixed sample and returned a false region on the absent map target. It will not be promoted or added to H2c. There is no justification for a larger run of the same recipe. The old classifier gate and zoom branch differ in more than cropping, so this is a recipe comparison, not a causal estimate of magnification alone.

Both recipes used explicitly configured OpenAI Luna Decisions through the same native categorical-presence wrapper. There were 88 physical requests, $0.049428 known cost, zero unknown-cost receipts and zero remaining in-flight calls, within the predeclared 96-call/$5 envelope. Calls were serial with alternating recipe order per case. Concurrent research elsewhere on the host/provider makes these timings diagnostic, not a performance ranking.

Ignored raw evidence is under `.run/v03/zoom-pilot/zoom-seed-pilot-2026-10-21T074242415Z-1620b48e/`, including immutable run manifest, per-case results, physical admissions/receipts, request traces, summaries and seed evaluations. Source input JSONs were formatted and repinned only after the run closed; parsed rows, order, targets and image hashes did not change. The manifest preserves the exact pre-format producer/input identities. There were no segmentation or whole-object results in this screen.
