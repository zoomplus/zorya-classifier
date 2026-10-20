# Text-only image encoding comparison

No candidate qualified for localization. The public `experimental-text` selector therefore remains explicitly `UNSUPPORTED`; research codecs are not shipped in `dist`. These results do not affect ordinary text classification or supported vision inputs.

The independent DEV subset contains 16 positive/4 explicit-negative licensed photographs and 7 positive/3 scoped-negative real Geany UI captures. All positive cases remain in the denominator, including semantic unknowns, representation limits and errors. No heldout image was revealed and no winner was selected.

| Representation      | Classification /30 | Whole photo /16 | Whole UI /7 | False locations /7 |
| ------------------- | -----------------: | --------------: | ----------: | -----------------: |
| ASCII luminance     |                  6 |               0 |           0 |                  1 |
| Palette grid        |                 10 |               0 |           0 |                  0 |
| SVG contours        |                  6 |               0 |           0 |                  0 |
| Pixel RLE           |                 11 |               0 |           0 |                  3 |
| Binary/edge ASCII   |                 15 |               0 |           0 |                  2 |
| Layered ASCII + SVG |                  9 |               0 |           0 |                  0 |
| No image control    |                  7 |               0 |           0 |                  0 |

Every profile uses explicitly pinned DeepSeek Flash/Together, the same task questions and closed classes, grammar plus two synthetic examples, and no provider/model fallback. Text encodings and no-image control send zero image parts. The control removes only image parts while retaining the same questions, options and target. Encoding sends no OCR, semantic labels, hidden segmentation or evaluator truth.

The original six classification stages were rejected locally with `UNSUPPORTED` before fetch because the harness omitted the representation selector. Their failed summaries remain unchanged. A real-adapter wire regression now verifies encoded content and the absence of image parts. Separate classification-only follow-ups repeat those stages with the selector fixed. Localization from the original runs remains unchanged. Classification-only results are joined by exact case/image identity in the independent evaluation; they are not described as one continuous producer run. SVG and layered classification each encounter 20 local representation-limit failures, which remain in their 30-case denominators.

[The numeric report](report.json) records all counts, original/follow-up aggregates and raw-file hashes. Each profile directory preserves both original evidence and any classification-only follow-up, plus the independent joined evaluation. Local resource limits do not consume an invented HTTP request. Failed/unknown localization is never converted into an absent label or successful object box.

All six profiles produce zero whole-object photo matches, as does the no-image control. Some additionally violate the false-location requirement. They cannot establish the required positive localization improvement, so none proceeds to blind heldout qualification. The missing map stratum does not rescue a profile with zero primary photo-localization successes. Timings were recorded during concurrent development and are excluded from latency ranking.
