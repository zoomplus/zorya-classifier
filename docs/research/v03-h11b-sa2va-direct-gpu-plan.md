# H11b prospective plan: Sa2VA direct-CUDA `device_map` load variant

**Status: Wave B0 — planned, not executed (2026-10-21).** This document and `benchmarks/v03/h11b-sa2va-direct-gpu-contract.json` freeze methodology and producer constraints for a **separately named** profile only. **No** staging, inference, evaluator receipt, qualification, npm export, default provider, or production integration is authorized from this wave. **No** load success, localization result, or gate outcome is claimed until separately executed frozen runs and independent evaluation exist.

**Worktree:** `/root/work/zorya-classifier-worktrees/v03/h11b-direct-cuda`, branch `work/classifier-h11b-direct-cuda`.

## Objective

Test whether **explicit Transformers `device_map={"": "cuda:0"}` loading** (per-tensor GPU placement during `from_pretrained`) can avoid **INIT-time failure** observed on the legacy H11 path that loads on CPU (with `low_cpu_mem_usage`) and then calls **`model.to(cuda:0)`**. This is an **engineering placement hypothesis**, not a claim that Sa2VA localization will improve or that host memory pressure alone caused GPU OOM.

H11b reuses the **same** pinned Sa2VA model, prompt, manifest, mask policy, generation cap, and DEV quality gate as H11; only the **authorized loader placement request** and **runtime profile identity** differ.

## Relationship to H11 (immutable boundary)

| Item                          | H11 (unchanged)                                                                                                                                    | H11b (this wave)                                                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Producer contract file        | `benchmarks/v03/h11-sa2va-contract.json`                                                                                                           | `benchmarks/v03/h11b-sa2va-direct-gpu-contract.json`                                                                                                                    |
| Contract SHA-256 (file bytes) | **`14281b417d8fc2838cd52ff6bf05cb63aae493bc9968b5a4f20b6b482d58ccdd`** (pinned in `benchmarks/v03/evaluate-h11-sa2va.ts` as `H11_CONTRACT_SHA256`) | **`ee623e58181f5db22d77720760438b0b34342c708a9f5f99037446d4d3846908`** (`h11b-sa2va-direct-gpu-contract.json`); binds only H11b freezes/runs                            |
| Runtime profile               | implicit legacy H11 worker recipe (no `runtime_profile_id`; legacy recipe without `loader_device_map`)                                             | **`runtime_profile_id`: `h11b-direct-cuda-v1`** in contract only; freeze/run bind via contract SHA + recipe `loader_device_map` (no top-level freeze/run profile field) |
| Loader placement              | CPU materialization + **`model.to(cuda:0)`** (current worker)                                                                                      | **`from_pretrained(..., device_map={"": "cuda:0"})`**; redundant `.to` skipped when map active (B1)                                                                     |
| Prior frozen DEV receipts     | Preserved as historical H11 evidence                                                                                                               | **Not rewritten**; H11b uses new run roots and contract hash                                                                                                            |

**Why this matters:** H11 and H11b must remain independently auditable. Changing the legacy contract or relabeling failed H11 runs would break receipt integrity and confuse localization evidence with load-path experiments.

## Hypothesis (testable, not proven)

**H11b:** Avoiding full CPU residency followed by a monolithic **`.to(cuda:0)`** move—by requesting **single-GPU `device_map`** during **`AutoModel.from_pretrained`**—reduces peak transient memory enough to complete initialization on the same RTX 4080 / Windows host conditions that produced **legacy H11 INIT failures**.

**Why this might help (mechanism, not outcome):** Transformers 4.57.3 delegates **`device_map`** placement to Accelerate’s big-model loading path, which can stream shards onto the target device instead of holding the full FP/BF16 tree on CPU before transfer.

**Why this might still fail (equally plausible):** GPU VRAM may still be insufficient for ~5.33 GB raw BF16 weights (~10.67 GB checkpoint FP32 byte size on disk) plus runtime buffers; Windows commit pressure may still deny large allocations; **`device_map`** may still materialize unwanted CPU/disk tiers if misconfigured; remote code paths may allocate off-contract. **Success is unknown** until B2 smoke and B3 DEV.

## Verified facts vs assumptions vs open questions

| Topic                      | Verified fact (repository or cited receipt)                                                                                                                                                                                                                                                                                                                                                                                    | Assumption (explicit)                                         | Open question (needs B2+)                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| H11 contract bytes         | SHA-256 **`14281b417d8fc2838cd52ff6bf05cb63aae493bc9968b5a4f20b6b482d58ccdd`** matches on-disk `h11-sa2va-contract.json` in this tree                                                                                                                                                                                                                                                                                          | —                                                             | —                                                                                               |
| Legacy load path           | `h11-sa2va-worker.py` calls **`model.to(torch_device)`** after **`from_pretrained`** without **`device_map`**                                                                                                                                                                                                                                                                                                                  | That ordering contributed to INIT OOM alongside host pressure | Whether **`device_map`** lowers peak enough to init on target hardware                          |
| Parent CUDA metadata probe | H11 **`cuda_runtime_details()`** uses an **owned subprocess** so the parent runner avoids initializing CUDA for metadata (see `h11-sa2va-common.py`)                                                                                                                                                                                                                                                                           | Parent CUDA init was part of the failure context              | Whether any remaining parent-side CUDA touch affects INIT after B1                              |
| Legacy H11 DEV attempts    | **Two** frozen H11 DEV runs failed during initialization at **`model.to(cuda:0)`** with **zero image rows executed** (owner-reported; INIT failures, not localization). Immutable failed-run roots: `/root/work/zorya-classifier-runs/v03/h11-sa2va-dev12-4f1a2d6b-8295-4aae-b02c-64e6ee54bc13` and `/root/work/zorya-classifier-runs/v03/h11-sa2va-dev12-parent-probe-84af0ab2-cb28-43eb-a1ac-729ec6e5348e` (outside `.run`). | Failures are reproducible under similar host load             | —                                                                                               |
| Post-fix H11 DEV           | Parent CUDA metadata subprocess fix **did not** cure INIT failure on subsequent legacy attempts (owner-reported)                                                                                                                                                                                                                                                                                                               | Fix addressed a real defect but not the dominant INIT blocker | —                                                                                               |
| Load-only smoke            | `/root/work/zorya-classifier/.run/v03/h11/load-smoke-protocol/receipt.json`: **`load_ms` ≈ 9760.48**, **`model_weights_load_verified`: true**, **no** `image_forward_executed`                                                                                                                                                                                                                                                 | —                                                             | Not comparable memory state to failed DEV inits; not an accuracy run                            |
| Windows commit snapshot    | **`windows-memory-corrected.jsonl`**: **40** samples; owner-corrected summary **~85,700,000,000** committed ≈ **99.5866884%** of **86,056,000,000** limit; **minimum available commit 318,984,192** bytes (**< 594 MiB** additional commit headroom)                                                                                                                                                                           | Tight commit correlates with large allocations failing        | **Not proof** this caused CUDA OOM                                                              |
| Pre-corrected snapshot     | **`windows-memory-pre-corrected.json`** (single point, different limits/percent)                                                                                                                                                                                                                                                                                                                                               | —                                                             | Use only when labeled pre-corrected; do not mix into H11b run paths                             |
| B0 assets                  | **No** new weight downloads or companion asset staging in this wave                                                                                                                                                                                                                                                                                                                                                            | Existing pins remain valid                                    | —                                                                                               |
| H11b contract delta        | Only **`runtime_profile_id`** + **`model.loader.from_pretrained.device_map`** added                                                                                                                                                                                                                                                                                                                                            | Semantics otherwise identical to H11                          | Evaluator/producer bind contract SHA **`ee623e…6908`** and recipe **`loader_device_map`** in B1 |

**Unresolved in B0 (call out explicitly):** Raw **`windows-memory-corrected.jsonl`** lines on disk use **`limitBytes`: 77177659392** and naive min **`availableBytes`** ≈ **12.97×10⁹**; the **85.7×10⁹ / 86.056×10⁹ / 318,984,192** figures follow **owner-corrected commit accounting** on the same 40-sample file cited in the B0 assignment.

## Primary sources (API mechanism, not performance claims)

| Source                                                                                                                                  | What it supports                                                                                             | What it does **not** prove                                |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| [Transformers 4.57.3 `PreTrainedModel`](https://huggingface.co/docs/transformers/v4.57.3/en/main_classes/model)                         | **`from_pretrained`** accepts **`device_map`** and integrates with Accelerate for device placement           | That Sa2VA INIT succeeds on this host                     |
| [Transformers `modeling_utils.py` v4.57.3](https://github.com/huggingface/transformers/blob/v4.57.3/src/transformers/modeling_utils.py) | Load path honors explicit maps and dispatches weights per module                                             | Peak memory on this checkpoint size                       |
| [Accelerate `big_modeling.py` v1.11.0](https://github.com/huggingface/accelerate/blob/v1.11.0/src/accelerate/big_modeling.py)           | **`device_map={"": "cuda:0"}`** targets a **single** device key for all modules when no offload is requested | Absence of silent CPU/disk offload without runtime checks |

Pinned runtime versions remain **`transformers` 4.57.3** and overlay wheel **`accelerate` 1.11.0** per H11 contract—**unchanged in B0**.

## Architecture and control flow

```mermaid
flowchart TB
  subgraph parent["Parent runner (no model weights)"]
    FR[freeze.json + contract hash]
    PR[prepare / revalidate recipe]
    IPC[Owned worker IPC]
    FR --> PR --> IPC
  end
  subgraph worker["Owned GPU worker child"]
    LD["AutoModel.from_pretrained(device_map={\"\": cuda:0})"]
    SK["Skip redundant model.to when map active (B1)"]
    EV[eval + inference_mode + eager attn]
    GEN[Intercepted generate max 128 greedy]
    FWD[predict_forward rows serial]
    LD --> SK --> EV --> GEN --> FWD
  end
  IPC --> worker
```

**Plain language:** The parent process orchestrates manifests, freezes, and timeouts; the child alone loads weights and runs forwards. H11b keeps that split but changes **where** tensors live during load so the worker never performs a full CPU→GPU **`to`** after a complete CPU resident model.

### Single-GPU placement policy (contract + planned B1 enforcement)

- **Request:** `device_map={"": "cuda:0"}` in contract **`model.loader.from_pretrained`** — expresses intent that **all modules** load to **`cuda:0`** without **`device_map="auto"`**, CPU offload, disk offload, quantization, or multi-GPU sharding.
- **Verification (B1/B2, not done in B0):** After load, assert Hugging Face **`hf_device_map`** (or equivalent) matches the explicit map; every **parameter and buffer** is on **`cuda:0`** and not **`meta`**; floating weights remain **BF16** (non-float buffers may differ legitimately).
- **Legacy path:** Calls without **`device_map`** in the contract must reproduce today’s **`from_pretrained` + `model.to(cuda:0)`** recipe byte-for-byte in freeze metadata.

## Fixed methodology (H11b contract summary)

Full machine-readable rules: **`benchmarks/v03/h11b-sa2va-direct-gpu-contract.json`** (H11 semantics plus placement fields only).

1. **Same twelve-case manifest, prompt, mask selection, generation 128/greedy, quality gate, and asset pins as H11.**
2. **Profile identity:** H11b experiments bind **`runtime_profile_id`: `h11b-direct-cuda-v1`** through the H11b contract file SHA (**`ee623e58181f5db22d77720760438b0b34342c708a9f5f99037446d4d3846908`**) and freeze **`recipe.loader_device_map`**; freeze/run JSON must not add a separate top-level **`runtime_profile_id`** field.
3. **No weights staged in B0;** caller-owned asset directory unchanged from H11 contract pins when runs eventually execute elsewhere.

## Failure modes and acceptance gates

| Failure mode                                     | Classification            | Gate behavior                                                                                                                   |
| ------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| INIT / load OOM or exception before row 0        | **Technical rejection**   | Fail closed; **not** localization evidence; preserve stderr/receipts                                                            |
| Partial **`device_map`** (CPU/disk/meta tensors) | **Integrity / technical** | B2 smoke must abort; no “best effort” forward                                                                                   |
| Wrong dtype on floating params                   | **Technical**             | BF16 required for floats unless contract exception                                                                              |
| Missing CUDA / wrong device index                | **Technical**             | **`cuda:0`** only                                                                                                               |
| Contract / script hash drift                     | **Integrity**             | Freeze revalidation rejects run                                                                                                 |
| Localization gate miss after successful load     | **Hypothesis stop**       | Same as H11: **≥ 7/9** positives with box IoU ≥ 0.5 and coverage ≥ 0.9, **0/3** false outputs, zero technical/integrity defects |

**Why it matters:** INIT failures diagnose **load engineering**, not mask quality. Placement defects must not silently degrade into a forward that looks like a valid DEV run.

## Dependency waves (accepted sequencing)

| Wave                 | Role / model                                                                                                               | Owned files                                                                                                                                                                                         | Depends on               | Parallelism                                     | Artifacts                                                                                                 | Exit gate                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **B0 (this commit)** | Luna coordination (**high**); **Composer 2.5 Fast** implementation                                                         | **`docs/research/v03-h11b-sa2va-direct-gpu-plan.md`**, **`benchmarks/v03/h11b-sa2va-direct-gpu-contract.json`** only                                                                                | H11 contract frozen      | Solo                                            | Plan + H11b contract JSON                                                                                 | Root **reviews and approves** before B1; Prettier + parsed diff vs H11 + two fields                                                            |
| **B1**               | Luna (**high**) → **Composer 2.5 Fast** in **`h11b-direct-cuda`** worktree (producer) and **`h11b-evaluator`** (evaluator) | Producer: **`h11-sa2va-common.py`**, **`h11-sa2va-runner.py`**, **`h11-sa2va-worker.py`**, **`h11-sa2va-runner.test.ts`**. Evaluator: **`evaluate-h11-sa2va.ts`**, **`evaluate-h11-sa2va.test.ts`** | **B0 root approval**     | Producer ∥ evaluator (disjoint files/worktrees) | Code + tests wiring optional contract path; **`loader_device_map`** in recipe when H11b contract selected | Root source review; legacy default path unchanged without H11b contract                                                                        |
| **B2**               | Root / operator                                                                                                            | — (run only)                                                                                                                                                                                        | B1 merge                 | After B1                                        | Focused tests, metadata/contract checks, prepare/freeze/**load-only smoke**                               | Fail closed on missing GPU, offload map, wrong device/dtype, OOM, drift; **no success claim from declarations alone**                          |
| **B3**               | Root / operator                                                                                                            | New **caller-owned run root** (not mixed with legacy H11 receipts)                                                                                                                                  | B2 smoke + root approval | Solo DEV                                        | One bounded **DEV12** freeze/run/evaluator receipt                                                        | Gate: **≥ 7/9**, **0/3** FP, zero technical/integrity defects; bind **H11b contract hash + profile**; **do not touch** legacy H11 run receipts |
| **B4**               | Reviewer + root                                                                                                            | —                                                                                                                                                                                                   | B3 evidence              | —                                               | Review report, placement proof, receipts                                                                  | Root integrates/decides; **no** npm default/export/promotion                                                                                   |

**Commit gate for B0:** Only the two owned files above; hooks run on commit; **no** runtime, test, evaluator, package, or receipt mutations.

### B1 implementation notes (planned, not executed)

- **`build_recipe`:** optional contract argument; absent **`device_map`** → legacy recipe; H11b contract → add **`loader_device_map: {"": "cuda:0"}`**.
- **Prepare / run revalidation:** propagate selected contract path and SHA-256; H11b freezes must cite **`h11b-sa2va-direct-gpu-contract.json`** digest.
- **Worker:** pass exact map into **`from_pretrained`**; skip **`model.to`** when map active; legacy path untouched.
- **Evaluator:** accept H11b contract hash **`ee623e58181f5db22d77720760438b0b34342c708a9f5f99037446d4d3846908`** and recipe **`loader_device_map`** without altering H11 **`H11_CONTRACT_SHA256`** constant for legacy runs.

## Smoke → run sequence (B2+)

1. Verify H11b contract bytes and asset pins (caller-owned directory).
2. **Prepare/freeze** with H11b contract path/SHA and script receipts (recipe carries **`loader_device_map`**).
3. **Load-only smoke:** successful **`ready`** without row forwards; record placement attestation fields planned in B1.
4. **Full DEV12** only after smoke approval (B3).

## Deferred (explicitly out of B0)

- Producer/evaluator code changes, inference, new asset downloads, npm/package edits, mutating legacy H11 contracts or receipts, and any claim that **`device_map`** fixes INIT or improves localization.

## References

- H11 plan: [v03-h11-sa2va-text-mask-plan.md](v03-h11-sa2va-text-mask-plan.md)
- H11 contract (unchanged): `benchmarks/v03/h11-sa2va-contract.json`
- H11b contract (B0): `benchmarks/v03/h11b-sa2va-direct-gpu-contract.json`
