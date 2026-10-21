# Checked-region DEV v3 candidate-only evaluation

This report is an independent evaluation of the completed 40-case DEV candidate run against the frozen DEV truth. It is candidate-only evidence, not a paired gate verdict or release qualification. The control run is retained but was not scored against the original pair because its run identity does not match the pre-dispatch variant digest; see `control-identity-failure.json`.

The evaluation preserves the full 40-case denominator: 30 positive and 10 verified-negative cases across the 20-photo, 10-controlled-UI, and 10-controlled-map strata. Classification, seed-cell overlap, mask-derived whole-object boxes, visible-box checks, and reference-mask IoU are reported separately. A seed-cell intersection is only a coarse search proxy and never counts as whole-object localization. The UI and map cases are controlled captures from one app/game family each, not natural user captures or evidence of broad application/game diversity.

The candidate used the frozen OpenAI GPT-6 Luna route with no fallback, the existing presence-first gate, full-source MobileSAM seed-region segmentation, and up to two closed visible-box containment checks. The report retains unknown, not-found, and failed outcomes in every denominator. The 7 available reference-mask instances are scored independently: 4 were comparable on the exact canvas, 1 met IoU 0.8, and 3 were unavailable. This does not imply universal cutout accuracy.

The report records hashes for the freeze, producer source closure, all input and truth files, candidate raw manifest/summary/seal, and the independent evaluator output. It contains aggregate metrics only; it does not publish case-level outcomes, image paths, image pixels, masks, or provider credentials.
