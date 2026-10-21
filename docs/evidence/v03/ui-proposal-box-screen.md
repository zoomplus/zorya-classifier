# H4a UI proposal box screen

**Result:** one bounded detector pass completed on the frozen single Geany UI screenshot. This is a diagnostic proposal-availability screen only; no SAM refinement, semantic selection, provider call, or production integration was run.

## Frozen run

- Input manifest: `benchmarks/v03/pilot-inputs/ui.json`, SHA-256 `5732d534990bfa98299a4e85f760acfa5319e0193e86bc182853558786cb0e9f`.
- Four fixed queries share one 1280x800 screenshot. Source SHA-256 `0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09`; 39,902 bytes.
- Model: `microsoft/OmniParser-v2.0`, revision `f55d0750e5b94db2125ef0b45b0fa4a85ddc59b4`, `icon_detect_v3/model.pt`; SHA-256 `11c6cbb77f22569fab22d86c76407a83ec81ab89dbfe28279854822d6e3fb00c`, 281,182,680 bytes. The colocated MIT license SHA-256 is `646f8936b8ddcd14e13e578ff6857e368780b0d1a4f6066bee89211923a373e2`, 1,073 bytes.
- Runtime: Python 3.12.3, Torch 2.6.0+cu124, TorchVision 0.21.0+cu124, CUDA 12.4, NVIDIA GeForce RTX 4080.
- Recipe: fixed 1280 top-left letterbox; confidence `>0.05`; NMS IoU `0.45`; stable score/index order; keep at most 36; 240-second worker-process-group deadline.
- Script SHA-256 in the pre-inference freeze: `fd1cc46823913e143219dcb4e2faf28393f21324b146e14d9feebbb6d58d217d`.

The model emitted 76 boxes after confidence filtering and NMS; 36 were retained and 40 were truncated by the predeclared cap. No box fell entirely in letterbox padding. Detector wall time was 2.14 seconds; complete supervised worker time was 4.42 seconds. The producer rehashed its code, manifest, image, model and license after inference; all matched the pre-inference hashes.

## Exposed-truth comparison

After the producer outputs and freeze were written, I compared the retained source-coordinate boxes against the existing evaluator-only references in `benchmarks/v03/evaluator-data/pilot-truth.json`. For each positive query, I report the best IoU candidate and its target coverage (intersection divided by reference-box area). A “usable box” for this gate requires both IoU `>=0.50` and coverage `>=0.90`.

| Fixed query | Best candidate IoU | Target coverage | Meets box gate |
| --- | ---: | ---: | --- |
| Forward (`pilot-v03-ui-01`) | 0.8854 | 0.8854 | No |
| Back (`pilot-v03-ui-02`) | 0.8957 | 0.8957 | No |
| Open document (`pilot-v03-ui-03`) | 0.8458 | 0.8458 | No |
| Undo absent (`pilot-v03-ui-04`) | — | — | 36 proposals; no semantic acceptance measured |

The detector closely proposed each positive toolbar button, but every best box was slightly inset and missed the fixed 0.90 coverage cutoff. Therefore the result is **0/3 positives meeting the predeclared box-availability gate**. This is not a mask result, and no threshold was adjusted after seeing it. The absent Undo query demonstrates that proposal presence alone does not establish a false-positive decision rate.

## Receipts and limits

Full output: ignored `.run/v03/ui-proposal-probe-v1/omniparser-ui-boxes-corrected-image-root.json`, SHA-256 `d1ff8a0fd97e6197834c673d399fe9f1ecfcd2d93182ab2a4fd3767e702755a1`.

Pre-inference freeze: ignored `.run/v03/ui-proposal-probe-v1/omniparser-ui-boxes-corrected-image-root.freeze.json`, SHA-256 `30ff2cf2f1894745c8e5e227e35ef1858432c63f55ae454a1e10f86118668753`.

The first CLI invocation used the wrong local image root and failed source-file preflight before model loading; its failure receipt remains separately preserved under `.run/`. The successful rerun used the verified source at `/root/work/zorya-classifier-worktrees/v02/corpus/benchmarks/cache/v02/corpus/independent-ui/geany-dev-oracle-20261020-run02.png`. Four queries over one application screenshot are correlated and do not establish general UI performance. Do not report these box proposals as selected detections or as evidence of overall accuracy.
