# H4d SAM-HQ UI proposal refinement

**Result:** the sequential SAM-HQ run produced 36 valid masks, but independent candidate-availability evaluation found **0/3 positive UI cases** with a candidate satisfying both fixed gates. This is worse than the H4c SAM2 screen (1/3), so H4d supplies no evidence to promote SAM-HQ for this path.

## Frozen protocol and receipts

H4d kept all 36 H4a OmniParser boxes, source pixels, order, and full-source coordinates unchanged. It used the pinned `syscv-community/sam-hq-vit-base` checkpoint at revision `f906a2e3f60fda2f12eb717cef18614f66c43124` (Apache-2.0), `hq_token_only=True`, `multimask_output=False`, and zero-logit thresholding. One full-source image encoding was reused for 36 ordered single-box decoder calls. Masks were kept at the original 1280x800 source dimensions, without clipping to the prompting boxes. No query, target label, or other ground truth entered the producer.

The initial all-36 batched attempt is preserved as a technical OOM failure, not an accuracy run: it failed while requesting an additional 576 MiB. Its freeze SHA-256 is `7a40183d4749fa8488bc6ef29d58d989eb1e094a79be8a708f4801478dc258a4`, run receipt SHA-256 is `c8031f80621a7b87c811c7be1227f0262a12bd27f3c354238f1f09ca968224e1`, and worker stderr SHA-256 is `c62dbe7fd8e54788264a2886b5782f2bcdff8703a26a5a2c0966d5ab702911f5`. The sequential retry changed only decoder scheduling; it completed within the fixed 240-second process deadline.

The completed producer freeze is `.run/v03/h4d-samhq-ui-box-refinement-sequential-v2/freeze.json`, SHA-256 `d0fdf93348a809ad8f01eb6cf6152958baad57e4d8670ae9c9590076d6cb96e6`. Its run receipt is `run.json`, SHA-256 `704a7075e33b4bcc3806e15bb166cb8d088cdc1fbd2c984660c099634618f2b8`. Post-run source, H4a inputs, model assets, license, and producer hashes were unchanged. The receipt records all 36 candidates and per-mask byte/hash/area/bounds information. All 36 masks were nonempty; independent validation confirmed binary pixels, expected source dimensions, byte and hash integrity, and pixel-derived bounds.

The source is a controlled Geany screenshot with styled colored button borders. It does not establish general UI behavior. There were no paid model calls, no source changes, and no dependency or default-model changes.

## Independent candidate-availability result

After producer closure, the evaluator matched masks to the exposed positive query boxes. The predeclared gate requires **both** mask-bounds IoU >= 0.50 and target coverage >= 0.90 on the same candidate. It found 0/3 positives passing. For each positive, ordinal 1 was the maximum-IoU candidate; the listed coverage is measured on that same candidate/reference pair:

| Fixed positive query | Maximum-IoU candidate | IoU | Target coverage | Gate |
| --- | ---: | ---: | ---: | --- |
| `pilot-v03-ui-01` | 1 | 0.0029884 | 1.0000 | Fail |
| `pilot-v03-ui-02` | 1 | 0.0029884 | 1.0000 | Fail |
| `pilot-v03-ui-03` | 1 | 0.0029077 | 1.0000 | Fail |

These maximum scores are oracle diagnostics from the independent evaluator and must not be interpreted as a production ranking or selection policy. UI-04 was the absent-target case; 36 masks were produced, but this availability-only evaluation did not judge semantic false positives. No pixel-mask annotations were available, so this does not measure segmentation quality. The result is limited to one controlled screenshot and three positive query boxes.

The independent evaluation receipt is `docs/research/v03-h4d-samhq-ui-mask-availability-evaluation.json`; its frozen hash and audit artifact will be recorded here when the evaluator finalizes the report.

## Interpretation

H4d's sequential decoding solved the batched recipe's memory failure, but the masks did not yield useful candidate boxes under the unchanged gate. It underperformed the H4c SAM2 screen on the same frozen proposals. Preserve this as a negative feasibility result for this model/prompt recipe; do not promote it as an accuracy result or tune it against these three labels.
