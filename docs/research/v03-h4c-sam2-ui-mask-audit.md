# Independent H4c SAM2 UI mask audit

This report scores the closed H4c run from actual mask pixels. It does not change the H4a box result, select a production candidate, or evaluate semantic acceptance.

## Locked inputs and integrity

The H4c `run.json` SHA-256 is `a59c5cda38f31b05f3a59675f9d18f2267f1126bf5b3fc01900da5b7fe1a79cd`; the external `freeze.json` SHA-256 is `a61feecf2a6fde20cbd6729d548703abdb0836d6191f0fcfda93c8fafbd6435c`. The run binds the frozen H4a output (`d1ff8a0f…`) and freeze (`30ff2cf2…`), the source image SHA-256 `0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09`, all 36 ordered H4a boxes, and the pinned SAM2-Hiera-Tiny checkpoint. Its post-run integrity record is unchanged.

The evaluator verified all 36 ordinal/index/score/box mappings against both the H4a run and H4c freeze, then checked each PNG's SHA-256, byte size, exact 1280x800 canvas, binary 0/255 pixels, foreground pixel area, emptiness, and derived exclusive-max foreground bounds. All 36 masks were valid and nonempty. The recipe produced one source-canvas mask for each frozen box prompt with no clipping and no multimask selection. The evaluator scores only the decoded mask pixels; the recorded `mask_box_xyxy` is checked as a descriptor, not used as the source of bounds.

## Fixed box gate

The unchanged gate requires box IoU >= 0.50 and target coverage >= 0.90 for the same mask-derived box and same reference instance. Each positive UI case has one reference box, so its best IoU and coverage are from the same highest-IoU candidate. The pass flag tests both thresholds together on each candidate/reference pair.

| Opaque case ID    | H4a proposal ordinal | H4a box gate | H4c best mask-box IoU | H4c target coverage | H4c mask-box gate |
| ----------------- | -------------------: | ------------ | --------------------: | ------------------: | ----------------- |
| `pilot-v03-ui-01` |                   13 | Fail         |               0.90295 |             0.90295 | Pass              |
| `pilot-v03-ui-02` |                   14 | Fail         |               0.88145 |             0.88145 | Fail              |
| `pilot-v03-ui-03` |                   19 | Fail         |               0.88005 |             0.88005 | Fail              |

The actual-pixel availability ceiling is therefore 1/3 positives, compared with 0/3 for the original H4a boxes. Every case had 36 valid masks. The absent `pilot-v03-ui-04` query also had 36 valid masks; no semantic false-positive result can be inferred because no selector/classifier was evaluated. These 36 masks are candidate availability, not 36 false positives.

No independent pixel-mask reference exists for these UI rows, so mask IoU against annotation is unavailable. The evaluator's complete raw per-case/per-candidate output is [v03-h4c-sam2-ui-evaluation.json](v03-h4c-sam2-ui-evaluation.json).

## Generality limits

The source is one controlled Geany screenshot with neon editor backgrounds and magenta button borders. Its four query rows are correlated views of one application, theme, resolution, and layout. The 1/3 gate result measures availability on that screenshot only; it does not establish general UI performance or selected-output quality.

The exact offline command was:

```sh
node --import tsx benchmarks/v03/evaluate-h4c-sam2-ui-mask-availability.ts \
  --run /root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h4c-sam2-ui-box-refinement-v1 \
  --run-sha256 a59c5cda38f31b05f3a59675f9d18f2267f1126bf5b3fc01900da5b7fe1a79cd \
  --freeze-sha256 a61feecf2a6fde20cbd6729d548703abdb0836d6191f0fcfda93c8fafbd6435c \
  --h4a-run /root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/ui-proposal-probe-v1/omniparser-ui-boxes-corrected-image-root.json \
  --h4a-sha256 d1ff8a0fd97e6197834c673d399fe9f1ecfcd2d93182ab2a4fd3767e702755a1 \
  --h4a-freeze /root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/ui-proposal-probe-v1/omniparser-ui-boxes-corrected-image-root.freeze.json \
  --h4a-freeze-sha256 30ff2cf2f1894745c8e5e227e35ef1858432c63f55ae454a1e10f86118668753 \
  --image-root /root/work/zorya-classifier-worktrees/v02/corpus \
  --output /tmp/v03-h4c-sam2-ui-evaluation.json
```
