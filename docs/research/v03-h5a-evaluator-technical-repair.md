# H5a evaluator technical repair

The original H5a evaluation artifact remains preserved at `docs/evidence/v03/h5a-native-proposal-availability-evaluation.json`. Review found that its representative per-candidate score selected the reference instance with the highest IoU, then applied the coverage threshold to that instance. For multi-instance truth, another reference can satisfy both unchanged thresholds even when it has lower IoU.

The evaluator now uses the existing `wholeObjectMatch` result and prioritizes any instance that satisfies both IoU ≥ 0.50 and reference coverage ≥ 0.90. When no instance passes, it retains the highest-IoU instance for diagnostic reporting. A regression fixture covers the case where the highest-IoU instance fails coverage but a second instance passes.

Re-evaluation of the frozen H5a run did not change any candidate availability decisions, family aggregates, or the 8/9 positive union result. The corrected per-candidate score detail is preserved separately in [the technical-repair evaluation](../evidence/v03/h5a-native-proposal-availability-evaluation-technical-repair-v1.json); the original report and its hash are unchanged.
