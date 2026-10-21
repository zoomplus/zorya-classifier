# H4e: fixed context expansion for SAM2 box prompts

**Status:** plan frozen before implementation or inference. H4e tests one prompt perturbation after H4c and H4d plateaued. It does not modify the H4a/H4c/H4d artifacts, public library, dependency set, or default model behavior.

## Hypothesis and evidence

SAM is a prompt-conditioned segmentation model. The original paper describes mask prediction from prompts, and the official [SAM2 image predictor](https://github.com/facebookresearch/sam2/blob/main/sam2/sam2_image_predictor.py) encodes a supplied box as its two corner prompts before mask decoding. A detector proposal that is slightly inside a visible object's outer boundary may therefore constrain a segmenter to that smaller extent. H4e tests a single wider input prompt to expose more surrounding context. This is a hypothesis about box-prompt sensitivity, not a claim that the wider box identifies the requested UI element; expanded prompts can include nearby controls or background.

The motivation is the fixed H4c SAM2 screen: 1/3 positive query boxes passed the predeclared bounds-availability rule, and two positives remained just under the 0.90 coverage cutoff. H4d SAM-HQ did not improve candidate availability (0/3). The H4d independent result is [frozen here](v03-h4d-samhq-ui-mask-availability-evaluation.json), SHA-256 `cb466d88c88f8d27bd58bacc4903211e06ab399de62f7bca17cdefd386606798`. These are small, single-source screens; no threshold, prompt, or candidate selection may be tuned against their exposed labels.

## Frozen inputs and recipe

- Reuse exactly the 36 proposals, source image, candidate order, H4a output/freeze, and pinned SAM2 Hiera-Tiny checkpoint from H4c. Source is the 1280x800 controlled Geany screenshot with styled colored button borders, SHA-256 `0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09`. The fixed H4a proposal output is SHA-256 `d1ff8a0fd97e6197834c673d399fe9f1ecfcd2d93182ab2a4fd3767e702755a1`; its freeze is `30ff2cf2f1894745c8e5e227e35ef1858432c63f55ae454a1e10f86118668753`.
- Keep checkpoint `facebook/sam2-hiera-tiny` at revision `7c218beaf0bb87874785f32b582f640134fc1c09`, Apache-2.0, and the existing pinned local assets/runtime used in H4c. No download or new environment is needed or permitted for the inference run.
- For every original XYXY prompt box `[x0,y0,x1,y1]`, calculate `w=x1-x0`, `h=y1-y0`; submit exactly `[max(0,x0-0.25*w), max(0,y0-0.25*h), min(sourceWidth,x1+0.25*w), min(sourceHeight,y1+0.25*h)]`. This is a fixed 25% of the original width and height on each side, clipped only to source bounds. Do not round the transformed prompt values unless the existing processor requires it. Validate every expanded box remains finite and nondegenerate.
- Store both the exact original H4a box and expanded prompt box for every ordinal. Make one image encoding, retain the original order, and request one mask per prompt (`multimask_output=False`). Reuse H4c mask postprocessing and threshold `0.0`; retain empty results and full-source 1280x800 geometry. No point prompts, negative points, extra padding variants, crops, output-box dilation, clipping masks to prompts, artificial box growth, or H4a-box union are allowed.
- Derive mask area and exclusive-max XYXY bounds only from actual foreground pixels. Candidate quality scores are diagnostics only and must not rank, drop, or select results. Do not read query text, target labels, or evaluator truth in the producer.
- Use a distinct exclusive output directory `.run/v03/h4e-sam2-context-prompt-v1/`. Freeze source, H4a inputs, local checkpoint/license assets, script hash, exact box transformations, model/runtime, settings, and the existing 240-second owned-process-group deadline before model loading. Refuse existing paths. After execution, rehash every frozen input and script and write a terminal receipt that captures all candidate masks or the complete failure state. Never overwrite H4c or H4d outputs.

## Independent evaluation and stop rule

Once producer outputs and receipts are closed, an independent evaluator will compare mask-derived bounds against all existing positive target boxes using the unchanged same-candidate gate: IoU `>=0.50` and target coverage `>=0.90`. Keep all 36 candidates for each of three positives, and retain the absent-target row as candidate-availability data only; a returned proposal is not a semantic false-positive judgment. Preserve the evaluator's entire candidate table and report maximum-candidate values only as oracle diagnostics, never as the method's selector or accuracy. No pixel-mask labels exist for this screen, so no pixel-level segmentation claim is available.

Compare H4e with the unchanged H4c 1/3 screen and report all cases. Do not tune the fixed margin after seeing outcomes. The source is one controlled Geany screenshot and does not support general UI claims. If this single frozen expansion fails to improve candidate availability, stop this prompt-expansion route and choose a different mechanism rather than further tuning on these labels.

## Validation before inference

Add synthetic tests for exact 25%-per-side geometry, source-edge clipping, retaining original and expanded boxes, rejecting nonfinite/degenerate inputs, keeping mask bounds pixel-derived and unmodified by prompt expansion, and preserving empty/full-source masks. No real checkpoint loading is needed for tests. Run the actual inference only once after plan and implementation are committed/frozen; no paid model calls are part of this experiment.
