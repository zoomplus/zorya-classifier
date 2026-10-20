# Split Choice/NoUL DEV6 pilot evaluation

This is an independent evaluation of the frozen six-case DEV pilot for the caller-owned split Choice/NoUL route. It is a pilot only; it does not qualify the variant for the full 40-case DEV run.

The producer completed all six planned cases. Classification was correct on 4/6 cases (66.7%). Whole-object localization succeeded on 0/2 positive cases: one returned `unknown` with `extent-uncertain`, and one returned `not-found`. There were 0 false locations on the four verified negatives; one negative localization failed with `INVALID_RESPONSE`, and the other three returned `not-found`. No extraction mask was produced, so this pilot provides no mask-quality result.

The predeclared pilot gate required at least one correct positive whole-object localization and zero false locations on the four negatives. The negative condition passed, but the positive condition failed. The variant was therefore ineligible for the full 40-case DEV run. All producer failures and costs remain included in the counts.

The producer closed with 26 admitted physical calls, $0.1424405 known cost, one call with unknown cost covered by the $0.05 reserve, and zero in-flight calls. Its configured limits were 100 calls and $5.

Hashes, case-level outcomes, and the exact gate verdict are recorded in [split-choice-noul-dev6.json](split-choice-noul-dev6.json). The JSON contains hashes for the producer summary, run manifest, completion markers, variant, controller, runner, split-port implementation, evaluator source, DEV inputs, and DEV truth.
