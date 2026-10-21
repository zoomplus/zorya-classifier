# H4f: preserve local pixel detail for proposal segmentation

Prospective, conditional experiment. No inference has been performed for this profile. Run only if independent H4e evaluation finds fewer than two usable UI masks among the three fixed positive queries. H4c/H4d/H4e artifacts remain immutable. This is a candidate-availability probe, not semantic selection or a public strategy.

**Execution decision:** H4e's independent aggregate reports 3/3 available positive masks, so this trigger is not met. Do not execute H4f on this cohort. Keep the hypothesis as a documented alternative; semantic selection of the available masks is the next unresolved step.

## Rationale and distinguishing mechanism

H4a proposals cover small toolbar buttons, whereas H4c encodes the entire 1280x800 screenshot at the segmenter's fixed internal resolution. Enlarging a box prompt (H4e) changes the prompt but does not allocate more image-encoder pixels to the object. H4f instead encodes a context crop for each proposal. The hypothesis is that local image detail, rather than merely a looser rectangle, is limiting the mask boundary.

The official [SAM 2 automatic-mask generator](https://github.com/facebookresearch/sam2/blob/main/sam2/automatic_mask_generator.py) includes crop layers, maps masks back to source coordinates and filters masks touching internal crop boundaries. [SAHI](https://arxiv.org/abs/2202.06934) studies slicing for small-object detection. These motivate the resolution experiment; neither establishes success for our tiny segmenter, styled buttons, maps or whole-object extraction. H4f uses the already pinned local SAM2 model and existing Transformers runtime, not the official AMG implementation, and must be identified accordingly.

## Frozen recipe

- Replay all 36 H4a boxes, in original order, on the same verified source. No target text, truth, reference boxes, native-quality ranking or label-dependent cropping enters this producer.
- Use exactly H4e's box prompt expanded by 25% of its own width and height on each side and clipped to the source.
- Around each original proposal center construct a context crop with width `max(128, 3 * proposalWidth)` and height `max(128, 3 * proposalHeight)`, rounded outward and clipped to the source. Require the entire expanded prompt to remain inside the context crop; fail a malformed transform rather than repair it from truth.
- Encode the actual source crop through the same SAM2 processor, with no grayscale, recoloring, edge enhancement or synthetic pixels. The model's normal resizing is recorded. This is the only semantic mechanism changed from H4e.
- Use the same pinned SAM2 assets, float16 policy, single-mask box decoding and zero-logit threshold. Run crops serially in one owned child, retain no per-crop GPU tensor after its mask has been transferred to CPU, and release each image embedding before the next encoding.
- Restore each binary mask to its actual crop pixel dimensions, then translate its foreground into an otherwise empty source-size mask. Never rescale source coordinates twice, stretch a box or fill pixels to improve coverage.
- A mask touching an internal crop edge is unresolved because the visible object may continue beyond the crop; keep its diagnostic mask but exclude it from usable candidates. Source-image edges are allowed. No second crop/expansion/retry in this profile.
- Keep all 36 records, including empty, truncated and errored proposals, with original and transformed prompt/crop bounds, binary-mask hashes, actual foreground bounds, edge status, timings and resource peaks. Independent evaluation derives bounds from mask pixels.

## Bounds and controls

One 240-second owned-process deadline; no parallel GPU worker, model/provider call, new download, new package dependency or fallback. Use streamed asset hashes and freeze the producer/import closure, environment, checkpoint files, H4a/H4e receipt identities, geometry policy and source before execution. Rehash after physical child exit. Do not modify a shared Python installation.

Before inference, test outward rounding and clipping, tiny/edge/full-source boxes, invalid/nonfinite boxes, box-within-crop invariant, exact crop/source pixel translation and internal-versus-source edge classification. A synthetic mask crossing an internal crop edge must not become a successful complete object. Test finite logits before thresholding so numerical errors are technical failures.

The evaluator uses the unchanged same-candidate/same-reference IoU >=0.50 and coverage >=0.90 gate. Report all three positive queries and the absent-target query; candidate availability cannot establish negative rejection. Compare the complete retained candidate set to H4e, not an oracle-picked candidate supplied back to the producer. At least two usable positives and no artifact/transform defects are required to justify a later semantic-selection pilot. Do not rerun for a better score. Failure triggers a different mechanism rather than a sweep of crop sizes.

This controlled screenshot has styled backgrounds and borders; any improvement must subsequently be tested on unmodified natural interfaces and other object types before promotion.
