# Region-seeded v3 heldout evaluation

The independent evaluator passed every predeclared heldout admission criterion for the frozen region-seeded candidate. This is a pass for this specific benchmark gate, not a broad accuracy guarantee or a release approval.

The candidate answered all 80 classification calls: 65 were correct (81.25%). Localization was substantially weaker: 8 of 60 positive cases met the frozen mask-derived box criterion (IoU at least 0.5 and reference-box coverage at least 0.9). It produced 16 extractions overall; 35 cases remained unknown, 27 were not found, and 2 failed. There were no false seed locations or extractions among the 20 negatives.

Seed proposals and object localization are separate results. The candidate located a seed on 26/60 positive cases; all 26 cells intersected an independently annotated target box, and none landed on a negative. For the 30 photo instances with exact-canvas masks, 20 seed cells intersected reference foreground. The coarse box-intersection measure is only a proposal proxy; it is not whole-object success. Across the same 30 positive photo cases, the frozen 10,000-resample paired comparison gave a candidate-control difference of 0.667 for both coarse box intersection and exact-mask foreground seed hits. Each 95% interval was [0.500, 0.833] using seed `0x5a4f5259`.

There were 30 exact-canvas photo mask references. The candidate produced masks for 11, of which 8 reached IoU 0.8 and 3 did not; 19 references were unavailable because no predicted mask was produced. The UI and map strata have no independent pixel-mask references, so they do not contribute mask scores.

The 80-case corpus contains 40 official-photo cases, 20 controlled Calculator UI cases, and 20 controlled Wesnoth map cases. UI and map results represent one controlled application family and one game family each. They should not be read as evidence of broad app or game diversity. The no-image control answered 20/80 classifications correctly and returned no seed locations; all 80 actual provider fetches were independently verified to contain no image parts.

## Frozen inputs and run receipts

The evaluation summary lists the exact freeze, input-manifest, truth-array, producer-source, run-manifest, raw-summary, and completion-seal hashes. Candidate and control each completed all 80 planned rows without changing the frozen producer source. Candidate cost accounting records 266 physical calls, $0.1052095 known cost, and two unknown-cost calls ($0.2052095 including the frozen reserve); 264 responses were HTTP 200 and two were HTTP 502 provider errors. Control used 80 HTTP 200 calls, with $0.001617 known cost, no unknown charges, and verified zero image parts.

All raw failures remain in the denominators. No case was removed, relabeled, or selected after seeing outcomes.

The first evaluator attempt stopped at truth-schema parsing before scoring: frozen reference-mask entries omit redundant byte-count metadata. A narrow evaluator-only compatibility change now allows that field to be absent while applying a bounded file read and retaining raw SHA, canvas dimensions, exact geometry, and binary-pixel validation. If a byte count is present, it must match exactly. The frozen truth files and hashes were not changed. The fix and regressions are in evaluator commit `77c84facb0edc95b3e5f0904a011e33856094d9f`.
