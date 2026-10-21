# H3b: semantic selection of text-conditioned mask candidates

Plan written before implementation and provider dispatch. H3's corrected local run produced 85 masks across the fixed twelve DEV cases, below the per-case cap. Preliminary comparison of the producer's mask-derived rectangles suggests usable candidates in all three photos and two of three map cases, but no UI case. The independent evaluator must confirm those bounds from actual mask pixels. This is a candidate ceiling, not the result a user would receive.

The hypothesis is that local text-conditioned proposals avoid wrong initial grid seeds, while an injected DecisionPort identifies the requested instance among actual masks. It follows the separation between candidate generation and visual grounding explored by [Grounded SAM 2](https://github.com/IDEA-Research/Grounded-SAM-2) and [Set-of-Mark](https://github.com/microsoft/SoM); neither project establishes our accuracy.

## Fixed experiment

Use the original twelve producer-safe inputs unchanged. Read only the completed H3 run's native predictions, never evaluator labels or reference masks. Pin `run.json` SHA-256 `df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401`, its script/environment/assets/source/case closure, and every source/mask file before provider dispatch. Validate decoded binary mask pixels, source dimensions, declared boxes, unique aliases, and the original detector cap. Preserve all zero-candidate cases and technical failures as missing predictions.

The producer owns a full source snapshot and one candidate mask at a time. Present the unmodified source first, followed by contact sheets of actual candidate crops, with stable aliases C00..C35. Crop each candidate's actual foreground bounds with fixed 25% padding on each side, clipped to the source. Each tile contains an unmodified context crop and the same crop with a cyan mask overlay, preserving aspect ratio. Place labels in added margins outside source pixels. A fixed three-column/two-row sheet uses 384x284 tiles (1152x568); a sheet contains at most six candidates, and the final partial sheet does not invent candidates. Retain masks in original source coordinates. Include alias-to-source-crop transforms; never include detector/native quality scores, case/source IDs, paths or truth in the request.

Make one closed Choice with all actual aliases plus `none`, ranking size one. Ask which candidate represents the whole visible requested instance, excluding fragments, other objects and background. Select the raw categorical maximum with stable input-order ties. No universal confidence cutoff, normalization, retries, alternate prompt, provider fallback or resampling.

If a mask is selected, perform the existing separate whole-box completeness check against the full source and its actual mask-derived box. Derive a one-pixel anchor from visible foreground in that mask; explicitly describe it as a witness derived from the candidate, not an earlier grid hit. Use the existing prepared-image path and source transforms. Only `complete` produces a box and transparent cutout; `needs-expansion` and `unknown` remain unknown because this recipe has no enclosing-mask correction. Do not stretch rectangles, fill holes or add pixels based on a language response.

## Runner and ownership

Benchmark-only composition, no public exports, dependency changes, model defaults or downloads. Caller-supplied DecisionPort; the explicit benchmark recipe is Luna Decisions/OpenAI with fallbacks disabled. One absolute 120-second deadline per case, serial cases, at most two physical/logical requests per case, at most 24 physical requests and $2 accounted exposure for the screen, $0.05 reservation for an unknown charge. Use the existing fetch-level recorder and preserve every partial/failing call. The default CLI is dry-run; paid dispatch is explicit and credentials never enter manifests or output.

Hash the complete producer import closure, configuration and lockfile before and after the run. Validate all frozen native artifacts before the first dispatch. The native generation phase has already closed: report this as replay composition, not a newly measured end-to-end application latency. Preserve native timing separately and show provider/presentation/check latency. Do not run a second provider pass to improve an unattractive score.

Persist all twelve result rows, selected aliases, raw scores, model/provider/request metadata, selected actual masks, boxes/cutouts, typed failures, and physical accounting. The evaluator derives boxes and mask IoU from stored pixels. Compare with the paired old recipe on these same twelve inputs; retain H2c results even if this new mechanism wins. False boxes on negatives remain failures. UI misses do not disappear from the denominator or receive an unreported special backend.

## Before paid dispatch

Test source/mask hash mismatch, binary and geometry validation, stable ties, `none`, target/privacy isolation, edge-target label padding, alias/crop correspondence, immutable output, per-case/global budgets, cancellation at every awaited provider stage, no late success, and cleanup. A mocked fetch must exercise the actual runner and box-check preparation, not only a bare selector. After this screen, promising candidates proceed to full DEV and a new independent qualification cohort under the main quality plan.
