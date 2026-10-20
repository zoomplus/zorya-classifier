# Exposed checked-region component proof

This metadata-only receipt records three paid DEV component checks on two already exposed photos. The first box for the Car instance was judged `needs-expansion` (0.00 / 1.00 / 0.00); the Knife box was judged `complete` (0.66 / 0.31 / 0.03); and a larger Car box from another same-seed MobileSAM proposal was judged `complete` (0.76 / 0.20 / 0.04). Together the raw receipts show 3 physical calls, $0.000292 known cost, 0 unknown-cost calls, and no in-flight calls.

`evidence.json` pins both raw run manifests, summaries, completion markers, prompt/criteria, route, request hashes, saved-presentation hashes, and provider receipts. The saved images and raw call artifacts remain in the ignored `.run` area and are not copied here.

These are component-level judgments on exposed DEV presentations, not an end-to-end accuracy result, a segmentation-mask evaluation, or release qualification. The calls used the legacy probe prompt and saved fixed-style presentations. The current production box checker uses separate closed-choice wording and renders the full source with the mask-derived box, seed-center cross, and hard-ROI outline. The historical calls did not exercise that production renderer or prompt. No heldout cases were accessed for this probe.
