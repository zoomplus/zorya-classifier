# Candidate-generation alternatives after H2/H3

Research recorded on 2026-10-21 before implementing these alternatives. H2b shows that a useful mask can exist but lose to native quality ranking. H1 shows that an extra zoom decision can also lose the target entirely. We therefore measure candidate availability separately from semantic selection. These are DEV hypotheses, not qualified library features.

## H4a: UI-specific native proposals

Trigger: the frozen H3 screen produces fewer than two usable whole-button candidates across the three positive UI cases. Test a detector trained on interactable screen regions instead of asking a natural-image detector to recognize toolbar controls.

The official [OmniParser model card](https://huggingface.co/microsoft/OmniParser-v2.0/blob/main/README.md) now includes `icon_detect_v3`, a YOLOv9-E interactable-region detector supplied as a TorchScript module with MIT terms. This is a distinct asset from its earlier AGPL `icon_detect`. The documented recipe uses 1280-pixel letterboxing, confidence 0.05 and NMS IoU 0.45. The original [OmniParser paper](https://arxiv.org/abs/2408.00203) motivates screen-element proposals combined with a separate vision-language model. Published screen benchmarks do not establish correctness on our desktop screenshots or game maps.

Before inference, pin the official repository revision, all needed file sizes and actual SHA-256 values, and read the specific model-folder license. Reuse the existing isolated Torch environment; install no Ultralytics runtime, caption model or OCR. Load only explicitly staged local files. Preserve top-left letterbox offsets and actual rounded resized dimensions when mapping predictions to source pixels; reject invalid geometry instead of silently repairing it. A source/model geometry regression must precede live inference.

Run the same frozen four UI DEV inputs first, one detector pass per image. For each source, retain at most 36 post-NMS candidates in stable detector order, record truncation, and feed boxes to the already staged SAM2 adapter. Keep native rectangles and actual mask-derived rectangles distinct. Native scores control only the documented detector operating point; they never become semantic confidence or enter the decision prompt. No target-specific thresholds, color rules, accessibility tree, hidden labels or truth in production input. Evaluate every missing candidate as a miss.

If at least two of three positives have a mask-derived candidate reaching IoU >=0.50 and target coverage >=0.90, write a second plan for closed semantic selection over these actual proposals, including `none`, with the configured DecisionPort. Negative cases may generate proposals: false-positive acceptance is measured after semantic selection, not by candidate count. The first four-case screen is highly correlated and cannot justify a general UI claim. Run all DEV UI sources and independent qualification before promotion. A UI-only win cannot satisfy the photo/UI/map release gate by itself.

## H4b: full-image automatic mask proposals

Trigger: text-conditioned detection repeatedly provides no useful mask for tiny symbols, while image boundaries remain visible. Try semantic-independent candidate generation, then closed decision selection.

The official [SAM2 automatic mask generator](https://github.com/facebookresearch/sam2/blob/main/sam2/automatic_mask_generator.py) samples point grids, batches prompts, removes duplicate masks and can process overlapping crops. Its default 32 points per side means 1,024 prompts; batch size trades memory for latency. This offers a way to escape an incorrect initial seed but may be too costly for our intended application. Inspect model/runtime compatibility and freeze a bounded recipe before implementing it; do not adopt defaults blindly or keep expanding a grid until a desired target appears. Reuse verified local assets, retain packed masks, and measure the number of masks dropped by any cap.

The first test would be candidate availability and timing on the fixed DEV12, without provider calls. Decoder outputs are native proposals, not final detections. A useful mask must still survive deduplication and the cap, then be selected by a model without ground truth. Do not report the best ground-truth-matched candidate as production accuracy.

## Alternatives not selected yet

### H4e: context around detector box prompts

If HQ boundary decoding also plateaus, test one fixed context expansion of the **input prompt**, not the output box. H4a proposals can sit slightly inside the visible object; a box-conditioned model may treat that smaller extent as its intended foreground. The [SAM paper](https://arxiv.org/abs/2304.02643) establishes prompt-conditioned segmentation. [The three-prompt-mode study](https://arxiv.org/abs/2305.00035) reports sensitivity to box perturbations on medical images; its domain and scores do not establish a UI gain. The concrete hypothesis here is that exposing a wider prompt extent may let a segmenter include a visible border it previously excluded.

Before any implementation, freeze a separate H4e protocol: same 36 H4a proposals/order/source and pinned SAM2-Tiny; expand each input box by 25% of its own width/height on each side, clipped to the actual source. This reuses the already chosen context fraction from the H3b presentation; do not search padding values against truth. One full-source embedding, one sole mask per prompt, unchanged binary threshold, no point prompts or per-target exceptions. Preserve both original and expanded prompts. Derive final boxes only from actual output foreground pixels, with no artificial rectangle growth, union with the old box, or filled margins. Retain every empty/error result and compare independently with H4c under the same gate. This is a prompt-sensitivity experiment, not a claim that a larger prompt is always better; nearby controls may merge and reduce correctness. The frozen original run remains the control and is never overwritten.

This is conditional research only; no H4e model run has occurred. Prefer the already running H3b/H4d experiments before spending more effort on boundary alternatives.

[FastSAM](https://github.com/CASIA-LMC-Lab/FastSAM) documents efficient whole-image proposals and point/box/text selection. Its reported speed is measured on another GPU and corpus, and the repository currently carries AGPL-3.0 terms. It is not being bundled into this MIT package. Any isolated comparison would need explicit dependency/license accounting and would not change the package's license silently.

[Semantic-SAM](https://github.com/UX-Decoder/Semantic-SAM) supports multiple segmentation granularities, which is relevant to the object-versus-part failure. Its released setup adds a separate Detectron2 stack and checkpoints. It is deferred while the much smaller semantic selection change and the existing H3 environment are being measured. Merely adding a larger model is not evidence of improvement.

## Stop and promotion rules

Keep the same denominators, negatives, source-coordinate invariants, raw outputs, deadlines and resource receipts. At most two complete DEV comparisons per hypothesis, except a documented implementation-defect repair with a regression. If the candidate ceiling stays low, change the mechanism rather than tuning the selector on unavailable targets. None of these options chooses a provider or downloads a model inside the library; callers continue to supply all ports and assets explicitly.
