# SCREEN v2 terminal evaluation

This is a closed diagnostic of the 20-photo DEV SCREEN, not the 40-case DEV gate. The route pair did not complete, so this result is not a paired comparison and does not qualify a model or release. The Luna route completed all 20 cases; the Qwen/Alibaba route stopped after repeated HTTP 404 route errors and has no vision-accuracy score.

The independent evaluator scored every planned Luna case. Classification was correct on 19/20. Whole-object localization matched 0/16 positive boxes; the four negative cases produced one `not-found`, two `unknown`, and one `INVALID_RESPONSE`. Across all 20 localization outcomes there were 16 `TIMEOUT`, two `unknown`, one `INVALID_RESPONSE`, and one `not-found`. Thus the localization result is 0/16 positive successes, not a reduced denominator that drops failures.

Five photo cases had independent mask references, covering seven reference instances. None had an extracted mask to score: 0/7 reference instances reached IoU scoring, all five annotated cases were unavailable, and the other 15 cases were unannotated. This is missing model output, not evidence of poor or successful mask overlap.

The Luna route recorded 82 physical calls, 15 calls with unknown receipt cost, and USD 0.04574247 known cost. The full screen ledger recorded 157 admissions, USD 0.073623795 known cost, 59 unknown-cost calls, and two unsettled admissions. Durations are retained for diagnosis only: this run overlapped the native resource soak, so latency is not rankable. The producer’s legacy “before resource soak” label is preserved in its raw summary and corrected only in this interpretation.

The pinned artifacts are:

- Controller: `fa45f27b9b89b7106be27afc1c4499f68227ae3516b39d13c3d33cb2d9fd399e`
- Run manifest: `f95baf177904af0da6cc54ee7d97f9eef28dfc47e1e3d8340700cbc0f6e7ea4e`
- Input manifest: `6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a`
- Independent truth: `793e26845deaa2cb56748ef270b8cb02877218d680068573f02e5af92b26af6a`
- Luna raw summary artifact: `cc181cfcca886d940d2c507448a5fc78aaaa88be01b487e08856043dfbf0f052`; canonical summary digest: `e4cf9071a4f257b4d8f59164bd6a558868ec069820ee802a8ec5624c7a6da591`
- Luna completion marker: `16d8c19a72966b129765ce95c1323402b3782c5f332ebde81df5ed8a05db772e`
- Terminal evidence: `ca016f53da941c66f33d58a444eb23d038be3f9930321fdfece9c1d9db71d4f3`
- Independent evaluation: `cc49adaa9e07c0c6140eb32cb8607fc03e67a02cbdfbb8a8647ec4d77e5c4e72`

The evaluation output is preserved in the ignored run cache. The raw provider outcomes and incomplete Qwen ledger remain unchanged. No held-out data was opened.
