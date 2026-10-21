# H11 / H11b Sa2VA: closed without localization quality

**Status: closed (2026-10-21).** Legacy **H11** and prospective **H11b** direct-CUDA loading were bounded on the same frozen twelve-case DEV manifest and unchanged advancement gate (**≥ 7/9** positive same-object successes, **0/3** false outputs on negatives, zero technical/integrity defects). **No localization quality was measured:** every dispatched legacy H11 row failed at **`INIT_FAILURE`** before the worker reached READY (**zero** image forwards). **H11b** accepted a strict prepare-freeze but **no H11b DEV image rows** were dispatched; load-only smoke failed during weight load warmup. This closure records load-path technical blockers only—not a Sa2VA accuracy result, not a comparison against H10/H8a scores, and not qualification or production promotion.

## Gate (unchanged criteria)

From [H11 plan](v03-h11-sa2va-text-mask-plan.md) and [H11b plan](v03-h11b-sa2va-direct-gpu-plan.md): mask-derived box IoU ≥ 0.50 and reference coverage ≥ 0.90 on positives; aggregate **≥ 7/9** successes and **0/3** false outputs with zero technical/integrity defects.

| Assessment                          | Outcome on these receipts                      |
| ----------------------------------- | ---------------------------------------------- |
| Localization gate                   | **Not assessed** (no successful mask forwards) |
| Provider physical calls             | **0**                                          |
| Qualification / heldout / promotion | **None**                                       |

**Context only (not H11 scores):** independent **H10** on the same fixed cohort observed **0/9** positive successes with masks actually produced; **H8a** observed **7/9** via ordinary vision-chat on fixed H6 evidence.

## Immutable contracts

| Profile          | File                                                 | SHA-256                                                            |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| H11 legacy       | `benchmarks/v03/h11-sa2va-contract.json`             | `14281b417d8fc2838cd52ff6bf05cb63aae493bc9968b5a4f20b6b482d58ccdd` |
| H11b direct CUDA | `benchmarks/v03/h11b-sa2va-direct-gpu-contract.json` | `ee623e58181f5db22d77720760438b0b34342c708a9f5f99037446d4d3846908` |

**H11b delta:** only `runtime_profile_id` **`h11b-direct-cuda-v1`** and Transformers `device_map` **`{"": "cuda:0"}`** (freeze recipe `loader_device_map`); model, prompt, manifest, limits, and gate otherwise fixed.

Shared twelve-case manifest SHA-256: **`98e8a5e767a6604a02fec0e561fa1b0128cb76783e4a405df4cb96e4b75fd084`**.

## Legacy H11 DEV attempts (two retained runs)

Both runs use the legacy contract SHA above, **`row_count` 12**, run status **`completed_with_technical_errors`**, all twelve persisted rows **`technical_error`** with **`error_code` `INIT_FAILURE`**, and **zero** image forwards. Failure occurred during model placement/load on CUDA (including a **594 MiB** allocation-stage request on the primary attempt) **before** worker READY.

The fixed evaluator retained denominators **9/3** and reported **12** technical/integrity defects with **`cleanPass: false`**. That is **not** a **0/9** localization score—there were **no** quality outcomes to score.

### Run A — after image-root fix

- Run id: **`h11-sa2va-dev12-4f1a2d6b-8295-4aae-b02c-64e6ee54bc13`** (preserved off-repo under `zorya-classifier-runs/v03/`).

| Artifact                               | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `freeze.json`                          | `8884bfdfe98cc95522285a95d78f5e0b4d8603c16085e649b0b81b8bd8d1273c` |
| `run.json`                             | `3e00d1e83031c7e0aa4a283727d7e53ae539fd6a3673ddc920520c70ed053c27` |
| `rows.jsonl`                           | `dd1104a176cbe71723f65c5803100e11b4c7d5d759867adbc7df36fe2675d844` |
| `evaluation-after-image-root-fix.json` | `c0c0bef87e040c2dbe09b2f26b7851d132beca9f337ad3004cdad723f1457a94` |

Frozen script receipts (H11): common `ccc566d1…`, runner `a0a8536e…`, worker `fb6d3c10…`; imported H10 common/runner match run B below.

### Run B — parent-CUDA metadata probe

- Run id: **`h11-sa2va-dev12-parent-probe-84af0ab2-cb28-43eb-a1ac-729ec6e5348e`**.

| Artifact          | SHA-256                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `freeze.json`     | `be02254da8c464f534399d201d580c66d193b676aec3d76e84988b03e093b9af` |
| `run.json`        | `2e73cea5417dfb75312e2964b409cb77089e6426468dbbdb44e1c4f511c2e73a` |
| `rows.jsonl`      | `1d19876d670e13eafad8f1cd404996ff75204daa60b9c72f7a2e9da2d3abfb3c` |
| `evaluation.json` | `c0c0bef87e040c2dbe09b2f26b7851d132beca9f337ad3004cdad723f1457a94` |

Frozen H11 common differs (`18067824…`); runner/worker and H10 receipts match run A. **Both evaluations are retained;** evaluation file bytes currently share the same SHA-256.

## H11b direct-CUDA profile

### Prepare-freeze (not a run)

- Prepare id: **`h11b-sa2va-dev12-b3fd6f2a-65f0-4fc1-8d27-e7ed4f5b600f`**.
- `freeze.json` SHA-256: **`2173a0c9a4b2a950b507ae08cef733178ee59a237f2a104ae911c182bdcc9156`**.
- Accepted by main evaluator strict freeze schema; contract SHA matches H11b; recipe `loader_device_map` is **`{"": "cuda:0"}`**; script receipts verify.
- Producer receipts in freeze: common `0f30e77d…`, runner `c86eaa9d…`, worker `eff201ba…`.

### Load-only smoke (no DEV dispatch)

- Receipt: **`.run/v03/h11b/load-smoke/receipt.json`**, SHA-256 **`0b0b014749c93a03c08194861efc893c7cd365b0ce849e45a76e416901264212`**.
- Phase **`h11b-load-only-protocol-smoke`**: **`image_forward_executed: false`**, **`model_weights_load_verified: false`**, **`cleanup_failed: false`**.
- Failed in Transformers **`caching_allocator_warmup`** requesting **4.39 GiB** with CUDA reporting **14.69 GiB** free and PyTorch allocated/reserved **0** bytes at failure.

## Host memory diagnostics (correlated context only)

| Log                                             | SHA-256                                                            | Samples | Peak commit/limit | Min headroom |
| ----------------------------------------------- | ------------------------------------------------------------------ | ------- | ----------------- | ------------ |
| `.run/v03/h11/windows-memory-corrected.jsonl`   | `6f0ee050d458857144addc1e395773fe2f5ce7d63315d99b5d1fc50795329cec` | 40      | 99.59%            | 318984192 B  |
| `.run/v03/h11b/windows-memory-load-smoke.jsonl` | `0d20938584d79800e3bbd651c82c826f310665f4253d55d1aa8cf6abcb083f8c` | 50      | 96.92%            | 2377224192 B |

High Windows commit utilization coincided with these attempts but **does not** by itself prove a leak or the CUDA failure root cause.

## Stop rules (in effect)

Do not retune Sa2VA prompts, thresholds, or loader paths on the same twelve cases to force a pass. Do not relabel failed H11 receipts under H11b. Any materially different load or segmentation experiment requires a separately named plan, contract binding, and root authorization before dispatch.

Sanitized machine-readable closure: [load-failures evidence JSON](../evidence/v03/h11-sa2va-load-failures.json).
