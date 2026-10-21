# H4c SAM2 refinement of frozen UI boxes

**Result:** the bounded producer completed on the one frozen Geany screenshot. All 36 frozen OmniParser proposals produced a nonempty full-source mask, but only 1 of 3 positive target cases had an oracle-best mask-derived box that met the unchanged availability gate. This is insufficient evidence to promote the route. H4a remains 0/3 under its original detector-box measurement; H4c is a separate diagnostic that modestly increases candidate availability and does not establish semantic localization or production accuracy.

## Frozen run

- Source: 1280x800 controlled Geany screenshot, SHA-256 `0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09`. It contains styled colored button outlines and does not represent general natural UI performance.
- H4a input output SHA-256 `d1ff8a0fd97e6197834c673d399fe9f1ecfcd2d93182ab2a4fd3767e702755a1`; its pre-inference freeze SHA-256 `30ff2cf2f1894745c8e5e227e35ef1858432c63f55ae454a1e10f86118668753`.
- Model: `facebook/sam2-hiera-tiny`, revision `7c218beaf0bb87874785f32b582f640134fc1c09`, Apache-2.0; weight SHA-256 `1449035ba6ba2ed524c646da989e5cb3a9b93b97f1c1b2d474e598c3b748d99f`, 155,841,672 bytes.
- Runtime: Python 3.12.3, Transformers 4.57.3, Torch 2.6.0+cu124, TorchVision 0.21.0+cu124, CUDA 12.4, NVIDIA GeForce RTX 4080.
- The model processed all 36 source-coordinate boxes in H4a order using a single full-image encode and one box prompt per candidate, with one mask requested per prompt. Masks were thresholded at zero and retained at original 1280x800 dimensions without clipping to the prompt box. No target/query/truth information entered the producer; there were no paid calls, downloads, or source integration changes.
- All 36 outputs were nonempty full-source binary masks, and all passed the independent evaluator's byte, hash, binary-pixel, source-geometry, and pixel-derived-bounds validation. Inference and postprocessing took 761.9 ms; total supervised worker time including model load was 1.41 s. Peak allocated/reserved GPU memory was 1.11/1.61 GB. Producer post-run integrity verification passed.

The frozen producer receipts are ignored `.run/v03/h4c-sam2-ui-box-refinement-v1/freeze.json` (SHA-256 `a61feecf2a6fde20cbd6729d548703abdb0836d6191f0fcfda93c8fafbd6435c`) and `run.json` (SHA-256 `a59c5cda38f31b05f3a59675f9d18f2267f1126bf5b3fc01900da5b7fe1a79cd`). The output has one mask file per frozen `proposal_ordinal` and maps each row back to its original `flat_index`, detector score, and prompt box.

## Independent availability evaluation

After the producer masks and receipts were frozen, the evaluator independently joined them to the exposed labels. It applied the predeclared H4a box-availability rule to mask-derived bounds: IoU at least `0.50` and target coverage at least `0.90` on the same candidate.

| Fixed query | Candidate availability result |
| --- | --- |
| `pilot-v03-ui-01` (positive) | Pass; best-IoU candidate ordinal 13 has IoU and target coverage `0.9029484` |
| `pilot-v03-ui-02` (positive) | Fail; best-IoU candidate ordinal 14 has IoU and target coverage `0.8814496` |
| `pilot-v03-ui-03` (positive) | Fail; best-IoU candidate ordinal 19 has IoU and target coverage `0.8800505` |
| `pilot-v03-ui-04` (absent target) | 36 nonempty proposals; no semantic false-positive decision was measured |

The result is **1/3 positive cases meeting the fixed candidate-box gate**, compared with H4a's **0/3** raw-box availability on the same image. Per case, the highest-IoU mask-derived candidate is also the highest-coverage candidate because each query has one reference box; the pass requires both thresholds on that same candidate. This is only a candidate-availability result: the best mask was selected by the evaluator using exposed truth for measurement, not by a production selector. No pixel-mask reference annotations were available, so this run does not score pixel-level segmentation quality. The absent-target row does not measure a semantic false-positive rate.

## Interpretation and limits

SAM2's box prompt generated full-image masks, not masks cropped to the detector rectangles. The single-case UI screen found one positive whose candidate mask bounds passed both fixed gates, while two positives still missed. The route therefore remains an unqualified research candidate. Do not expose the evaluator's oracle-best candidate as a user-facing choice or claim a general accuracy improvement from one screenshot. No changes were made to the library, public API, dependencies, defaults, or provider selection.
