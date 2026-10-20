# Whole-object development variants, 2026-10-20

These are sequential hypothesis tests on an old, exposed photo panel. They do not qualify a public implementation, estimate general accuracy, or replace the independent development/heldout evaluation. Every unknown, timeout and provider failure remains in the reports. No route fallback or HTTP retry was used.

| Frozen variant                                                                  | Physical requests | Known cost, USD | Unknown-cost requests | Result                                                                                                                                |
| ------------------------------------------------------------------------------- | ----------------: | --------------: | --------------------: | ------------------------------------------------------------------------------------------------------------------------------------- |
| [Ordinary Luna with axis rulers](ordinary-luna-axis/run-manifest.json)          |                19 |     0.016908725 |                     2 | Car returned a fragment with approximately 0.123 IoU/coverage; Boat and Dog timed out. The negative did not produce a valid location. |
| [Seed-unbounded extent prompt](seed-unbounded/run-manifest.json)                |                17 |     0.009755705 |                     1 | Neither native nor ordinary Luna completed a correct whole-object result on Car/Boat.                                                 |
| [Outlined original, separate seed crop removed](seed-outline/run-manifest.json) |                10 |       0.0067183 |                     0 | Native Luna located Car with approximately 0.880 IoU and 0.919 visible coverage; Boat remained `extent-uncertain`.                    |

The final variant retains the three-Choice seed locator and the four closed extent Choices. It outlines the seed region on the original image as an interior witness and keeps the axis ruler views. The seed crop does not define the size of the requested object. The successful Car rectangle is `{left:64,top:282,width:960,height:272}` in a 1024×683 source. Its `boundary-limited` completeness remains part of the result.

All variants retained the 8-pixel tolerance, three extent passes and one 45-second deadline. The Car result meets both fixed box criteria (IoU≥0.5 and coverage≥0.9). A parseable `located` result, such as the ordinary-model fragment, is not automatically a quality success.

The reports contain exact physical receipts and immutable source/request hashes. Timing was recorded while the independent Linux native resource test ran; it is diagnostic and ineligible for latency ranking. The three [ordinary](ordinary-luna-axis/summary.json), [prompt-only](seed-unbounded/summary.json) and [outline](seed-outline/summary.json) summaries preserve their failures as well as the single successful example.

Later code also repairs strict trace parsing for actual whole-object `hardRoi` metadata and ordinary ranked axis answers. Earlier artifacts retain their original missing geometry; it was not reconstructed or overwritten after the fact.
