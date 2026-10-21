# H9 target-blind mask identity: closed DEV result

**Status: closed and rejected (2026-10-21).** H9 tested a two-stage target-blind factual description followed by a closed text-only identity comparison on the frozen H8a Luna selected masks. The corrected live run completed transport and independent evaluation; it **failed** the predeclared continuation gate. This is not a production promotion, release recommendation, or claim of general accuracy improvement.

## Gate (unchanged criteria)

From [the prospective plan](v03-h9-target-blind-mask-identity-plan.md): retain at least **7/9** positive same-mask successes versus the frozen H8a baseline and **zero false outputs** among the three fixed negatives. Do not lower the positive bar to gain negative rejection; do not tune on the same twelve cases after failure.

| Metric                      | Required     | H9 corrected run |
| --------------------------- | ------------ | ---------------- |
| Positive same-mask retained | ≥ 7/9        | **2/9**          |
| Photo stratum               | (within 7/9) | **2/3**          |
| UI stratum                  | (within 7/9) | **0/3**          |
| Map stratum                 | (within 7/9) | **0/3**          |
| Negative false outputs      | 0            | **0**            |

H8a remains **7/9** positive same-mask with two historical false outputs on the same fixed negative cohort (`pilot-v03-photo-04` and `pilot-v03-ui-04`); `pilot-v03-map-04` was correctly absent. H9 abstained on all three negatives (no retained mask), so the negative half of the gate is satisfied but the positive retention requirement is not. Only `pilot-v03-photo-01` and `pilot-v03-photo-02` matched and preserved H8a mask bytes; no UI or map positive retained a mask.

## Twelve-row outcomes (semantic)

| case_id            | truth   | H8a baseline same-mask | status          | closed outcome        | retained mask        |
| ------------------ | ------- | ---------------------- | --------------- | --------------------- | -------------------- |
| pilot-v03-photo-01 | present | pass                   | complete        | match                 | yes (baseline hash)  |
| pilot-v03-photo-02 | present | pass                   | complete        | match                 | yes                  |
| pilot-v03-photo-03 | present | pass                   | complete        | mismatch              | no                   |
| pilot-v03-photo-04 | absent  | fail                   | complete        | mismatch              | no                   |
| pilot-v03-ui-01    | present | pass                   | complete        | insufficient-evidence | no                   |
| pilot-v03-ui-02    | present | pass                   | complete        | insufficient-evidence | no                   |
| pilot-v03-ui-03    | present | pass                   | complete        | insufficient-evidence | no                   |
| pilot-v03-ui-04    | absent  | fail                   | complete        | insufficient-evidence | no                   |
| pilot-v03-map-01   | present | pass                   | complete        | insufficient-evidence | no                   |
| pilot-v03-map-02   | present | fail                   | complete        | insufficient-evidence | no                   |
| pilot-v03-map-03   | present | fail                   | complete        | insufficient-evidence | no                   |
| pilot-v03-map-04   | absent  | n/a                    | skipped_no_mask | —                     | no (H8a had no mask) |

Negative accounting: one explicit **mismatch** (`photo-04`), one **insufficient-evidence** abstention (`ui-04`), one **skipped_no_mask** (`map-04`, no H8a baseline mask). **False outputs: 0/3.**

## Corrected live run (authoritative semantic result)

- Run directory (preserved off-repo): `h9-wire-corrected-live-9d9d68be-56e9-49ec-9583-2beaaed8638e`
- **22/22** physical requests returned HTTP **200** with schema-valid structured responses; **12** rows finalized in fixed order.
- Budget: known cost **USD 0.00649876**; unknown-cost calls **0**; in-flight **0**.
- **Request-level latency** (per physical `duration_ms` only, **not** end-to-end production-pipeline latency): p50 **6542.566 ms**, nearest-rank p95 **22731.537 ms**, sum **192348.566 ms** across 22 requests.
- Source closure: **53** unique closure entries independently hash-matched; evaluator `sourceFilesVerified` **159** is three verification passes over those same entries, not 159 unique files.

Immutable identities:

| Artifact                               | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| H9 run JSON                            | `cfee4f009e0219524178cf3ba39c1f4ed48c924c833a6959e2f300f7cfcf9240` |
| H9 freeze JSON                         | `1ee99de162d23dd997302a4c3268114a6dabf64bea8384beae6c16e76a33b665` |
| Independent evaluation JSON (run root) | `987fd22e28b53099b52045b6f96b28fb329bec0253c1539f215859754967f646` |

Sanitized machine-readable scores: [independent evaluation JSON](../evidence/v03/h9-target-blind-mask-identity-independent-evaluation.json) (repository copy; gate rows and production audit fields whitelisted from the evaluator artifact).

## Prior stopped run (technical failure only)

Separate preserved run: `h9-target-blind-final-a9d66c07-cc14-40cc-b324-98300a3b52a8` (status **stopped**). This is **not** the semantic gate result above.

- **7** total physical calls: **3** known-cost (**USD 0.001513025**) + **4** unknown at **USD 0.05** reserve each → **USD 0.201513025** accounted exposure.
- Stage 2 **HTTP 400** on closed-identity requests: OpenAI rejected the wire JSON Schema because `uniqueItems` on `evidenceRefs` is outside the supported structured-output subset (bounded schema-only defect).
- Run stopped after repeated stage-2 failures and controlled shutdown on the in-flight photo-04 stage-1 call; remaining rows never started.

Bounded repair (schema-only, no retry of the stopped dispatch): OpenAI rejected the wire JSON Schema because `uniqueItems` on `evidenceRefs` is outside the supported structured-output subset; the repair removed that keyword from the wire schema sent to the provider and kept duplicate-evidence checking in local Zod validation. Prompts and semantic behavior were unchanged. The corrected run used the repaired wire schema (`h9-closed-identity.schema.json` hash `2853a065290cc8f5c51b9f52b0cc07a04d98e4cf9bb9530696e3cb93b2b6c8ae` in its freeze) and completed all twelve rows.

## Interpretation (diagnostic only)

Target-blind facts plus text-only comparison **did not** preserve H8a’s seven positive same-mask selections. Most losses are **insufficient-evidence** abstentions on UI and map positives that H8a had already passed at the same-mask gate, plus one photo **mismatch** on a baseline-passing mask. That pattern is consistent with stage-two text comparison lacking application or game-specific identifiers that H8a’s target-aware stages implicitly used, not with a demonstrated accuracy gain. The pilot does not justify integrating this verifier into the library path, qualification, or release.

**Prohibition:** Do not prompt-tune, threshold-search, or re-run variants on these same twelve frozen cases to chase a passing gate. Any future hypothesis needs a separately named recipe and freeze.
