# Zorya Classifier diagnostic corpus v1

This is a fixed, model-independent diagnostic corpus for generic image presence classification, object localization, and text intent classification. It contains **60 real photographs (20 development / 40 reserved heldout)** and **30 original text fixtures (10 / 20)**. No paid or local inference model has been run on it.

## License boundary

The new preparation/validation/fetch code and authored text fixtures are MIT. **Photographs are not MIT:** each is attributed under **CC BY 2.0**. Open Images annotations are **CC BY 4.0** and attributed to Google/Open Images. Preserve `ATTRIBUTION.md`, individual license evidence and source links when redistributing the photos or annotations. The code repository can remain MIT while these optional benchmark assets retain their own licenses; do not publish the image directory as an MIT dataset.

Each admitted photo has (1) its official Open Images metadata row, (2) an independently retrieved original Flickr page whose page-specific `ImageObject` matches that Flickr photo ID and explicitly gives CC BY 2.0, and (3) a pinned local CVDF JPEG. The global license menu embedded in Flickr JavaScript was never accepted as evidence. `licenses/<ImageID>.json` preserves the selected structured evidence, retrieval time, source URL and checksums. Raw page HTML was not retained; its hash and the original JSON-LD block hash are provenance records and cannot be independently recomputed from the extracted object. This is a recorded license assertion by the original hosting page, not a warranty of underlying ownership. Twenty-seven candidates were rejected for unavailable pages/images or unconfirmed licenses, before any model output existed.

Official sources:

- Open Images download index: https://storage.googleapis.com/openimages/web/download_v7.html
- Annotation/photo licensing: https://storage.googleapis.com/openimages/web/factsfigures_v7.html
- CVDF image distribution and resizing: https://github.com/cvdfoundation/open-images-dataset
- Source CSV URLs, acquisition times, sizes and SHA256: `source-manifest.json`.

The V7 index points to the preserved V5 validation bbox/image-label CSVs and the 2018 image metadata. The manifest names those exact files; it does not mislabel old annotations as a newly collected dataset.

## Files and producer isolation

- `photo-manifest.json`: complete **evaluator-only** photo records, source/license provenance, exact boxes, strata and rejection log.
- `inputs/{dev,heldout}.json`: photo request fixtures. A benchmark adapter may load and hash-check the file using local identity fields, but must send **only image pixels and the locate/classify question/options** to the model. Never send case ID, filename, source URL, split, manifest, or GT. Case IDs and array positions are local join keys; selected records are currently grouped by stratum.
- `ground-truth/{dev,heldout}.json`: reference targets, every source-annotated box, and exact negative annotation records. Load these only after producer results have been saved.
- `photos/*.jpg`: 60 immutable CVDF photographs, 15,565,072 bytes total; no local resizing, cropping, enhancement or synthetic content.
- `licenses/*.json`: photo-specific license extraction records and annotation-license source.
- `text/`: 30 original RU/EN support-intent fixtures, separate producer policy/inputs and evaluator labels/reasons. See that README for the classification rule.
- `validation.json`: actual annotation/byte/license-record checks and successful FFmpeg decoding of all 60 JPEGs; no model accuracy claim.
- `fetch_photos.py`: bounded exact-ID downloader for the frozen manifest; verifies SHA256 and refuses changed bytes. Four concurrent downloads maximum, 5 MiB/photo, 30 seconds/request. It never reselects examples.
- `fetch_metadata.py`, `prepare_photos.py`: construction history. Re-running selection may produce a different corpus if source availability changes; the frozen manifest is authoritative.

Use fresh stateless model requests for each case. Do not use prior cases or reference answers as conversational context. The `heldout` split is reserved from subsequent local development; it is public data and may have appeared in model pretraining. The curator necessarily saw annotations while constructing strata. Do not call this a secret benchmark or independently human-adjudicated ground truth.

## Photo strata

| Primary condition | Dev | Heldout | Definition |
|---|---:|---:|---|
| Baseline | 4 | 6 | One non-occluded, non-truncated target box, normalized area 4%–80%. |
| Negative | 4 | 6 | Explicit **human verification Confidence=0** for this image/class; never inferred from missing bbox annotations. |
| Small | 3 | 7 | At least one target box occupies 0.05%–1% of the image. |
| Edge | 3 | 7 | Source `IsTruncated=1`, box touches within 1% of an image edge. |
| Occluded | 3 | 7 | Source `IsOccluded=1` on a target instance. |
| Duplicate objects | 3 | 7 | 2–8 distinct source-annotated instances of the requested class, not repeated photo files. |

There are 25 requested object classes, 60 unique photo byte hashes and 60 unique current photographer identities. Neither photo nor photographer crosses splits. Other condition tags may overlap the primary stratum. Group-of boxes and depicted targets are excluded from positive selection. Maximum requested target instances is eight. Class counts are not perfectly balanced (maximum five examples of a class); this is a small stratified diagnostic set, not a population sample.

Coordinates are `[xmin, ymin, xmax, ymax]`, normalized to `[0,1]` in source image orientation. CVDF has already resized images to at most 1024 on the longest side while preserving aspect ratio. `OriginalMD5` describes Flickr's original file and is not the checksum of the resized CVDF JPEG; use the corpus SHA256 for actual input bytes. Each target box points to its exact source CSV record. Annotation Confidence=1 is the dataset's dummy bbox field, not model confidence. Original source annotation errors remain possible.

## Evaluation readiness and limits

The local bytes, required conditions, split, original-page license records, explicit negatives and annotation references are ready. A complete JPEG decode check passed for every photo. Text labels are authored expectations, not independently annotated real customer messages. No model quality, threshold calibration, runtime speed, or accuracy improvement has been measured.

Use image classification accuracy/unknown/error separately. For localization report matched-object IoU/recall with one-to-one assignment for multiple instances, false objects on the ten explicit negatives, and unknowns separately. Do not count an arbitrary bbox containing the whole image as a hit. If the public API returns only one object, declare a separate any-instance metric rather than claiming all-instance recall. Keep the acceptance metric and unknown policy fixed before opening heldout outputs.

Perceptual near-duplicate detection and independent human review of all source boxes are **not completed**. Generic game UI, inventory icons, map arrows, OCR, and temporal tracking are not represented by this photograph corpus. Those need separately licensed, independently annotated fixtures; success here cannot qualify them.

## Offline verification

```sh
python3 validate_corpus.py
python3 fetch_photos.py  # existing files are verified; absent files are fetched from the pinned public source
```

`validate_corpus.py` uses Python standard library and an installed FFmpeg binary, reads only local data, and does not call any inference provider. Raw source CSVs are retained to make the ground truth independently auditable.
