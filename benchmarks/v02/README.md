# v0.2 independent acceptance

Current status: the original 40-case DEV corpus and first 80-case blind cohort were acquired and evaluated. The [first blind recipe failed qualification](../../docs/evidence/v02/heldout-evaluation-20261020.md); its exposed cases cannot qualify another recipe. Two predeclared native categorical-presence recipes are now being compared on the complete original DEV40. A new source-family-disjoint blind cohort is being curated; it is not frozen or qualified yet. See [acceptance](../../docs/acceptance.md) for current gates and the preserved failed runs.

The acquisition notes below describe the earlier preparation stage and retain its original gaps and decisions. Statements about unavailable UI/map cases or unexecuted calls refer to that historical stage, not the current corpus. Fixture, component, development and blind results remain separate.

## Native categorical DEV40 evaluation

`evaluate-categorical-fresh.ts` accepts only the two exact `native-luna-categorical-presence-sam-target-plus-neutral-v1` and `native-luna-categorical-presence-sam-target-only-v1` DEV profiles. It validates their distinct target policies, 120-second operation budget, two case workers, one active native job, exact original 20/10/10 input pins, pinned assets, and a producer source digest supplied independently from the predispatch freeze. It checks all 40 results, source equality before/after, global physical IDs, per-case six-fetch limits, request-hash correspondence, native metadata and cropped mask geometry. Parsed and wire receipts reconcile actual known costs; missing costs keep the $0.05 reservation. Timings stay unranked under concurrent native stress.

The normalizer preserves the actual profile identity rather than relabeling a run as the legacy proposal recipe. It reuses strict artifact shapes and the same box/mask metrics, while the legacy evaluator's profile/phase/policy pins remain unchanged. `evaluateFreshRun` counts every unknown, failure and negative in its original denominator. `scoreProposalMasks` verifies actual binary/cutout bytes, hashes, source offsets and independent reference masks; box correctness does not imply mask correctness. Offline normalization tests contain authored fixture truth and make no provider calls.

The text-image comparison uses the same text route with and without encodings. The native vision recipe and its pinned DeepSeek/Together no-image control use different model families; their paired result compares complete recipes and does not isolate the causal contribution of image input alone.

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

## Exposed v1 diagnostic producer

`run.ts` is the paid dispatcher for this original diagnostic. It is deliberately an old, already-exposed development diagnostic, not a fresh qualification run. The frozen producer input is `input-manifest.json` (three varied positive objects and one explicitly verified negative); its separate `diagnostic-evaluator-dev4.json` file is evaluator-only and is never imported by `runner.ts`. Provider state contains the task, target, closed options and image representation only. It never contains case IDs, local paths, hashes, split labels or ground truth.

Run the bounded two-case functional pilot first, choosing the first positive and explicit negative. For example:

```sh
node --import tsx benchmarks/v02/run.ts --allow-paid --max-physical-calls 125 --max-cost-usd 2.50 --cases 2
```

Run all four diagnostic cases only when coordinated with the CPU benchmark window:

```sh
node --import tsx benchmarks/v02/run.ts --allow-paid --max-physical-calls 250 --max-cost-usd 5 --cases 4
```

A single-call transport check is restricted by the CLI to one physical dispatch and at most $0.10. `none-json-schema` changes only the reasoning effort from `low` to `none`; it retains the pinned model/provider, the existing JSON Schema response format, 1,024 output-token cap, prompt variant and first exposed development case. It is a named protocol experiment, not a new qualified candidate:

```sh
node --import tsx benchmarks/v02/run.ts --allow-paid --max-physical-calls 1 --max-cost-usd 0.10 --transport-probe --transport-variant none-json-schema
```

The default text route is pinned DeepSeek Flash through Together using OpenRouter chat completions. The native vision control is pinned OpenAI GPT-6 Luna Decisions through OpenRouter's typed Decisions endpoint (`/api/alpha/decisions`), not the ordinary chat-completions endpoint. Each provider decision makes one request, with no route fallback and no retry. Text classification output is capped at 1,024 tokens; text localization output is capped at 4,096. The three prompt variants are `no-grammar`, `grammar`, and `grammar-plus-examples`; the final variant has two synthetic decoder examples without benchmark labels. Run each variant as a separately frozen run. Text candidates use all six registered encoders. The no-image control is a direct one-request presence probe plus a one-request no-image localization-feasibility probe; it does not invoke the image locator with a fabricated blank image.

The budget reserves at the injected `fetch` boundary, after local request validation and immediately before network dispatch. Logical decisions and physical fetches have separate records. Every HTTP status is retained, including non-success responses. A bounded in-memory copy extracts only response model/provider/id, usage cost, allowlisted error type/code/parameter categories, a content-free response-shape category, the finish reason, and numeric retry-after seconds. Raw response text, error messages, URLs, raw headers, keys and image bytes are not written. If transport parsing fails but a wire usage receipt contains a valid cost, the ledger records it. Otherwise cost stays unknown and consumes the configured unknown-cost reserve. The cap is a local admission limit, not an OpenRouter-side spending cap.

Each run creates a new, immutable directory under `.run/v02/` by default. The run manifest freezes the selected case IDs locally, input manifest hash, prompt variant/hash, exact route identities, output caps and hard limits. Per-call records contain request hashes and text-part sizes/hashes rather than serialized private content. Failed runs and partial stage records remain for review. The final summary reports actual provider/model receipts, HTTP status, physical call count, known and unknown cost, and p50/p95 dispatch latency. Timings made while native CPU checks are active must be tagged as concurrent and excluded from route ranking.

## Controlled corpus supplements

The original fresh-photo acquisition remains in `corpus/dev/` and the ignored local cache. Controlled real-application and generated-game-map supplements are documented in [`corpus/dev-controlled/README.md`](corpus/dev-controlled/README.md). Run `python3 benchmarks/v02/validate_controlled_corpus.py` to check their local metadata and image hashes. These are clearly marked controlled scenes with model-assisted labels and do not claim natural user-capture qualification.

The new `evaluate-categorical-heldout.ts` admits only the frozen 80-case native categorical recipe. `evaluate-no-image-heldout.ts` independently admits its separately sourced 40-photo control and reconciles the producer actual-fetch image audit with every physical receipt. The paired comparison preserves all failures, uses the existing 10,000-resample fixed-seed photo bootstrap, and retains the combined negative-case gate. These helpers do not relabel or loosen historical DEV/heldout schemas. Synthetic evaluator tests do not supply live accuracy evidence.
