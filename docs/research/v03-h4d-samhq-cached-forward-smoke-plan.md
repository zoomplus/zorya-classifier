# H4d technical check: direct versus cached SAM-HQ forward

**Status:** this one-box numerical diagnostic is frozen before inference and will not inspect labels or evaluate against ground truth. H4d's accuracy interpretation remains provisional until this runtime path is checked.

## Reason for the check

The H4d sequential run reported 36 nonempty masks with very broad pixel bounds, all sourced through a cached image-embedding path. Before interpreting that as SAM-HQ behavior, verify that the installed Transformers API's cached route produces the same raw mask logits as the direct path on identical pixels and a fixed prompt. This targets an implementation-sensitive path; it is not a new accuracy hypothesis and must not modify, replace, or invalidate the historic H4d receipts.

## Pinned inputs and API under test

- Use the exact H4d source image and verified local checkpoint already frozen by H4d: source SHA-256 `0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09`; `syscv-community/sam-hq-vit-base` revision `f906a2e3f60fda2f12eb717cef18614f66c43124`, Apache-2.0, and local checkpoint/config/license hashes from the H4d receipts.
- Select exactly H4a proposal ordinal `0` before this diagnostic, regardless of its label or historical mask outcome. Use its original unexpanded H4a XYXY box from the frozen H4a file and the same preprocessor-generated pixel values/box tensor for both paths. Do not load query names, target labels, evaluator reports, or existing output masks.
- Reuse the existing Python 3.12.3 / Transformers 4.57.3 / Torch 2.6.0+cu124 environment and `cuda:0`, with fp16 model weights and autocast exactly as the H4d producer used. No downloads, package changes, provider calls, or paid calls.
- The installed `transformers.models.sam_hq.modeling_sam_hq.SamHQModel.get_image_embeddings` implementation was inspected. It returns `vision_output[0]` and `vision_output[1]`; `SamHQModel.forward` accepts optional `image_embeddings` and `intermediate_embeddings` and describes the latter as required alongside precomputed image features. Record these installed-source/API identities and observe actual returned shapes, dtypes, and finite status. The direct path is `model(pixel_values=..., input_boxes=..., multimask_output=False, hq_token_only=True)`. The cached path is one `get_image_embeddings(pixel_values)` call followed by `model(image_embeddings=..., intermediate_embeddings=..., input_boxes=..., multimask_output=False, hq_token_only=True)`.

## Fixed comparisons and outputs

Run both paths sequentially on the same loaded model, source, and one-box tensor, in that fixed order. For each, record raw `pred_masks` and `iou_scores` shape/dtype/finite status and a SHA-256 of contiguous CPU float32 mask logits. If outputs are finite and shape-equal, calculate max/mean absolute logit difference, exact-equality fraction, and binary-mask IoU using the fixed zero threshold. Retain actual pixel-derived bounds for each path as a secondary diagnostic. Do not change dtype or thresholds based on these results; test fp32 only in a separately frozen follow-up if evidence of a numerical fault is confirmed.

Freeze script/input/asset/runtime hashes before model loading; rehash after. Use a new exclusive path `.run/v03/h4d-samhq-cached-forward-smoke-v1/`, no overwrite, offline mode, and the same 240-second child-process-group deadline/kill-and-join behavior as the producers. Record the direct/cached call count, CUDA peak allocated/reserved bytes, process maximum RSS, and complete errors. No truths or pixels need to be committed.

## Interpretation

Matching finite logits and masks would support the cached API plumbing for this one prompt but would not establish general numerical equivalence across shapes, devices, or the model. A mismatch, nonfinite output, unexpected embedding shape, or execution error suspends H4d model-quality conclusions pending a code-level diagnosis. Preserve all old H4d receipts and report this smoke separately. Do not alter the H4d outputs, rerun its 36 prompts, or tune against the exposed UI labels.
