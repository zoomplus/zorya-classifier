# H10 CLIPSeg direct mask: closed DEV result

**Status: closed and rejected (2026-10-21).** H10 tested one-shot text-conditioned dense segmentation via the frozen CLIPSeg producer on the same fixed twelve-case DEV cohort used by prior v03 localization pilots. The bounded local run completed all **12** rows with **integrityErrors** empty and **zero** provider physical calls; independent evaluation **failed** the frozen H10 advancement gate. These are fixed-cohort DEV observations only—not a claim that CLIPSeg cannot localize in general, not an accuracy improvement, and not a production or qualification recommendation.

## Gate (unchanged criteria)

From [the prospective plan](v03-h10-clipseg-direct-mask-plan.md): on candidate masks, **mask-derived decision-box IoU ≥ 0.50** and **reference-box coverage ≥ 0.90** on the same reference instance (whole-object rule). Aggregate DEV gate: at least **7/9** positive same-object successes and **0/3** false outputs on negatives.

| Metric                         | Required | H10 completed run |
| ------------------------------ | -------- | ----------------- |
| Positive same-object successes | ≥ 7/9    | **0/9**           |
| Negative false outputs         | ≤ 0/3    | **1/3**           |

**Baseline context (not H10 targets):** frozen **H8a** observed **7/9** positive same-object successes and **2/3** false outputs on the same fixed negative cohort.

## Twelve-row ledger (denominators)

- **12/12** rows finalized in fixed order (`row_count` 12; run status **completed**).
- **4** rows emitted a **nonempty mask candidate** (three photo positives, one photo negative).
- **8** rows were valid **unresolved_empty** outcomes (zero foreground after `logit >= 0`): six positives (all UI and map positives) and two negatives (`ui-04`, `map-04`).

## Per-row gate evidence (positives and false output)

| case_id (stratum)  | truth   | Producer outcome | Gate result | IoU (decision box) | Reference coverage | Notes                               |
| ------------------ | ------- | ---------------- | ----------- | ------------------ | ------------------ | ----------------------------------- |
| pilot-v03-photo-01 | present | candidate mask   | fail        | 0.8677450661       | 0.8900384283       | coverage < 0.90                     |
| pilot-v03-photo-02 | present | candidate mask   | fail        | 0.8024148344       | 0.8028552008       | coverage < 0.90                     |
| pilot-v03-photo-03 | present | candidate mask   | fail        | 0.3733355423       | 1.0000000000       | IoU < 0.50 (oversized decision box) |
| pilot-v03-photo-04 | absent  | candidate mask   | **false**   | (passes box gate)  | —                  | negative false output (1/3)         |
| pilot-v03-ui-01    | present | unresolved_empty | n/a         | —                  | —                  | valid empty mask                    |
| pilot-v03-ui-02    | present | unresolved_empty | n/a         | —                  | —                  | valid empty mask                    |
| pilot-v03-ui-03    | present | unresolved_empty | n/a         | —                  | —                  | valid empty mask                    |
| pilot-v03-ui-04    | absent  | unresolved_empty | n/a         | —                  | —                  | no false output                     |
| pilot-v03-map-01   | present | unresolved_empty | n/a         | —                  | —                  | valid empty mask                    |
| pilot-v03-map-02   | present | unresolved_empty | n/a         | —                  | —                  | valid empty mask                    |
| pilot-v03-map-03   | present | unresolved_empty | n/a         | —                  | —                  | valid empty mask                    |
| pilot-v03-map-04   | absent  | unresolved_empty | n/a         | —                  | —                  | no false output                     |

## Completed run (authoritative)

- Run directory (preserved off-repo): `h10-clipseg-dev12-c997af4b-a140-437e-a920-e9850e137c4c` under `/root/work/zorya-classifier-runs/v03/`.
- **Provider physical calls:** 0. **Qualification opened:** false.

### Immutable artifact hashes

| Artifact                                             | SHA-256                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `freeze.json`                                        | `927d2880991b75a7f2d89606d624036afa091ff4087635ac18a6b4d93e8ec127` |
| `run.json`                                           | `c0d49b345832d982592d657e7d8512bd411e9d0d3193b21dfd4126ad0c97b1d7` |
| Staged asset manifest (in freeze/run)                | `98e8a5e767a6604a02fec0e561fa1b0128cb76783e4a405df4cb96e4b75fd084` |
| Producer contract                                    | `2d14512c74da492a2185b26d6d0703a83158fa5e99589274251d04cc4dcad70e` |
| Runner script                                        | `70868ac896cdbf16b5ef9846b37e374318c38944c846e6e6f3d328d24d9db5f9` |
| Common script                                        | `c32954eeae39a3de5093a1c2227f239b11915d3d520fc144e633b23113869a20` |
| Worker script                                        | `900184d19aebff2b18e83cf48b70f6bf4b6f1d9aae9f396c157dd901fcc89cae` |
| Independent evaluation JSON (run root and repo copy) | `2e6ddd0f440bee2be5ce358e759535e486b3c1cacb0e1ec761c1ed019e93e6f3` |

Sanitized machine-readable scores: [independent evaluation JSON](../evidence/v03/h10-clipseg-direct-mask-independent-evaluation.json) (byte-identical copy of the run-root evaluator artifact).

### Timing and memory (diagnostic only)

From saved run receipts (`run.json` and post-run audit):

- Run **`wall_ms`:** 4327.164281 (includes worker load, inference, and IPC; excludes CLI startup/import and pre-run closure validation).
- Worker **`load_ms`:** 2231.396935.
- Per-row **`wall_ms`:** first row **721.183747** ms; median **34.226805** ms (includes mask serialization and CUDA sync where recorded).
- Per-row PyTorch CUDA peak counters (not total/device-wide or production guarantees): peak allocated **669,497,344** bytes (~638.48 MiB); peak reserved **681,574,400** bytes (~650 MiB).

Hardware noted in run receipt: **NVIDIA GeForce RTX 4080**, CUDA **12.4**, device **cuda:0**. Do not extrapolate these local inference-only figures to full production pipelines.

## Prior prepared-not-executed freeze (not this result)

A separate preserved directory **`h10-clipseg-dev12-3a03353e-1e9b-45ca-bdb0-8ed7dc254ee9`** holds a **`prepared-not-executed`** freeze with SHA-256 **`dd44f16a7af01b6c46310d3c03f9451ca0db47dba11cc05d620758f7668bcb46`**, preparation note **`prepared-not-executed`**, and **`inference_executed: false`** after a parent-death regression failure. That artifact is **not** the completed run above and must not be scored as a second DEV comparison.

## Stop rules (in effect)

H10 missed **7/9** and **0/3** on this frozen cohort. Do not retune thresholds, prompts, or post-processing on the same twelve cases, prepare another freeze for a silent rerun, or chain this output into library defaults without a separately named experiment and root authorization.
