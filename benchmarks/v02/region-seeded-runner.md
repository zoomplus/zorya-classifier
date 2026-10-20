# Region-seeded full-frame extraction profile

`native-luna-region-seeded-sam-dev-v1` is a separately named benchmark recipe for the original exposed 40-case DEV set (20 photo, 10 independent UI, 10 independent map, including negatives). It runs the unchanged three-choice region locator, then makes one caller-owned CPU MobileSAM `seed-region` pass over the full oriented source image. The seed cell is recorded before inference and remains distinct from the box and center derived from foreground mask pixels. There is no whole-object extent search, same-instance confirmation request, completeness request, OCR, or box inferred from the seed cell.

The explicit benchmark route is `openai/gpt-6-luna-decisions` through OpenAI's Decisions endpoint. The library itself remains model-free and callers still own the ports. One classification request and at most three region-search requests are allowed per case, plus one local native segmentation call. The case deadline is 120 seconds, two cases may run concurrently, and the shared MobileSAM pool uses one active child with two waiters and two threads. The profile has a 250-fetch, $5, $0.05-per-unknown-cost hard budget. It has no automatic retry or provider fallback. Timing is not ranked.

`native-luna-region-no-image-control-dev-v1` is a paired control. It uses the same question, target, route, and region-task policy but removes image parts at the caller's decision-port boundary and asserts their absence again at the fetch boundary, including rejecting data-image/base64 markers in strings. Deterministic raster normalization and grid construction still run locally to preserve identical geometry text; the generated image parts are discarded before the model adapter and cannot produce coordinates or semantic answers. The control performs no segmentation, OCR, image encoding, or semantic computer vision. It records only the region locator's seed; it emits no mask-derived object box. Candidate mask and box results therefore remain candidate-only outcomes, while paired localization compares the seed region.

Run an offline preflight with:

```sh
PATH=/root/.nvm/versions/node/v24.12.0/bin:$PATH node --import tsx benchmarks/v02/run-region-seeded-dev.ts --dry-run
```

The paid command requires an explicit `--allow-paid`, and output stays under `.run/v02/region-seeded`. Heldout mode requires an external strict freeze and three explicit input-manifest paths and hashes; it uses the same recipe code with the heldout 80-case groups and 600-fetch/$10 caps. The producer never loads evaluator truth, source ledgers, or private image paths into provider prompts or output manifests.
