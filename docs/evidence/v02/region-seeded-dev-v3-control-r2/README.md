# Checked-region DEV v3 control R2 and paired seed comparison

This report records the strict evaluation of the prospective no-image control R2 and its predeclared seed-search comparison with the unchanged, independently evaluated candidate. The original control run is preserved as an identity failure and is not scored or used in this pair; see the candidate-only evidence directory.

Both scored runs use the same frozen 40-case DEV corpus and truth files. The candidate remains a 40-case model-assisted segmentation run; the control is a no-image classification and region-search control, with no segmentation. Candidate whole-object boxes and reference masks are reported separately from the control’s seed-search results. The paired comparison uses only the same-semantic seed-search measures. It never compares a candidate mask box with a control seed cell, and a seed-cell intersection is not a whole-object success.

The candidate produced 6 matched positive whole-object boxes among 30 positives, with no false locations among 10 verified negatives. Its exact-canvas mask results were 1 pass among 7 reference instances (4 scored, 3 unavailable). Those remain low object and mask scores despite the positive paired seed-search comparison. This report is DEV evidence only; it is not a heldout result or release qualification.

The report contains aggregate counts and immutable artifact digests only. It omits per-case outcomes, images, masks, local filesystem paths, and provider credentials.
