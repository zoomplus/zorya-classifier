# v0.3 segmentation prompt and candidate-selection mechanism screen

**Classification:** exposed development diagnostic only. The five photos were selected before this experiment because each had an available v3 seed and independent visible-object mask. The cases were already known to the team. This is not independent validation, heldout qualification, or evidence that the same result generalizes to other targets or UI/map imagery.

## Question

Does adding a fixed seed-centered box to the existing MobileSAM point prompt improve its candidate masks? If not, can a closed semantic Choice select the whole-object mask from the four masks already returned by the existing point prompt when MobileSAM's diagnostic score prefers a part?

## Frozen inputs and execution

The fixed case IDs were `photo-heldout-present-01`, `02`, `04`, `16`, and `18`, targeting Horse, Bird, Cat, Truck, and Camera. The photo input manifest SHA-256 is `ce0d7af70cace50fbee83d3cc21cc83fa4c213759f49758ba53397509660906c`. The probe used actual v3 seed cells, pinned MobileSAM ONNX assets and CPU provider. It encoded each photo once and decoded each of the point-seed and seed-plus-box prompts once. The seed-plus-box profile added SAM box-corner labels from a fixed 3× seed-cell box; no truth-derived coordinates or negative points were used. All four returned masks were preserved before truth was opened.

The closed-selection request freeze pins the inputs, prompts, renderer, source, evaluator, original and four candidate presentations per case, and source mask-plane hashes. Each request contained one original image plus four full-context overlays A–D, and exactly one Choice among A/B/C/D/none with stable raw-argmax/tie behavior. The target phrase and full-visible-object criterion were sent; ground-truth masks, case IDs, seeds, coordinates, scores and IoUs were not. The configured route was `openai/gpt-6-luna-decisions` through the existing caller-owned `DecisionPort`/provider recorder. There were at most five physical calls, `$1.00` hard budget and `$0.05` unknown-cost reserve; five physical calls completed with `$0.0020205` known cost, zero unknown-cost receipts, no retry and no fallback. The runner made no calls beyond those five.

The exact inputs, local mask presentations, per-call receipts and full summaries remain under ignored `.run/v03/`; they are intentionally not committed. Published pins: prompt-probe summary `43d0e5b225eb83c9497618aed50484812412d280b2ecde9828614a69f353df0c`; semantic request freeze `8f6944f576a709b4be185ccaaab64cb4a29e6d4c5a1fe6ff9aa43c7fd673bd4c`; semantic dispatch summary `d5e4cc42272dffa8be86c57e38df6fe375d77f9d56c367e7ffb0c2c5f77f0833`; semantic evaluator output `989a42b97f4a1dcf13db3bf686a0c10d583235122c204b0a91f80b8f1ea6855f`.

## Results

| Case      | Native point-seed choice | Native IoU | Semantic choice | Semantic IoU | Oracle-best IoU | Result                       |
| --------- | ------------------------ | ---------: | --------------- | -----------: | --------------: | ---------------------------- |
| 01 Horse  | D                        |     0.9385 | D               |       0.9385 |          0.9385 | unchanged                    |
| 02 Bird   | B                        |     0.2583 | C               |       0.7535 |          0.7867 | large gain, still below best |
| 04 Cat    | C                        |     0.9696 | C               |       0.9696 |          0.9723 | unchanged                    |
| 16 Truck  | D                        |     0.9411 | D               |       0.9411 |          0.9411 | unchanged                    |
| 18 Camera | B                        |     0.0675 | D               |       0.9639 |          0.9639 | large gain; matches best     |
| **Mean**  |                          | **0.6350** |                 |   **0.9133** |      **0.9205** | descriptive only             |

The native point-seed mask is the candidate selected by the existing MobileSAM quality-score rule from candidates intersecting the seed. The oracle-best candidate is computed after inference from independent reference masks; it is strictly an evaluator diagnostic, never a production selection rule. All four point-seed candidates hit the seed in all five cases. The box prompt did not help: mean native-selected IoU was `0.1556`, and mean oracle-best IoU was `0.2604`, compared with `0.6350` and `0.9205` for point-seed. Reject the tested 3× profile rather than tune it against this panel. Cases 02 and 18 explain most of the selection result: their native maximum-score masks were part-like while a lower-score candidate better covered the requested instance.

## Presentation caveat

The frozen renderer filled candidate foreground with translucent cyan, drew an opaque cyan contour, and placed its 42-pixel A–D label strip over the top rows of the source raster. The source-space candidate planes and evaluator stayed unchanged, but the provider view did not preserve every source pixel. Post-response inspection found that the strip covered 1,280 annotated Cat pixels in case 04, equal to `0.50%` of that mask; there were no annotated foreground pixels in the strip on the other cases. This remains a known flaw in the as-run mechanism screen. It could influence visual judgments, with an unknown direction of bias. Do not reuse this renderer for qualification. Future overlays must put identifiers in an added margin outside the original raster, send an unmodified original view, and record the transform.

## Interpretation and next test

The screen supports the narrow hypothesis that a semantic caller can sometimes choose a better mask than MobileSAM's uncalibrated score when a whole-object candidate is already present. It says nothing about proposal recall, false selection when all candidates are bad, aggregate localization, unseen data, or image categories omitted from this panel. The next experiment should freeze a broader exposed-dev panel before viewing masks or answers, include misses and cases with no viable candidate, correct the presentation margin, and report selection coverage plus correct abstention alongside mask IoU. Keep Luna/OpenAI as an explicit caller recipe behind `DecisionPort`; do not make it a default model/provider. If the candidate-generation or seed miss ceiling remains the limiting factor after that ablation, evaluate the separately documented SAM 3 text-grounding route on a few exposed images under its official checkpoint-access and license requirements.
