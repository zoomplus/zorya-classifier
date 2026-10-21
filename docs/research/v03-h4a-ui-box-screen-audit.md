# Independent H4a UI proposal screen audit

This audit checks the closed H4a output independently from its evidence writeup. It uses only the completed producer receipt and the already exposed DEV12 UI references. It does not select a detector candidate, infer semantic acceptance, or claim production behavior.

## Frozen receipts and coordinate audit

The completed output SHA-256 is `d1ff8a0fd97e6197834c673d399fe9f1ecfcd2d93182ab2a4fd3767e702755a1`; its pre-inference freeze SHA-256 is `30ff2cf2f1894745c8e5e227e35ef1858432c63f55ae454a1e10f86118668753`. The run record reports `state: complete`, unchanged after inference, and matches the fixed UI manifest SHA-256 `5732d534990bfa98299a4e85f760acfa5319e0193e86bc182853558786cb0e9f` and source image SHA-256 `0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09`.

The source raster and model canvas are both 1280x800. The recorded resize is 1280x800 with `scale_x = scale_y = 1`, zero padding, and no clipping offsets. I recomputed source coordinates from every retained `box_canvas_xyxy` with the recorded scale and padding: all 36 match the stored `box_xyxy` within 1e-9, have positive area, and remain within the source canvas. Thus this run's source transform is identity; the result does not exercise nontrivial resize or padding inversion. The producer retained 36 of 76 NMS survivors and truncated 40 at the predeclared cap.

## Fixed whole-box gate

I scored each retained source box against the matching truth box with box IoU and target coverage `intersection / truth_area`. The fixed gate requires both IoU >= 0.50 and target coverage >= 0.90. These are the maximum-IoU proposals, not necessarily the top confidence proposal.

| Case              | Best box IoU | Target coverage | Gate | Proposal index | Confidence |
| ----------------- | -----------: | --------------: | ---- | -------------: | ---------: |
| `pilot-v03-ui-01` |      0.88536 |         0.88536 | Fail |             13 |    0.61791 |
| `pilot-v03-ui-02` |      0.89568 |         0.89568 | Fail |             14 |    0.60754 |
| `pilot-v03-ui-03` |      0.84584 |         0.84584 | Fail |             19 |    0.55929 |

All three positives miss the fixed coverage threshold. In each case the best box is inset within the reference, so IoU and target coverage are equal. The absent Undo query also has 36 proposals, but proposal availability without a downstream semantic selector is not a false-positive decision. No mask refinement or selected output was measured here.

## Scope

This is one controlled Geany screenshot with a neon editor background and magenta UI borders. Its four query rows share one source image, so they are correlated observations of a single application, screenshot, theme, and layout. The detector's candidates are visually concentrated around controls in this styled screen, but these results do not establish performance on other applications, themes, resolutions, or screenshot conditions.
