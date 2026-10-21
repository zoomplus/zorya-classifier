# H10 prospective plan: CLIPSeg direct text-conditioned mask logits

**Status: closed and rejected on the frozen DEV gate (2026-10-21).** Root accepted implementation of the offline runner, owned worker, producer contract, pinned asset staging, and synthetic tests in worktree `h10-clipseg-plan`. One **bounded twelve-case DEV inference** completed under frozen run `h10-clipseg-dev12-c997af4b-a140-437e-a920-e9850e137c4c` with empty **integrityErrors**; independent evaluation **failed** the frozen advancement gate (**0/9** positive same-object successes vs minimum **7/9**; **1/3** false outputs vs maximum **0/3**). Authoritative per-row scores and timing: [H10 DEV results](v03-h10-clipseg-direct-mask-results.md) and [independent evaluation JSON](../evidence/v03/h10-clipseg-direct-mask-independent-evaluation.json). **No second DEV inference, threshold or prompt tuning on these twelve cases, library integration, npm dependencies, default providers, production exports, or qualification** is authorized from this line.

**Prototype artifacts (research-only):** `benchmarks/v03/h10-clipseg-producer-contract.json`, `benchmarks/v03/h10-clipseg-asset-lock.json`, `benchmarks/v03/h10-clipseg-common.py`, `benchmarks/v03/h10-clipseg-worker.py`, `benchmarks/v03/h10-clipseg-runner.py`, `benchmarks/v03/h10-clipseg-fake-worker.py`, `benchmarks/v03/h10-clipseg-silent-worker.py`, `benchmarks/v03/h10-clipseg-stderr-flood-worker.py`, `benchmarks/v03/h10-clipseg-runner.test.ts`. Staged weights and external manifest live under caller-owned `/root/work/zorya-classifier/.run/v03/assets/clipseg-rd64-refined-999e0328/` (outside the repository). A bounded safety pass added nonblocking IPC, stderr draining, physical process-group kill/join, bounded source reads with manifest `source_sha256` checks, `[1,352,352]` logits selection, and effective processor validation. A follow-on closure pass binds **`run --freeze`** to **`prepare-freeze`** output (full byte/hash/runtime/recipe revalidation, immutable `freeze.json`, `freeze_sha256` in `run.json`), enforces oriented-pixel caps from **header/EXIF only** before decode, handles **SIGINT/SIGTERM** cancellation with twelve settled rows, propagates worker cleanup failures, extends row **wall_ms** through mask serialization and CUDA sync, and records peak VRAM when available. That harness executed **once** on the fixed twelve-case DEV cohort; scores are fixed evidence, not a pending dispatch.

## Rationale and lineage

H9 tested a **distinct** mechanism from H8: target-blind factual description of an already selected H8a mask, then a closed text-only identity comparison. That line is closed. Independent evaluation reported H9 **2/9** positive same-mask successes (H9 strata **photo 2/3**, **UI 0/3**, **map 0/3**) with **0/3** false outputs on negatives, versus the frozen **H8a** baseline **7/9** (H8a strata **photo 3/3**, **UI 3/3**, **map 1/3**) with **2/3** false outputs on the same fixed negative cohort. H10 must not prompt-tune H9, reuse H9’s two-stage verifier, or optimize against the same twelve DEV rows after observing H9’s score.

H10 instead tests **one-shot, text-conditioned dense segmentation** through the official Transformers CLIPSeg path: a single forward pass from original image plus authored target to mask logits, without GroundingDINO, SAM/SAM2, or an LLM decision port in the producer. That is a different segmentation family from the DINO+SAM+LLM pipelines exercised in H3–H8 and from H9’s mask-identity verifier. The hypothesis is falsifiable: CLIPSeg may emit a usable actual-mask candidate on some strata where proposal+selection stacks fail, especially where language directly drives pixel logits—but **empty or wrong masks are equally plausible outcomes**; this plan does not predict improvement.

The main **120-cohort qualification gate** in [0.3.0-quality-plan.md](../0.3.0-quality-plan.md) stays unchanged. This fixed **12-case DEV pilot** cannot qualify or promote a public profile.

## Evidence and primary sources (facts)

| Topic             | Fact (from primary sources)                                                                                                                                                                                                                                                                                    | Not claimed                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Model API         | `CLIPSegForImageSegmentation` returns **per-pixel logits**; documented internal output resolution **352×352** for the rd64 family ([Transformers v4.57.3 CLIPSeg docs](https://huggingface.co/docs/transformers/v4.57.3/model_doc/clipseg)).                                                                   | Logits are not calibrated probabilities of object presence in production.                    |
| Text conditioning | Original CLIPSeg work describes **text and image prompts** for segmentation ([timojl/clipseg README](https://github.com/timojl/clipseg)). H10 uses **text-only** conditioning with the authored target string; no image-prompt branch, no prompt rewriting.                                                    | README performance tables are not transferable guarantees on Zorya DEV sources.              |
| Canonical weights | Hugging Face model **`CIDAS/clipseg-rd64-refined`** at revision **`999e0328d9e10b484360c477313983f9afdd7050`** ([pinned tree](https://huggingface.co/CIDAS/clipseg-rd64-refined/tree/999e0328d9e10b484360c477313983f9afdd7050), [API metadata](https://huggingface.co/api/models/CIDAS/clipseg-rd64-refined)). | No mirror or fork (explicitly **exclude** `Trauma27/clipseg-rd64-refined` and other clones). |
| Runtime           | Local environment already supports **`transformers==4.57.3`** and `CLIPSegForImageSegmentation`; **RTX 4080** is available for a bounded local worker.                                                                                                                                                         | End-to-end product latency or cloud cost.                                                    |
| H9 outcome        | H9 **2/9** positives (**photo 2/3**, **UI 0/3**, **map 0/3**), **0/3** false outputs vs H8a **7/9** (**photo 3/3**, **UI 3/3**, **map 1/3**), **2/3** false outputs (independent evaluation; preserve full H9 evidence separately).                                                                            | H10 is not a retry of H9 prompts or thresholds.                                              |

**Licensing caveat (distinct layers, not legal approval):** The canonical Hugging Face model card and repository metadata describe **Apache-2.0** model assets and a **non-gated** public model. The original GitHub repository states **MIT for code excluding weights** ([clipseg README](https://github.com/timojl/clipseg)). Asset licensing, code licensing, and downstream use in Zorya remain **caller-owned decisions**; this plan does not constitute production or legal sign-off.

## Pinned artifacts and processor (root-verified)

At canonical revision **`999e0328d9e10b484360c477313983f9afdd7050`**, staging must reverify on-disk bytes against this expected pin before any inference. **Later drift means stop and root review; never silently substitute different bytes.**

| Artifact            | Expected pin                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `model.safetensors` | **603,049,496** bytes; SHA-256 **`d00ca85d6b859f9d07b7cfb8ef26fe9771cb275b34c9368f2ecf603139307f55`** |

**Processor (checkpoint `preprocessor_config.json` behavior):** `size.height=352`, `size.width=352`, `resample=2` (PIL bilinear), `do_resize=true`, `do_rescale=true`, `do_normalize=true`, `rescale_factor=1/255`, ImageNet mean **`[0.485, 0.456, 0.406]`**, std **`[0.229, 0.224, 0.225]`**. This is the pinned processor’s resize and normalization path—**no heuristic crop** and no alternate letterbox policy.

**Vision vs processor geometry:** Pinned model vision config **`image_size=224`** is the CLIP positional-embedding reference size, **not** the tensor height/width fed by the processor. The processor resizes the decoded source RGB to **352×352** for forward; segmentation **logits** remain on the **352×352** output grid documented for this checkpoint. Transformers’ forward path can interpolate positional encodings for non-224 inputs; **require explicitly passing and recording `interpolate_pos_encoding=true`** on forward for 352×352 processor input so behavior does not depend on an implicit library default. If the pinned local Transformers 4.57.3 API signature or default cannot be verified against staged artifacts before dispatch, treat that as a **pre-run implementation check** (pass/fail recorded) rather than an asserted fact in run evidence.

**Tokenizer bound:** Use the **actual** `model_max_length` and related fields from the pinned tokenizer and model config at freeze time. Separately document **77-token** CLIP text context as an **explicit checked expected bound** at staging—**no silent truncation, no target rewrite.**

## Frozen method (producer contract)

One **direct model-produced mask** per DEV image/target pair.

1. **Inputs (model-visible only):** Original oriented source image RGB and the **authored target string** exactly as frozen for the twelve H8a-era DEV cases (same images and targets as prior v03 DEV pilots). The run harness may use filesystem paths, case IDs, and row keys **only** for I/O, ordering, and accounting—they are **not** model conditioning. **No** ground truth, expected masks, stratum labels, case IDs, paths, prior model outputs, H8a/H9 masks, or evaluator fields are sent as model context.
2. **Load:** `CLIPSegForImageSegmentation.from_pretrained` with `revision=999e0328d9e10b484360c477313983f9afdd7050`, `local_files_only=true`, `trust_remote_code=false`. Matching processor/tokenizer from the same revision. **`.eval()`**, **`torch.inference_mode()`**, **FP32** weights and activations on one explicitly owned CUDA device.
3. **Preprocess:** Inherit the fixed **H5a native-proposals** source bounds for this DEV pilot: encoded source bytes **≤ 24 MiB** (25,165,824 bytes) and oriented decoded pixels **≤ 2,097,152** (**H×W** after EXIF/orientation normalization). **Before** full decode, check file byte length and image header/metadata; **after** orientation, check decoded **H×W** against the pixel cap. Reject oversize inputs with an explicit technical error—**no** resize, crop, or downscale workarounds. Within those bounds, images may be non-square at any aspect ratio. Apply only the pinned processor’s **352×352** resize, rescale, and ImageNet normalization (see above)—**no heuristic crop**, no letterbox search, no stratum-specific resize. Do **not** use the unrelated **16,777,216**-pixel public cutout cap. Resize output **logits** bilinearly back to the oriented source **H×W** in post-process.
4. **Forward:** Single text-conditioned forward per case with **`interpolate_pos_encoding=true`** passed and logged (see pinned-artifact note); **no** multiscale test-time augmentation, ensemble, or second pass.
5. **Post-process (fixed):**
   - Take model **logits** at **352×352** (model output grid).
   - Resize logits to original source **H×W** with **bilinear** interpolation, **`align_corners=false`**.
   - Binary mask: **`logit >= 0`** (equivalent to **sigmoid(logit) >= 0.5**) **once**.
   - **No** morphology, connected-component picking, largest-blob heuristics, hole filling, seed alignment, or truth-driven cleanup.
6. **Outputs and ledger:**
   - **Empty mask** (zero foreground pixels after **`logit >= 0`**) ⇒ valid **unresolved / no candidate** model outcome (not proof of absence); **not** a technical error.
   - **Nonempty mask** ⇒ **candidate actual mask only**; not calibrated evidence that the object is present or correct.
   - **Technical errors** (corrupt bytes, oversize source, decode failure, timeout, cancellation, load/pin failure, overlength target, etc.) are recorded separately from unresolved empty masks.
   - Preserve **all twelve rows**, including technical errors, timeouts, cancellations, and valid empty-mask unresolved outcomes.

**Text length:** Tokenize the authored target with the frozen tokenizer; enforce the **actual** `model_max_length` / config cap from pinned tokenizer and model config. **Reject** overlength targets with an explicit error—**no silent truncation or rewrite**. Record the configured max and verify the **77-token** CLIP context as an **explicit checked expected bound** at freeze/staging, not a tuning knob.

**Distinctness from prior hypotheses:** No DINO boxes, no SAM prompts, no multistage LLM presence/nomination/final selection, no H9 target-blind description, no H7 embedding rerank over an existing pool. H10 is **generative segmentation from text**, not selection among H5/H6 candidates.

## Frozen-input and blinding protocol

- **DEV cohort:** Fixed **12** images and **12** authored target strings—the same original DEV draw used across v03 localization pilots (nine positives, three negatives across photo/UI/map strata). Truth and reference masks remain **evaluator-only**.
- **Freeze before any inference** (after plan acceptance): upstream revision **`999e0328d9e10b484360c477313983f9afdd7050`**, per-file **SHA-256** (including expected **`model.safetensors`** pin above), processor/tokenizer/model config JSON hashes, Python/Torch/CUDA/Transformers versions, recorded `interpolate_pos_encoding` forward argument, recipe document hash, original image bytes hashes, target strings, device id, dtype policy, output schema, and worker entrypoint source closure.
- **Producer/evaluator separation:** Evaluator applies the frozen DEV gate on H10 candidate masks: **mask-derived decision-box IoU ≥ 0.50** and **reference-box coverage ≥ 0.90** (same whole-object criterion as prior v03 pilots). If **pixel-mask IoU** against reference is available, report it **separately as diagnostic**; do not describe the box gate as mask-pixel accuracy. Producer never reads labels, boxes, or IoU.
- **No case dropping:** Failed loads, rejections, and empty masks stay in the twelve-row ledger.

## Resource, staging, and cancellation budget

- **Staging:** Only **after** root acceptance of this plan. Model files remain **caller-owned** under an operator-controlled local directory; **no** import-time download, **no** npm package, **no** automatic asset fetch in library code.
- **Execution shape:** One owned local GPU worker process; **load once**, then **serial** processing of **12** cases in fixed order. **No** provider/API physical calls; **zero** paid ledger charges for H10 inference itself.
- **Timeouts:** **600 s** hard ceiling for the **whole run** (including model load); **60 s** per case including preprocessing, forward, resize/threshold, and serialization. Cancellation or timeout **terminates only the owned child**, drains IPC, and **finalizes all twelve rows** (no partial ledger).
- **Telemetry (diagnostic):** Record model-load duration, per-image latency, total wall clock, and **peak VRAM** (allocated/reserved separately). Do **not** extrapolate these inference-only timings to full production pipelines that include decoding, I/O, or decision adapters.

## Minimum tests (required before the twelve-case run)

All tests are offline/synthetic or fixture-based; **no** twelve-case DEV inference until they pass.

| Area                 | Requirement                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orientation/geometry | Ramp portrait/landscape, non-square **H×W**, and EXIF-oriented inputs within H5a bounds; assert logits finite and output mask **exactly H×W** matching oriented source.                         |
| Source bounds        | Reject **> 24 MiB** bytes (pre-decode) and **> 2,097,152** oriented pixels (post-orientation) without resize/crop; accept at-limit synthetic fixtures.                                          |
| Logits/mask          | Assert finite logits at 352×352; bilinear upscale + `logit >= 0` yields binary `{0,1}` mask; **zero-boundary** synthetic (`logit == 0` included as foreground).                                 |
| Empty/malformed      | Valid empty-mask threshold outcome is **unresolved**, not a technical error; corrupt bytes, oversize source, and missing files are **technical errors** without crashing the twelve-row ledger. |
| Overlength text      | Target exceeding tokenizer/config max **rejects** without truncation.                                                                                                                           |
| Pin integrity        | Refuse run if revision, config, or on-disk file hashes differ from freeze manifest.                                                                                                             |
| Cancellation/timeout | Forced cancel and per-item timeout **physically kill** the owned child and still emit **exactly twelve** finalized rows.                                                                        |

## Analysis, metrics, and advancement gate

Report **separately**:

1. **Candidate availability:** Nonempty mask emitted (regardless of truth).
2. **Same-mask success:** Evaluator **decision-box IoU ≥ 0.50** and **reference-box coverage ≥ 0.90** on the H10 candidate mask (plus optional diagnostic pixel-mask IoU).

**Frozen H10 advancement criteria (DEV only, diagnostic):** At least **7/9** positive same-mask successes **and** **0/3** false outputs on negatives—the aggregate gate for H10 (H8a’s observed **2/3** false outputs on negatives are baseline context only; H10 still requires **0/3**). Report H10’s **actual** per-stratum counts (**photo**, **UI**, **map**) diagnostically; they are **not** per-stratum quotas. For baseline context only, H8a’s observed positive strata were **photo 3/3**, **UI 3/3**, **map 1/3**—do not treat those figures as H10 targets.

**Baseline comparison:** Compare against immutable **H8a** (**7/9** positives, **2/3** false outputs on negatives, strata **photo 3/3**, **UI 3/3**, **map 1/3**) and closed **H9** (**2/9**, strata **photo 2/3**, **UI 0/3**, **map 0/3**, **0/3** false outputs). H9 documents that verifier-style continuation did not beat H8a on positives; H10 is judged on its own frozen aggregate gate, not on “beating H9.”

**H5 union hypothesis (report-only):** If H10 **fails** the direct gate but produces a **genuinely new** passing mask on a case where the frozen H5 union remained at **8/9**, note this **only** as a **potential** composition hypothesis (union **8/9 → 9/9**). Any acting on that requires a **separately named selector/composition plan**, explicit root approval, and frozen evaluator protocol—**never** silent promotion or automatic union patching from DEV tuning.

**DEV cannot qualify** the library or change defaults.

## Risks and limitations

- **352×352 internal grid:** Small UI controls and thin map features may occupy few logits cells; bilinear upsampling cannot recover sub-pixel structure. Expect **empty or fragmented masks** on map/UI strata **without** implying the target is absent.
- **Uncalibrated outputs:** `logit >= 0` is a fixed convention, not a tuned operating point on DEV. Nonempty masks may be **false positives**; empty masks may miss visible objects.
- **Text-only conditioning:** CLIPSeg supports richer prompts in the paper/repo; this plan **forbids** prompt variants, target rewriting, and threshold sweeps that would re-fit the twelve cases.
- **Small n:** Three negatives cannot establish a reliable false-positive rate; passing **0/3** here is necessary but not sufficient for qualification.
- **Pilot sources:** Controlled UI screenshot and shared map family do not prove natural-screen generality.

## Stop rules

- Stop this line **without** retuning thresholds, prompts, or post-processing on the same twelve cases if H10 misses **7/9** and **0/3** false outputs **unless** root accepts a **new named experiment** (not a silent rerun).
- Preserve **all** failures, empty masks, and stderr evidence.
- Do **not** chain H10 output into LLM selection on the same DEV rows without a separate approved plan.
- **At most two** complete DEV comparisons per hypothesis family per [0.3.0-quality-plan.md](../0.3.0-quality-plan.md) discipline; a documented implementation defect may justify one corrected run—**a bad score does not**.

## Deferred and separately authorized work

| Step                                                                                      | Authorization                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root review and acceptance of **this** plan                                               | Completed before staging and the single bounded DEV run.                                                                                                                                                               |
| Operator staging of `CIDAS/clipseg-rd64-refined` at pinned revision with recorded SHA-256 | Caller-owned; used for the completed run. Staged asset byte/SHA receipts are recorded in `freeze.json`; the minimal DEV input manifest hash is listed separately in [results](v03-h10-clipseg-direct-mask-results.md). |
| Implementation worktree, bounded local worker, freeze manifest, twelve-case run           | Completed once (`c997af4b-…`); a prior **prepared-not-executed** freeze (`3a03353e-…`) is preserved separately and did not run inference.                                                                              |
| Independent evaluator receipt and audit JSON/MD                                           | Completed; repository copy at `docs/evidence/v03/h10-clipseg-direct-mask-independent-evaluation.json`.                                                                                                                 |
| Any npm export, default segmenter, or production integration                              | Explicitly **out of scope** until qualification path says otherwise.                                                                                                                                                   |
| **SAM 3** or other gated/personal-license checkpoints                                     | **Deferred.** Requires a **separate manual personal-license gate**; **no** auto-accept from this plan.                                                                                                                 |

## Worktree scope

This plan and the closed DEV result live in worktree **`/root/work/zorya-classifier-worktrees/v03/h10-clipseg-plan`**. Owned documentation paths: **`docs/research/v03-h10-clipseg-direct-mask-plan.md`**, **`docs/research/v03-h10-clipseg-direct-mask-results.md`**, **`docs/evidence/v03/h10-clipseg-direct-mask-independent-evaluation.json`**, plus the H10 producer files under **`benchmarks/v03/h10-clipseg-*`** listed above.
