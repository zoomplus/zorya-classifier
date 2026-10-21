# H4d SAM-HQ direct versus cached forward smoke

**Result:** the one-prompt direct and cached Transformers routes produced bit-identical finite logits and identical source masks. The cached image-embedding route did not cause H4d's broad bounds for proposal ordinal 0. This diagnostic does not establish general equivalence or evaluate segmentation quality.

## Frozen diagnostic

The frozen recipe is in [the smoke plan](v03-h4d-samhq-cached-forward-smoke-plan.md), and its producer is `benchmarks/v03/h4d-samhq-cached-forward-smoke.py`. It chose H4a proposal ordinal 0 (flat index 2052, box `[1058.3926, 91.0278, 1069.7344, 102.9478]`) before inference, then ran direct forward followed by one cached image encoding and cached forward. It used the existing H4d screenshot, checkpoint, Python 3.12.3 / Transformers 4.57.3 / Torch 2.6.0+cu124 environment, fp16 weights and fp16 autocast, and made no network or provider calls.

The new exclusive ignored output directory is `.run/v03/h4d-samhq-cached-forward-smoke-v1/`. Its freeze is SHA-256 `4cda81c9f58715fd10b3376ab62cead5dbb4eb38202f23f3ebb41e2264a1c72d`; its run is `3401f4ebee42e0bd3d22c9449a6a44b032ecf2131c750b650287394ef934a6e9`; the worker stderr log is `062c5503eca7d106647572981e46534c1314fb4fd2d4d63cced6c744d6fc1c91`. All source, H4a, model/license and producer hashes matched after inference.

Both routes returned finite `pred_masks` of shape `[1,1,1,256,256]` and finite `iou_scores` of shape `[1,1,1]`. The contiguous CPU float32 logit SHA-256 was `0655468e1ce4c9df53cc586e6dd40468f84c9dec013f6e51fb87989a70f81c00` for both. Maximum and mean absolute logit differences were zero, and the exact-equality fraction was 1.0. At the frozen zero threshold, their 1280x800 masks were identical (IoU 1.0), with area 2,752 and actual-pixel bounds `[151,89,1086,696]`. Those bounds and area match H4d's ordinal-0 result. The image and intermediate embeddings were finite; the image embedding was `[1,256,64,64]` float32 and each of the four intermediate embeddings was `[1,64,64,768]` float16.

The process used 1,081,316,864 peak allocated CUDA bytes, 1,226,833,920 peak reserved CUDA bytes and 1,560,399,872 peak RSS bytes. It completed within the frozen 240-second process-group deadline.

**Provenance limitation:** the v1 freeze records the producer, source, H4a inputs and model/license assets before inference, but it does not include runtime package/source hashes. The runtime versions and CUDA device above were captured in the worker result. This is a freeze-record omission; it does not change the observed direct/cached comparison, but means this receipt does not fully satisfy the plan's runtime-hash requirement.

## Decoder source comparison

The suspected HQ-token slice issue is not present in the inspected sources. In Transformers 4.57.3, `SamHQMaskDecoder` starts with four SAM mask tokens, adds the HQ token, increments the total count to five, concatenates the HQ token after the SAM tokens, and slices the transformer output from index 1 through `1 + total_count`. Its loop sends the first four mask tokens through the SAM hypernetwork heads and the final token through `hq_mask_mlp`; the HQ-only branch selects the final HQ mask. The pinned SysCV source follows the same pattern with `hf_token`, `hf_mlp`, and `mask_decoder_hq.py`'s final-token selection. See the [Transformers v4.57.3 implementation](https://github.com/huggingface/transformers/blob/v4.57.3/src/transformers/models/sam_hq/modeling_sam_hq.py) and the [pinned SysCV SAM-HQ decoder](https://github.com/SysCV/sam-hq/blob/e696978d60352dc9a26b12631cd91781502c6546/segment_anything/modeling/mask_decoder_hq.py).

The matching direct result reproduces the broad ordinal-0 mask without using cached embeddings. Thus this smoke rules out a direct-versus-cached mismatch for this one frozen image and box and does not find a token-slice bug. It does not validate every shape/device/runtime, nor explain the model's broad mask; no dtype or threshold change is supported by this result. The historic H4d and H4e receipts remain unchanged, and H4e was not rerun.
