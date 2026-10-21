# H3b failure analysis and one H3c test

**State: proposed DEV experiment only. No implementation, prompt dispatch, profile promotion, or accuracy claim.** H3b remains closed and immutable. The independent H3b evaluation is the authority for labels and metrics; visual reconstruction below diagnoses presentation and prompt shape, not ground truth.

## Closed result and request reconstruction

H3b is the closed run at `/root/work/zorya-classifier-runs/v03/h3b-grounded-masks-9c868f8d-9b93-463b-ae48-ca48ab6293e5/run.json`, SHA-256 `1dd6408dc1b584ddd884c79ee5c0afea17f85ca3c607e4d3fc2fc6fa602e89d5`. It used 22 physical calls, cost `$0.0046691`, and had no technical errors. The parent reports the independent result as **3/9 positive localizations, all three on photos; 0/3 UI positives; 0/3 map positives; and false completed outputs on all three verified negatives**. Preserve this result and all its receipts as a failed profile.

I rebuilt the exact candidate selector presentation from the frozen native masks and source images for `pilot-v03-photo-04` (a verified negative) and `pilot-v03-map-01` (an independently identified map miss). The injected decision stub only captured `DecisionRequest`s and returned deterministic locally valid choices; it made no provider or model calls. I separately reconstructed the current box-check request using the existing local presentation and a capturing decision stub. No truth, evaluator source, new targets, or candidate rewrites were passed to either reconstruction.

The selector view contains the untouched source followed by contact sheets. Each real candidate has a clean crop beside the same crop with its actual cyan mask. Thus the selected mask is visible at selection time. For map-01, `C00` is a very large mask covering the island/map scene and its source-space box contains the target sprite; other candidates include unit-sized crops and masks. The relative closed choice still selected `C00`. This is consistent with an inclusive candidate winning despite poor object purity, not proof of why the model chose it.

The final H3b check then shows the full source with only a magenta mask-derived box, an amber ROI, and the tiny cyan witness. It does **not** show the selected mask, its cutout, or a clean context crop. The criteria explicitly ask only whether the whole visible target is inside the magenta box and state that this is “box containment, not pixel-mask purity.” A box around much of the map satisfies containment when the unit is inside; it does not prove the mask depicts only that unit. The negative photo-04 request names `Bowl`, and its selected crop is a decorated, closed egg-like container. This is a genuine semantic ambiguity to record, not a reason to change the authored class or reinterpret the benchmark.

The selector request did carry the authored target text in shared context, but each candidate criterion used the generic phrase “whole visible requested target instance.” H3c leaves that selector request, choice operation, order, and presentation byte-for-byte unchanged. It changes only the final verification after the same selected candidate has been returned. That verifier tests visible identity and mask purity in the evidence itself instead of treating a containing box as sufficient.

## Evidence that motivates the hypothesis

Grounding DINO describes open-set detection from category names and referring expressions, which supports testing text-conditioned proposals but does not establish that every returned box is a correct instance or that broad boxes are pure objects. [Grounding DINO paper](https://arxiv.org/abs/2303.05499). SAM 2 is a promptable segmentation model; a detector box supplies a segmentation prompt, but the mask is not a semantic certificate for the requested class. [SAM 2 paper](https://arxiv.org/abs/2408.00714), [official Grounded SAM 2 implementation](https://github.com/IDEA-Research/Grounded-SAM-2).

Set-of-Mark work supports pairing human-speakable aliases with marked image regions for visual reference, which is relevant to the existing candidate sheets. It does not imply that a relative winner is target-correct, complete, or pure. [SoM paper](https://arxiv.org/abs/2310.11441), [official SoM repository](https://github.com/microsoft/SoM). POPE studies object hallucination in LVLMs and evaluates object existence with explicit binary probes; it motivates retaining verified negatives and independently checking target identity, not adding a universal confidence cutoff. [POPE paper](https://arxiv.org/abs/2305.10355).

These sources motivate a testable verifier design; they do not guarantee improvement on photos, UI icons, game sprites, or this provider.

## One predeclared mechanism: mask-aware final verification

Keep the H3b proposal artifacts, candidate order, two-stage structure, prompt target text, caller-selected Luna/OpenAI route, and all runtime budgets. Replace the current final containment-only view/question with one mask-aware verification request for the already-selected candidate. Include:

- the full unmodified source for scene identity and visible extent;
- a larger clean context crop around the selected source region;
- the exact selected mask overlay and the exact masked cutout on a neutral background, with labels outside source pixels;
- the selected mask-derived box and deterministic witness, retaining its provenance as selected-mask foreground rather than treating it as a prior seed;
- the exact authored target and exclusions in the question and each answer criterion.

Use one closed categorical answer with these predeclared outcomes:

| Answer                         | Required interpretation                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `match-complete-pure`          | The visible selected instance is the authored target; the mask isolates that instance without substantial non-target regions; and its derived box covers its whole visible extent within the ROI. |
| `wrong-object-or-contaminated` | The mask depicts another object/instance or includes substantial unrelated objects/background.                                                                                                    |
| `match-incomplete`             | The selected candidate is the authored target, but visible target content is missing from the mask or its derived box.                                                                            |
| `unknown`                      | Identity, purity, completeness, or same-instance association cannot be judged reliably.                                                                                                           |

The answer is a semantic state, not a numeric score: do not add a global confidence threshold or a minimum categorical probability. Only a valid maximum-choice result of `match-complete-pure` may produce a located result. Every other valid answer produces an explicit non-location/unknown outcome; in particular, `wrong-object-or-contaminated` does not assert global target absence. Invalid or tied protocol output follows existing choice validation and tie rules. Preserve raw answer scores and metadata.

The initial H3b candidate selector remains exactly unchanged, including all request fields, target wording, choice options, candidate order, presentation bytes, and tie behavior. H3c changes only the final verifier request for the already-selected candidate. This is one integrated verifier/prompt profile, not a sweep over prompt phrasings. The focused hypothesis is that showing the actual selected mask and cutout, and requiring identity, purity, and extent together, will reject broad/background masks and wrong semantic candidates that passed containment alone. It may also reject some correct masks; only paired measurements can resolve that tradeoff.

This profile does not repair missed proposals or guarantee ambiguous instance identity. If the initial relative choice remains unreliable even with the stronger verifier evidence, do not immediately add per-candidate calls. Stop this frozen comparison and draft a new separately named hypothesis first; any later per-candidate identity test must be an explicit bounded profile with its own DEV freeze.

## Frozen comparison and stop rule

The only next comparison is the existing H3b baseline versus this one H3c profile on the same fixed 12-case cohort, including all nine positives and the three verified negatives (`photo-04`, `ui-04`, `map-04`). Do not choose an alias from H3b output, change target wording based on revealed errors, reorder cases, filter cases, or expand the cohort. Keep `map-01` as the already observed positive miss. The authored `Bowl` label on photo-04 stays unchanged despite its egg-like appearance.

Freeze the H3c source and config closure, the unchanged H3b selector source/request identity and verifier text, candidate sheet and final presentation transforms, exact H3 native asset/run hashes, fixed-case manifest/source hashes, `gpt-6-luna-decisions` through the OpenAI provider with fallbacks disabled, physical-fetch recorder, 120-second per-case deadline, one worker, and the 24-call / `$2` cap before dispatch. Maximum is two `DecisionPort` calls per case and 24 physical calls total. Preserve the original full denominator and every timeout, error, unknown cost, rejected selection, and non-location. Await physical settlement before sealing the run. Do not dispatch until the independent evaluator has closed H3b and reviewed this freeze.

The predeclared development gate is: zero false locations on the three verified negatives, at least the H3b baseline of three correct positive localizations, and no increase in technical failure rate. Report the paired positive results separately for photo, UI, and map, plus false-complete/unknown counts, source-space boxes, mask purity metrics, latency, call counts, and known/unknown cost. No single aggregate may hide a lost UI/map result. If the gate fails, retain H3c as failed evidence and stop this candidate family on the exposed cohort. There is no second H3c prompt variant or post-hoc winner selection; any materially different mechanism requires a fresh written plan and development freeze before further dispatch.
