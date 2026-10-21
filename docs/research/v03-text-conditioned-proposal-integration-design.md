# Prospective v0.3 text-conditioned proposal integration

**State: design only.** This is not a public API decision, an implementation, or an accuracy claim. Wait for the closed H3b fixed-12 evaluation before writing runtime code. H3b candidate availability alone cannot establish valid localization or semantic selection quality.

## Goal and boundaries

Add an explicit opt-in route that asks a caller-owned proposal generator for source-space object masks conditioned on the caller's target text. It must be callable without a grid location or `seedRegion`. The existing region locator and seeded proposal route keep their contracts and behavior. In particular, do not loosen `ObjectProposalInput.seedRegion`, manufacture a seed from a grid cell, or invoke the seeded route and relabel its candidates as seedless.

The proposal generator supplies geometry candidates; it does not certify target identity, absence, or full extent. A generic injected `DecisionPort` selects among the supplied masks using full-source context and a closed `C00`–`C35`/`none` choice. A second independent decision checks whether the selected mask-derived box covers the visible target extent. Preserve actual packed mask pixels and derive all source coordinates from them. Never accept model-generated coordinates.

This is a complement experiment for photos, UI/map icons, and other cases where a caller has a text description but no interior click/seed. Open-vocabulary detectors may miss proprietary UI symbols, game units, stylized maps, or text labels; mask generation cannot recover an object for which the text-conditioned detector produced no prompt box. A `none` result or empty proposal set therefore means `unknown`, not global absence. The caller may separately run classification/presence logic; this locator does not invent it.

## Proposed public boundary

Keep the existing `ObjectProposalInput` and `ObjectProposalPort` intact for the seed-based path. Add a parallel, explicitly named port with no seed field, conceptually:

```ts
interface TextConditionedProposalInput {
  image: RgbaRaster
  target: string
  exclusions: readonly string[]
  roi: PixelRect
  signal: AbortSignal
}

interface TextConditionedObjectProposalPort {
  propose(input: TextConditionedProposalInput): Promise<ObjectProposalBatch>
}
```

It can reuse `ObjectProposal`, `ObjectProposalBatch`, `PackedBinaryMask`, the existing 36-candidate limit, and the 10 MiB total packed-mask limit. `propose` returns ordered aliases `C00`…`C35`, full-oriented-source masks, the source dimensions, and diagnostic `SegmentationMetadata`. Validate and snapshot buffers before any await. Require canonical packed bits, exact source dimensions, hard-ROI containment, and bounded total bytes. Preserve candidate order and any uncalibrated native scores for diagnostics only; never rank by those scores, clamp them, or send them to the semantic model. A separate port avoids changing the meaning of the existing seed-dependent implementation.

Expose a separate process/factory, for example `locateFromTextProposals`, composed from `TextConditionedObjectProposalPort`, generic `DecisionPort`, raster/cutout codecs, and a no-seed proposal presentation port. Do not silently route `locate()` or the current default region mode through it. `createClassifier` may expose a second opt-in method only after the experiment passes the predeclared gate. An implementation may factor private mask validation/rendering helpers, but the existing region and seeded public types must remain source-compatible.

The result needs its own discriminated contract because `WholeObjectLocated.seedRegion` is mandatory today. A successful result should carry the exact source-space `region`, source-space full-resolution binary mask, normalized region, proposal metadata, the independent completeness verdict, and stage metadata; it must not fill `seedRegion` with a fabricated witness. The returned witness is diagnostic provenance only:

```ts
witness: {
  x: number
  y: number
  origin: 'selected-mask-first-foreground-row-major'
}
```

Compute this point from the selected mask's actual visible foreground pixels, using a fixed row-major scan. Compute `region` from those same pixels (after alpha visibility and ROI checks), with inclusive extrema converted to `{left, top, width, height}`. Persist the point and origin in the result and box-check request. If the selected mask has no visible foreground, reject that candidate as non-locatable. The witness is never a search seed and must not be used to claim that a candidate generator was seeded.

For the candidate presentation, add a no-seed presentation contract rather than passing a fake `seedRegion` into `ObjectProposalPresentationPort`. It should render the unmodified full source plus bounded labeled tiles showing each candidate's actual mask, derived rectangle, and optional clean crop. Labels stay outside the crop. Preserve source-coordinate transforms in metadata. Reuse the lower-level raster and PNG helpers where possible. Respect the request's maximum image count, total presentation-byte budget, image side bounds, aspect ratio, and crop-border constraints before dispatching a model call.

## Runtime flow and result semantics

One operation has one absolute deadline and owned input buffers:

1. Validate and own encoded image bytes, target, exclusions, and ROI. Normalize orientation once and snapshot the source RGBA raster. Reject source/pixel-limit or ROI errors before model work.
2. Call the explicit `TextConditionedObjectProposalPort` once on the full oriented source and authored target/exclusions. The port is caller-owned: no library-selected model, provider, checkpoint, download, credential lookup, or fallback. Native adapters require explicit caller-selected strategy and already-local, caller-supplied assets. An ordinary caller service may implement the port too, but must report its actual model/provider/runtime and physical work honestly.
3. Validate the returned batch, derive each box and witness only from actual mask foreground, reject invalid/out-of-ROI masks, and build bounded candidate sheets. An empty batch returns `unknown`; it is not evidence that the target is absent.
4. Use the generic injected `DecisionPort` for one closed candidate-selection call. Include the full original scene, target/exclusions, aliases, candidate views, and derived boxes. The available choice IDs are exactly the ordered valid aliases plus `none`. Existing maximum/tie validation applies; there is no confidence threshold. A `none` answer returns `unknown` because proposals may be incomplete.
5. For a selected mask, issue one independent box-completeness Noul decision using the full source, the actual selected mask/derived rectangle, and the mask-derived witness. Ask only whether that rectangle covers the same visible instance's full visible extent within ROI. A positive result permits `located`; zero or operationally unknown yields `unknown`. This is not a pixel-perfect segmentation guarantee. If the prompt is ambiguous among multiple indistinguishable target instances without a caller-provided instance identity, the selector should return `none`; the API cannot promise deterministic instance identity from target text alone.
6. Return the original selected mask, its foreground-derived source box, and stage receipts. No extra nine-point/grid enumeration or automatic fallback is run. If extraction is later needed, it must use the actual selected mask and a separately specified seedless extraction workflow; it must not pass the witness into the old seed-based extraction API.

The maximum is one proposal-port invocation and two `DecisionPort` calls per case; early exits use fewer calls. Allocate that call ceiling before image encoding. Record each stage separately: validation/normalization, proposal wall time and reported metadata, mask validation/box derivation, candidate preparation bytes and views, selection wall time plus `DecisionMetadata`, box-check wall time plus `DecisionMetadata`, and total time. Sum known DecisionPort `costUsd`, count null-cost stages as unknown, and record physical request attempts at the adapter/fetch boundary separately from logical calls. Native proposal runtime is a latency/resource measurement, not a model-confidence score; record device, model revision, asset hashes, peak memory where available, and caller-owned license/runtime metadata. If a remote proposal adapter is used, its owner must also report actual cost and physical-call receipts or mark them unknown rather than omit them.

The absolute deadline covers normalization, proposal inference, mask validation, presentation, both decisions, serialization, and any optional cutout encoding. Cancellation prevents subsequent dispatch, but the operation does not release its concurrency slot or report settled until its own physical proposal/decision work closes. A shared caller-owned adapter must not be globally settled or disposed by one request. The adapter owner remains responsible for port shutdown. Preserve typed technical errors, timeout status, and unknown cost; do not turn them into `none` or absence.

## Cost and compatibility profile

| Stage                          |      Maximum per case | Cost/reporting                                                                                                                                            |
| ------------------------------ | --------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text-conditioned proposal port |          1 invocation | Caller-selected local model/device/assets or caller service; record actual wall time, revisions/assets, resource use, and any caller-known external cost. |
| Closed semantic selection      | 1 `DecisionPort` call | Existing `DecisionMetadata`; record known cost and unknown-cost count, plus physical fetch count from recorder.                                           |
| Independent completeness check | 1 `DecisionPort` call | Same metadata/receipt treatment; only an affirmative valid result can mark the box complete.                                                              |
| Automatic fallback / grid scan |                     0 | None. Region mode remains its existing behavior and can be run as a separately named baseline by the caller/evaluator.                                    |

Do not set a provider/model default or add a hidden model download. Do not change current `locate` defaults, seed-based proposal contracts, existing public region behavior, or v0.2 extraction. Keep source API selection explicit, e.g. a new `locateFromTextProposals` method or a caller-composed process.

## Frozen DEV40 comparison before any qualification

Only proceed to a full development comparison if the completed H3b evaluation satisfies its predeclared candidate-availability and semantic-selection gates. Candidate availability is a diagnostic, not an accuracy result; use the independently joined H3b result, not producer-side masks or a visual anecdote, to decide whether this design merits implementation.

Before any full DEV40 dispatch, freeze both the candidate recipe and the unchanged current locator control over the same canonical 40-case DEV manifest, including all positive strata and the verified negatives. Use the same source hashes, authored target text, ROI policy, and case order for both profiles. Do not select only the twelve H3 pilot cases or rewrite targets from revealed outcomes. Retain every source, class, empty-proposal, timeout, provider failure, `none`, and unknown row in each denominator. If a presence-first caller profile is part of the product hypothesis, freeze that exact composed profile as its own arm and run the same fixed cases; do not filter cases after classification.

The producer reads only pinned input manifests and source images. The independent evaluator alone joins truth after producer closure. Freeze before dispatch: exact source/proposal/adapter code closure and environment; all model/checkpoint/tokenizer revisions and byte hashes/licenses; prompt strings; target forwarding policy; proposal thresholds, order, candidate and packed-byte caps; presentation policy; provider/model settings; operation deadline; concurrency; physical request/cost caps; case schedule; recorder policy; and evaluator metric/gate code hash. Record source and output-file hashes per row, a final run hash, and explicit incomplete rows for failures. Do not edit the recipe after seeing per-case truth or replace it after a failed profile.

Keep candidate coverage separate from final selection. Measure valid-target candidate recall/coverage and negative proposal-count diagnostics independently from closed-choice localization: box correctness on positives, false locations on verified negatives, unknown/error rates, mask quality where labeled, wall time, VRAM/RAM, calls, known/unknown cost. Irrelevant candidates on a negative are not false positives at the proposal stage; only a final selected geometry is. A full DEV pass is a development gate, not qualification. Freeze any selected profile before acquiring/reading a fresh source-group-disjoint heldout cohort, then rerun the exact executable recipe there. Preserve all failed and superseded runs.

## Risks and pivot conditions

- Target-conditioned generators may return no candidate for icons, novel game pieces, small text, occlusion, or stylized map symbols. This is a proposal miss; do not rewrite target phrases based on truth.
- More candidates can raise selector confusion and request size. Preserve native return order and the 36/10 MiB limits; do not treat higher candidate count as better recall without independent labels.
- A broad semantic target can match several instances. Without an explicit caller instance identity, return unknown when selection is ambiguous rather than silently inventing a seed.
- The selected mask can be incomplete even when its box looks plausible. A complete-box decision is not proof of complete pixels; preserve mask and box evidence as separate metrics.
- If H3b shows candidate availability but selection fails, pivot the experiment at the frozen-profile gate rather than adding more post-hoc reranking, free coordinates, prompt rewriting, or unchanged grid scans.
- If the time/cost/size budget fails, reject the profile or revise and re-freeze a new DEV recipe before any further comparison. Keep existing region and seed APIs usable throughout.
