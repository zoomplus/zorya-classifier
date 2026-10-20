# Exposed regression corpus v4

This directory records the previously exposed v4 candidate corpus as a **metadata-only regression fixture**. It is not a fresh blind holdout, and its use does not support a release-qualification claim. The corpus combined 40 Open Images photos, 20 controlled Mousepad toolbar captures, and 20 controlled Minetest 2D minimap captures. The original producer runs and their failures remain preserved outside the repository; this directory does not contain producer outputs.

The producer photo inputs are the exact frozen neutral-instruction derivative (`5d125e…`), not the earlier curator derivative (`c4dae2…`). The UI and map input arrays are byte-identical to their frozen files. The three evaluator truth arrays are also exact byte copies. The official photo mask index is kept separate from photo evaluator truth. An earlier prepared bundle used a joined photo-truth derivative (`4238724c…`); that is not represented as raw truth here.

## Contents and integrity

- `inputs/` contains the three frozen producer input JSON arrays.
- `truth/` contains the three frozen evaluator truth arrays and the official Open Images mask index. These are now exposed regression metadata.
- `provenance/` contains source and license ledgers, source-oracle records, and the acquisition admission receipt. Only machine-local path prefixes are scrubbed; `path-scrub-map.json` records raw and public SHA-256 values and replacement counts. All other provenance bytes are retained.
- `audit/openimages-mask-canvas-audit.json` records decoded dimensions and binary-value summaries for the 32 official instance-mask PNGs against their associated frozen JPEGs. It contains no pixel arrays.
- `metadata-index.json` pins every included artifact and indicates whether its bytes are identical to its source.
- `source-material-index.json` pins the tracked acquisition and oracle scripts needed to understand the procedure.

No source images, screenshots, world saves, mask PNGs, model weights, credentials, session data, or provider outputs are included. A replay requires separately reacquiring the licensed source media and masks using the pinned source URLs, hashes, and license evidence in the provenance ledgers. The tracked acquisition scripts are bounded and verify hashes; the UI and map scripts use isolated profiles and their documented source oracles. This metadata directory alone is not a pixel-complete runnable corpus.

The source-oracle strata are deliberately narrow. Mousepad 0.6.1 was captured in isolated Xvfb/Openbox/D-Bus with a controlled GTK stylesheet; the oracle covers actual visible toolbar button bodies and their explicitly scoped absence cases. Minetest 5.6.1 with Minetest Game contributes actual 150×150 2D minimap crops, with a controlled authored marker and hidden/shown/hidden source-pixel checks; this does not represent diverse games or natural user captures. Open Images photos retain official source annotations and per-image licensing evidence. The UI and map measurements are controlled application cases, not synthetic mockups.

## Open Images mask-canvas audit

The audit found 2 of 32 mask canvases exactly matching the corresponding producer JPEG dimensions; 30 differ. All mask files decode as binary `{0,255}`, match the dimensions in the official mask index, and have aspect-ratio difference below 0.5% from their corresponding JPEGs (25 at or below 0.1%; 7 above 0.1% and at or below 0.5%). The 21 checked source JPEGs decode to the frozen declared dimensions and all have EXIF orientation 1. The largest measured relative aspect-ratio difference is 0.11139775%.

Open Images V5 documents masks as binary PNGs and provides a separate mask CSV relating mask/image IDs and annotation boxes: [official V5 download documentation](https://storage.googleapis.com/openimages/web/download_v5.html). A dataset maintainer explains that CVDF/Figure Eight images were resized to a maximum 1024-pixel longest side while mask annotations used a 1600-pixel maximum, preserving aspect ratio, and recommends upscaling RGB where appropriate: [Open Images issue #92](https://github.com/openimages/dataset/issues/92). These sources explain the canvas-size mismatch but do not define an exact pixel-center or interpolation transform for these files. Therefore this audit does not claim exact mask-to-image alignment and does not normalize or score the masks. Any future mask scoring must state an explicit resize policy and keep the raw mask bytes and hashes unchanged.

## Reproduction pointers

The generic acquisition and validation implementations are tracked under `benchmarks/v02/`: `acquire_corpus.py`, `acquire_openimages_masks.py`, `normalize_openimages_masks.py`, and `validate_acquired_corpus.py`. The source-oracle methods are documented in `benchmarks/v02/corpus/v3/README.md` and implemented by the Mousepad and Minetest capture/derive scripts listed in `source-material-index.json`. Reproduction must use fresh private run directories, verify every acquisition against the recorded hashes, retain the source license notices, and report any unavailable source without substituting a different capture or label.

The prior blind evaluation is consumed and failed. Do not describe this directory as blind, do not use it to select or tune a candidate, and do not change the frozen labels or denominators.
