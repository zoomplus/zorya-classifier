# Controlled corpus acquisition and oracle tools

These scripts create metadata-bound, controlled source examples for the v0.2
benchmark. They do not call a model or choose cases from model output. Captured
images, truth, downloaded source bytes, masks, run profiles, and per-case proof
records belong in a private ignored run directory; none are included in this
source bundle.

The photo route uses Open Images V5 validation photos, official human box and
verification annotations, and official instance masks. The image license
evidence is checked per photo against its public landing page (CC BY 2.0); the
segmentation annotation source is CC BY 4.0. Positive mask cases require the
raw JPEG canvas to match the official PNG mask canvas exactly and identity
orientation. The acquisition tool requires all three prior-exposure ledgers
as explicit `--exclusion-manifest` arguments and fails unless image IDs,
content hashes, and source groups each exclude the complete 160-case history.
The selection rule and class filters are fixed in the source. This is a
reusable procedure; portability changes made after the completed acquisition
do not retroactively describe the exact script bytes used for that acquisition.

The UI route runs GNOME Calculator 46.3 with an owned GTK style provider inside
an isolated display. It binds the intended keypad button to the pinned upstream
GtkBuilder widget identity, AT-SPI inventory, and visible painted edges. It is
a controlled single-application family, not a natural screenshot sample. Its
style and authored calculator content are part of the capture method.

The map route runs the actual Wesnoth 1.16.11 map editor and minimap renderer
over separately licensed official multiplayer maps (Wesnoth data package GPL
v2 or later). Three isolated launches capture village-layer off/on/off. The
source projection uses the pinned renderer's accumulated float32 resampling;
the visible target box comes from the repeatable A/B/A pixel delta, not from
the projected rectangle. The projection is only a support bound because later
terrain draws can cover marker pixels. This is one controlled game/renderer
family, not a diversity claim about natural game screenshots. The 4p Siege
Castles proof map and its captures are excluded from the later map cohort.

All output paths are caller supplied, must be new where outputs are exclusive,
and should be under an ignored private run directory. The photo acquisition
may fetch public source files and photo-specific license pages; the other
capture tools need their named application and display dependencies installed.
Do not put API keys, user captures, private desktop paths, or downloaded image
and mask binaries in this directory.

## Offline validation

From a checkout with the project Node dependencies available:

```sh
python3 -m unittest discover -s benchmarks/v02/controlled_oracles -p 'test_*.py' -v
node --test benchmarks/v02/controlled_oracles/validate_evaluator_truth.test.cjs
```

`validate_evaluator_truth.cjs` accepts explicit `--inputs`, `--truth`, and
`--image-root` paths. It enforces the evaluator truth schema, exact case ID
coverage, image-root containment, file hashes, decoded dimensions, and box
extent. Its output is aggregate only.

The Calculator source wrapper is retained verbatim. Create a distinct
evaluator-format derivative with explicit paths before validation:

```sh
python3 benchmarks/v02/controlled_oracles/canonicalize_calculator_truth.py \
  --source-truth PRIVATE_RUN/uiTruth.json \
  --producer-inputs PRIVATE_RUN/ui-inputs.json \
  --output PRIVATE_RUN/ui-evaluator-truth.json
```

The conversion maps the authored presence enum and normalizes the source
painted XYXY pixel bounds by the corresponding image dimensions. It fails on
ID mismatches, duplicate rows, invalid bounds, missing negatives, or changed
image geometry. It does not open images or add annotations.

## Photo acquisition CLI

```sh
python3 benchmarks/v02/controlled_oracles/acquire_photo40.py \
  --output-dir PRIVATE_NEW_RUN/photo-acquisition \
  --source-dir CACHED_OFFICIAL_CSV_DIRECTORY \
  --mask-csv CACHED_OFFICIAL_INSTANCE_MASK_CSV \
  --mask-header-index PRIVATE_METADATA_ONLY_MASK_HEADER_INDEX \
  --exclusion-manifest PRIOR_PHOTO_MANIFEST \
  --exclusion-manifest PRIOR_CORPUS_LEDGER \
  --exclusion-manifest PRIOR_HELDOUT_LEDGER

python3 benchmarks/v02/controlled_oracles/finalize_photo40.py \
  --work-dir PRIVATE_RUN/photo-acquisition \
  --source-dir CACHED_OFFICIAL_CSV_DIRECTORY \
  --mask-csv CACHED_OFFICIAL_INSTANCE_MASK_CSV
```

The scripts enforce bounded response sizes and case quotas, and use exclusive
new output directories. Photo collection can issue public HTTP requests; do
not run it unless fresh acquisition is authorized. A completed frozen cohort
should be replayed from its pinned bytes instead of reacquired.

## Controlled UI and map capture CLIs

```sh
python3 benchmarks/v02/controlled_oracles/capture_calculator.py \
  PRIVATE_NEW_CAPTURE --screen 1024x768 --window-size 800x600
python3 benchmarks/v02/controlled_oracles/build_calculator_ui20.py \
  PRIVATE_NEW_COHORT --gtk-builder PINNED_UPSTREAM_BUTTONS_BASIC_UI
python3 benchmarks/v02/controlled_oracles/build_wesnoth_map20.py \
  PRIVATE_NEW_COHORT --map-root INSTALLED_OR_EXTRACTED_WESNOTH_1_16_11_MAPS
```

Run captures in an owned Xvfb/profile. The calculator and Wesnoth helpers only
terminate subprocesses they started. The map builder rejects unexpected map
overlay syntax, preserves the source-map hashes, and emits independent
source-state and capture provenance. Do not merge private output trees into
the repository.
