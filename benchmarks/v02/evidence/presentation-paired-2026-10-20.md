# Paired numeric and axis-ruler presentation pilot

This exposed development diagnostic compares `numeric-v1` and `axis-rulers-v1` with the same pinned Luna Decisions/OpenAI route, 8-pixel tolerance, three extent passes and one 45-second operation deadline. Four old cases form eight paired operations. There are no retries or fallback routes. This is not an independent development or heldout comparison.

The immutable run is `v02-presentation-paired-2026-10-20T093014953Z-3845475e`. Its manifest SHA256 is `4b05117cd3e6ed41019bb9050ccbb5a6e102880f21cfb37707b9aba28bddd4e1`; raw summary SHA256 is `4b1746c9de2a97b257697f925074558c3294441857640b891316049826e930c8`. The [sanitized summary](../../../docs/evidence/v02/presentation-paired-20261020.json) retains each outcome and physical receipt.

There were 33 physical fetches: 31 HTTP 200 receipts identified `openai/gpt-6-luna-decisions-20261006` / OpenAI; two HTTP 502 responses have unknown charges. Known cost was $0.0174553, with $0.04 of unknown-cost reservations ($0.0574553 accounted exposure). Neither variant located any of the three positives. Both failed on the first photo; both returned uncertain extent on the car and boat. The negative ended uncertain for numeric and inconsistent for axis rulers. Unknown and failed outcomes remain in the denominators.

Selected Choice IDs, raw scores and numeric interval selections are retained. The extent geometry trace incorrectly rejected the actual metadata object because its strict schema omitted `hardRoi`; explicit seed/current bounds are null in this run. Missing geometry is not reconstructed from an assumed index or from reference truth. Future schema fixes do not mutate these artifacts.

Latency was measured concurrently with the Linux native soak (dispatch p50 4.70 s, p95 12.04 s); it is diagnostic only. The pilot does not establish a winning presentation or production readiness. Further named development variants are required before independent qualification.
