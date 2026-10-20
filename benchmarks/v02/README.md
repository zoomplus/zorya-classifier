# v0.2 independent acceptance preparation

This directory contains evaluator code, the frozen **intended** corpus policy, and partial acquisition evidence, not a completed corpus or model-quality report. Fresh Open Images photos have been acquired and structurally validated; real map and UI cases remain open. No model calls were made. See [corpus-status.md](./corpus-status.md) for the acquisition record and blind input-manifest commitment.

## Fresh source acquisition

The existing 60-photo v1 corpus and all historical provider outputs are development/regression data. Exclude their image IDs, byte hashes **and photographer source groups** before choosing new cases. Reusing the authoritative dataset's annotation files is permitted; reusing previously exposed photos as a fresh holdout is not.

| Stratum         | Proposed source                                                                                                                                         | Ground truth                                                                 | Admission condition                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Photos, present | New Open Images validation/test images, selected independently of model output                                                                          | Human-source boxes; official instance masks when available                   | Exclude old IDs/hashes/authors; confirm each photo's current original-page license; pin bytes and exact source annotation rows           |
| Photos, absent  | New Open Images images with explicit human-verified `Confidence=0` image/class records                                                                  | The exact negative annotation row                                            | Missing bbox annotation is never a negative                                                                                              |
| Maps            | Public, permissively licensed rendered map screenshots with independently reviewed symbols                                                              | Reviewer-drawn visible-instance bbox/mask and explicit target-absence review | A map tile's geospatial geometry is not automatically the pixel extent of a rendered icon; per-image attribution and review are required |
| Interfaces      | Public screenshots with adequate individual-content license and independently verified target labels, or clearly separated authored fixture diagnostics | Independently reviewed pixel bounds/masks and explicit target-absence review | DOM bounds alone may include invisible padding, occlusion or clipped content; WebSight is synthetic, not real app UI                     |

The acquired photo cases use Open Images V5 validation boxes, explicit human labels and the official instance-mask index. They are new relative to v1 by image ID, byte hash and photographer profile. Current Flickr photo pages were individually checked for a photo-ID-matching CC-BY 2.0 `ImageObject`; 21 positive cases have 32 official source masks. Bounded acquisition and validation scripts are in this directory. Raw photos, license evidence and separated manifests/truth are in gitignored local cache and are not part of the MIT archive.

**Acquisition gap:** no currently admitted, individually licensed **real map or real UI** corpus has been established. Do not silently replace those 60 required combined cases with hand-generated diagrams and report real-world success. Authored renderings are useful reproducible fixtures with exact source geometry, but must be identified as synthetic and reported separately. The release's experimental quality gate remains pending until the intended corpus is populated and independently checked.

## Source and licensing facts

- [Open Images V7 download and format documentation](https://storage.googleapis.com/openimages/web/download_v7.html) supplies bounding boxes, explicit human image labels and instance masks. A mask CSV's `BoxXMin/BoxXMax/BoxYMin/BoxYMax` identifies the **starting box**, not the tight extent of the final mask. Compute a reference mask's extent from that **reference binary mask**, not from the starting box or from this library's predictions.
- [Open Images license statement](https://storage.googleapis.com/openimages/web/factsfigures_v7.html) distinguishes image licensing from annotations and asks users to verify image licensing. Dataset metadata alone is not a warranty of original ownership. Annotation provenance must retain the official source license.
- [WebSight's official dataset card](https://huggingface.co/datasets/HuggingFaceM4/WebSight/blob/main/README.md) labels the corpus synthetic and CC-BY-4.0; its terms also preserve source-content licenses. It is not an independently annotated segmentation dataset, and its overall license cannot blanket every embedded third-party image. v0.1 excludes real images; v0.2 includes them. A WebSight UI sample is admissible only under an explicitly **synthetic UI** stratum and requires separate visible-object annotation.
- [COCO's official task pages](https://cocodataset.org/#home) document object detection/segmentation. COCO is a potential alternate photo source, but per-image licensing and duplicate/source-group exclusion must still be recorded. No COCO image or annotation was downloaded in this audit.

No corpus assets inherit the library's MIT license merely by being copied into a benchmark directory. Keep source notices, retrieval time, original URL, declared license, per-file hashes and image transforms. Avoid full raw hosting-page HTML, personal account metadata or media outside the public benchmark scope.

## Required records and separation

Maintain three separate artifacts:

1. **Input manifest:** local ID, image path/hash/dimensions, semantic target, closed classification options. IDs and paths are local joins and must be removed by an explicit allowlist at the provider boundary.
2. **Evaluator truth:** presence, visible-object boxes, source-sized binary reference mask if applicable, annotation provenance, reviewer IDs/decision history and verified-negative evidence. Never import this module/data in a request producer.
3. **Source/license ledger:** original and resolved public URLs, content hashes, original dataset split, photographer/app/map source group, license evidence and acquisition transformations. Keep this out of model state.

Resolve split membership **before** model experiments. Use source-group partitioning, not a random case split after generating several targets from the same photo or screenshot. The same screen with a different target, resized/cropped variants, maps from the same guide/game/session and screenshots of the same app design belong to one source group. Hash bytes and, during independent review, reject visually near-duplicate frames. The old corpus lacks complete perceptual duplicate detection; do not claim that its source-group exclusion alone proves no visual leakage.

The curator may see the source labels while building strata. This is a public-data heldout protocol, not a claim that source photos are secret or absent from model pretraining. Algorithm developers must not inspect heldout predictions, per-case failures or truth while changing the candidate. After a revealed failure, preserve the original evidence and treat that split as regression; a new blind claim needs another unseen partition.

## Exact evaluator policy

`metrics.ts` is evaluator-only and accepts pixel or normalized boxes in one shared coordinate space. An any-instance localization passes only if **the same reference instance** has both IoU ≥ 0.5 and reference-visible-area coverage ≥ 0.9. A tiny grid cell inside a large object fails; a huge whole-image rectangle also fails. Any-instance success does not mean all-instance recall. Boundary-limited objects are compared with their visible reference extent; hidden shape is never invented.

Mask quality uses source-sized binary 0/1 arrays, IoU ≥ 0.8, and rejects empty positive reference masks. Resize/interpolation or mask-area differences must not be hidden by bbox scoring. An absent target has no positive mask, so report its false-location behavior separately.

Unknowns, timeout/errors and invalid provider results stay in the attempted and positive denominators. Latency/cost ledgers include every physical dispatch, including failures; a missing receipt has unknown cost rather than zero cost. Never combine classification and localization so that the previous classification answer leaks to localization.

Development eligibility requires all contract/resource/privacy tests and **0/10** false localizations. Rank eligible candidates by photo localization, photo classification, lower p95, lower known cost (unknown cost remains explicit), then encoded bytes. Freeze the winner and its prompt/encoding parameters before opening heldout. The heldout gate allows at most **1/20** false localizations and requires a positive lower 95% paired-bootstrap improvement on photo localization against the same text-only model receiving no image data. `pairedBootstrap` uses 10,000 paired resamples, fixed seed `0x5a4f5259`, nearest-rank percentile endpoints and canonical case-ID ordering. Equal or missing answers do not establish an improvement. No runner-up may be picked from the revealed heldout results.

If no candidate clears these gates, preserve the report and ship no unsupported public experimental winner. Fixture checks prove protocols and lifecycle behavior; they are not paid-provider accuracy evidence.

## Offline evaluator checks

```sh
node --import tsx --test test/v02-metrics.test.ts
```

These checks do not access network, consume keys, start native models or infer labels. They cover the crucial large-object/whole-image counterexamples, positive-denominator retention, mask format and deterministic paired comparison.
