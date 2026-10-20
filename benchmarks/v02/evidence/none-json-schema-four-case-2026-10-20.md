# Four-case transport diagnostic

This is an exposed-development functional diagnostic, not fresh qualification or a latency ranking. It used four previously exposed cases and kept the predeclared whole-object criteria and 8-pixel boundary tolerance unchanged. The evaluator truth was joined only after the producer completed.

The run used the `grammar-plus-examples` prompt and `none-json-schema` transport uniformly for all six text encoders and the no-image control. The native Luna control used its pinned OpenAI Decisions route. Both provider routes remained pinned with no fallback and no retries. The timing context was `concurrent-native`.

The producer completed 32 case-candidate results with 100 physical HTTP fetches: 79 Together responses were HTTP 200, while the native route returned 20 HTTP 200 responses and one HTTP 502. The missing usage receipt leaves one call's cost unknown. Known cost was `$0.279921184`; with the `$0.02` unknown-cost reserve, accounted exposure was `$0.299921184`, within the `$5` cap. Dispatch p50/p95 were 929/5,627 ms, but those timings are excluded from route ranking because native CPU work was concurrent.

Across the three positive cases, every candidate had zero whole-object localization matches under the frozen IoU and coverage criteria. Each had zero false locations on the one explicit negative case. Text classification correctness was: ascii-luma 1/4, palette-grid 2/4, svg-contours 0/4, pixel-rle 0/4, ascii-contours 1/4, and ascii-svg-layered 0/4. The native vision control was 3/4. The contour and layered encoders hit local representation limits on all four inputs; these remain failed attempts, not omitted rows. The no-image control returned `unknown` rather than a binary classification on all four cases. Its localization stage also returned the string `unknown` on all four; the current evaluator maps that string to `failed`, so those localization failure counts describe evaluator normalization as well as control behavior.

These exposed cases do not qualify a winner. In particular, zero matches across three positive cases is insufficient evidence for localization, and one negative case gives only a coarse false-location check. No fresh heldout truth or outcomes were opened for this run.

The immutable run ID is `v02-diagnostic-2026-10-20T083628062Z-bb80caf9` under `.run/v02/`. Its evidence hashes are:

- Run manifest: `9a9a60548371fca1f944846d39ec045359d5eecadb01777c278f2e9826660877`
- Run summary: `74ead68264eb4a6ef95d8bb1ca2484e5dc8c005fcd27c593b0969784b1461e0f`
- Evaluator output: `14b12147a55fa5cbb8b5612fa05b71e47d90eb8215a467aa62a68691e49c4a1f`
- Run completion receipt: `ad3cd5376e5665a6567449dfb655cb398c47c15792df95e8843cdac5efdc9020`
- Producer input manifest: `df3edf915aef5ad33ebcac05d8dd7ff3a95acc797d1667dd949d350f6de8a4ed`
- Prompt variant: `grammar-plus-examples`, SHA-256 `e442e9dc2bb920db4bf91b11e6b1e7f507f78f3a778af19fcdb79e98eb87cf5d`
- Transport variant: `none-json-schema`, SHA-256 `e9d94773b78e697584eb819ef31d400759435e56d1bf26221007e2225d820e0f`
