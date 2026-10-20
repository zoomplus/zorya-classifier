# v0.2 corpus acquisition status

Status: **partial; fresh photo quota and controlled real-app/map supplements acquired; natural-source map/UI gate remains open**. No model calls or provider outputs are included. The previously exposed v1 photo corpus remains excluded by image ID, SHA256 and Flickr author profile for every selected photo.

## Fresh photos

Open Images V5 validation provided 60 new photo cases: dev has 16 present and 4 explicitly human-verified absent targets; heldout has 30 present and 10 explicitly human-verified absent targets. Every positive uses the official image-level box rows. An absent label uses only a specific `Source=verification, Confidence=0` CSV row; missing boxes/labels never count as absence. The 60 current Flickr photo pages each exposed one page-specific JSON-LD `ImageObject` matching the photo ID and CC BY 2.0. This checks the current page's license declaration; it does not warrant ownership.

The official V5 validation mask index contained a target-class instance mask for 21 of the 46 positive photos. Those 32 source masks were fetched only from the 12 selected image-ID shards (43,340,128 compressed bytes total; the index was 2,920,821 bytes). Each is nearest-neighbor normalized to the exact acquired JPEG raster and checked to contain only binary values; mask extents are computed from these reference masks. The remaining 25 positive photos have official source boxes and no target-instance mask.

The **raw images, original mask PNGs, normalized masks, license evidence, source ledger, request allowlists and truth** are local under the gitignored `benchmarks/cache/v02/corpus/`. They are not copied into this MIT repository archive. `acquire_corpus.py`, `acquire_openimages_masks.py`, `normalize_openimages_masks.py`, and `validate_acquired_corpus.py` document and recheck the bounded process. The audit validates source rows, source-group split, media hashes, photo-specific license evidence, explicit negative evidence, mask dimensions/binary values, producer-input isolation and JPEG decoding. No perceptual near-duplicate review has been performed. The audit is not a second human adjudication and says nothing about model quality.

Input manifests are separate from source/license metadata and evaluator truth:

- `inputs-dev.json` and `inputs-heldout.json` contain case ID, local image path/hash/dimensions, target and allowed request options only.
- `source-ledger.json` records source URLs/groups, media hashes, photo-specific license-page evidence and the official annotation/mask CSV provenance.
- `ground-truth-dev.json` and `ground-truth-heldout.json` record official boxes or explicit negative rows, and source-sized binary reference masks where available.

After photo acquisition and mask normalization, the heldout input manifest SHA256 is `f0be4b9b2d5a11bd77f1b890860745c3bf17dd185b5cc1fb73c1af674c9465d5`. It is a commitment to the current blind producer inputs. The heldout truth and any case-level heldout results stay in the ignored local cache pending the candidate freeze; they are not included in this status file.

## Controlled map and interface supplements

A separate controlled-real supplement now contains 20 dev and 40 heldout cases: dev 7 positive/3 explicit-negative UI icons and 7/3 map objects; heldout 15/5 UI icons and 15/5 map objects. UI screenshots are actual Geany and AbiWord applications running in isolated Xvfb sessions with task-authored sample files. Maps are actual Freeciv and OpenTTD renders using locally installed game assets and generated maps. Geany/Freeciv are dev-only; AbiWord/OpenTTD heldout-only. All four source families have package copyright evidence and hashes in `corpus/dev-controlled/source-ledger.json`; heldout evidence stays in the ignored cache. Downloaded application packages totaled about 97 MB for the bounded setup, below the 250 MB cap. No model API calls were made.

These are genuine application/game renders, but controlled scenes rather than natural user captures. The labels were prepared by model-assisted visual review, not independent human annotation or candidate output; there are no masks. Only one app and one game source group per split/stratum are represented, Freeciv exposes a small explored area and OpenTTD uses one generated map seed. Keep these counts reported as a controlled supplement and do not treat them as qualifying a natural-source or broad source-group independence gate. Dev inputs, truth and source ledger are tracked as metadata under `corpus/dev-controlled/`; both screenshot bytes and all heldout manifests/truth/ledger remain under ignored `benchmarks/cache/v02/corpus/controlled/`. `validate_controlled_corpus.py` checks hashes, app/game split disjointness, annotations, explicit absence evidence and per-stratum counts without candidate calls.

The [RICO Semantics repository](https://github.com/google-research-datasets/rico_semantics) provides human-drawn boxes and a CC BY-SA 4.0 license for its annotation dataset. Its own README describes those annotations as augmenting the separate [RICO screenshot dataset](https://www.interactionmining.org/archive/rico). The original RICO project's [copyright notice](https://www.interactionmining.org/archive/rico/copyright.txt) explicitly says screenshots may contain copyrighted work and makes the researcher responsible for use. That does not verify a sampled app screenshot's individual reuse rights, so no RICO screenshot was admitted.

The [DayZ minimap project](https://github.com/pharmazone/dayz-minimap) documents real minimap images and human-reviewed marker centers. The public repository page shows no dataset/image license and the labels are center coordinates, not marker boundaries. It therefore cannot establish either image rights or bbox truth and was not admitted. DayZ screenshots additionally contain game imagery. The v0.2 natural-source map quota still requires separately licensed screenshots plus independently reviewed whole-object boxes and verified absence cases.

The producer allowlist for any future strata must remain disjoint from the source ledger and evaluator labels. Cases from the same app design, map/session/game, author, image, resized copy or source screen belong to one split. Do not expose heldout truth/results before the candidate freeze.

## Structural checks

Run the acquisition scripts with `python3` after providing the local Open Images CSV cache used by v1 at `/root/work/zorya-classifier/benchmarks/corpus/source/`. `validate_acquired_corpus.py` performs no model calls and decodes all 60 acquired JPEGs. Current local result: 60 unique photo IDs, hashes and source groups; 60 JPEG decodes; 21 positive cases / 32 masks; all v1 IDs, hashes and groups excluded; dev and heldout inputs contain no source or truth fields.
