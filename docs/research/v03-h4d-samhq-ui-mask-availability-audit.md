# H4d sequential SAM-HQ mask audit

Independent evaluation of the closed sequential H4d mask run. The run and freeze receipts, H4a source receipts, producer source, model identity, prompt order, and post-run integrity all matched their external pins. All 36 masks were independently decoded as source-sized binary PNGs; their SHA-256 values, foreground areas, and pixel-derived exclusive-max boxes matched the producer descriptors. All 36 were nonempty.

The three positive UI cases had **0/3 candidate masks** passing the fixed same-instance gate of IoU at least 0.50 and target coverage at least 0.90. For each case, the maximum-IoU candidate was ordinal 1; its IoU and corresponding coverage were:

| Case  | Best-IoU candidate |       IoU |  Coverage | Same-candidate gate |
| ----- | -----------------: | --------: | --------: | ------------------- |
| UI-01 |                  1 | 0.0029884 | 1.0000000 | Fail                |
| UI-02 |                  1 | 0.0029884 | 1.0000000 | Fail                |
| UI-03 |                  1 | 0.0029077 | 1.0000000 | Fail                |

Each listed coverage is for the same candidate and reference instance as that row's IoU. The candidate's mask bounding box captures nearly all of each target but is much too large, which leaves IoU near zero. The complete evaluator receipt includes all 36 candidate scores for each of the four cases.

UI-04 is negative and also produced 36 masks. This is only an availability screen, so it does not make a semantic false-positive judgment. The result is limited to one controlled Geany screenshot with neon backgrounds and magenta borders; it is not evidence of general UI localization performance.
