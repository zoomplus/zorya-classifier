# H3b grounded-mask selected-output evaluation

The frozen H3b selected-output run is a clean technical execution, but it fails the intended localization and negative-case gates. Independent evaluation verified all 12 persisted case rows against `run.json`, the H3 native run and native case-row hashes, source-image identities, output PNG byte hashes, binary source-canvas mask pixels, and exact pixel equality between each completed emitted mask and the selected frozen H3 native candidate. There were no invalid artifacts.

Only rows whose producer status and final box-check verdict were both `complete` counted as outputs. Diagnostic/no-choice rows remained missing. Of the nine positive cases, **3/9** passed the fixed same-reference gate (IoU ≥ 0.50 and target coverage ≥ 0.90); all three were photos. UI passed 0/3 and maps passed 0/3. The three negative cases each received a completed box, so the negative false-box count was **3/3** and correct `none` was **0/3**.

| Case     | Stratum        | Final result      |      IoU | Target coverage | Gate      |
| -------- | -------------- | ----------------- | -------: | --------------: | --------- |
| photo-01 | photo          | complete          | 0.985268 |        0.994763 | Pass      |
| photo-02 | photo          | complete          | 0.953923 |        0.953923 | Pass      |
| photo-03 | photo          | complete          | 0.927776 |        0.927776 | Pass      |
| photo-04 | photo negative | complete box      |        — |               — | False box |
| ui-01    | UI             | `none`, no output |        — |               — | Fail      |
| ui-02    | UI             | `none`, no output |        — |               — | Fail      |
| ui-03    | UI             | complete          | 0.002826 |        1.000000 | Fail      |
| ui-04    | UI negative    | complete box      |        — |               — | False box |
| map-01   | map            | complete          | 0.015371 |        1.000000 | Fail      |
| map-02   | map            | complete          | 0.465116 |        0.465116 | Fail      |
| map-03   | map            | complete          | 0.000000 |        0.000000 | Fail      |
| map-04   | map negative   | complete box      |        — |               — | False box |

The IoU and coverage columns come from the same selected mask-derived box and reference instance for each positive. `none` rows remain in the positive denominator. The map-01/UI-03 boxes cover almost all of the target but also include too much surrounding area, resulting in very low IoU. Map-02 is below both thresholds.

One positive reference-mask file was available and evaluable: photo-02 mask IoU was 0.902043. The other eight positive cases had no independent pixel-mask reference in this cohort; their mask IoU is unmeasured, not zero. The run used 22 physical provider calls at $0.0046691 known cost, with zero unknown-cost or in-flight calls and zero recorder persistence failures. Per-case latency and receipts are retained in the machine-readable evaluator output.

The raw output was locked with H3b `run.json` SHA-256 `1dd6408dc1b584ddd884c79ee5c0afea17f85ca3c607e4d3fc2fc6fa602e89d5` and `freeze.json` SHA-256 `ec7d2b70e75da3202765b658c040ce29af1f5e6735362ca35f436a6f29efdd8c`; the bound H3 native run SHA-256 is `df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401`. This is a fixed DEV-only diagnostic, not a qualification result.
