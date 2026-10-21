# Changelog

## 0.2.0 — unreleased

- Keep the original three-Choice region locator. With an explicitly supplied segmenter, use its selected region as a prompt on the full oriented image, then derive the cutout, bounding rectangle and centre from foreground mask pixels. A closed post-mask decision checks visible box containment on the full source with a seed anchor; one enclosing-mask correction and one recheck are allowed. No model-generated coordinates or extent search is added.
- Return a transparent PNG, cropped binary mask, source offset and bounding-box centre. Empty, ungrounded or unconfirmed masks remain unknown; backend failures remain errors. A cell is never substituted for a mask.
- Add explicit caller-owned MobileSAM and GrabCut adapters with pinned local assets, bounded native queues, physical cancellation/join and complete disposal. Model weights and optional native runtimes are separate prerequisites; imports never download weights or start workers.
- Preserve default region/classification compatibility and explicit optional legacy interval/proposal research strategies. The caller chooses every decision model, provider and segmenter.
- Prepare full-source containment images for both native and ordinary public transports while retaining original mask coordinates. Add regressions for small images, desktop-sized images, producer/evaluator receipts and independent per-profile freeze identities.
- Compare six text-only image representations in benchmark tooling. None qualified; the public experimental image selector rejects explicitly rather than silently selecting a losing encoder.
- Extend source, installed-archive, native Windows/Linux, resource and secret checks. Current qualification and limitations are recorded in [acceptance](docs/acceptance.md); this entry does not assert that the release is already published.

## 0.1.0 — initial standalone candidate

- Primary generic native Decisions adapter with explicit Luna Decisions routing, preserving genuine distributions; no Jev requirement.
- Provider-independent text/image classification through ordinary vision chat models; explicit one-winner ranks without invented probabilities.
- Direct OpenAI-compatible endpoint and optional OpenRouter adapters; custom DecisionPort for other protocols. Optional legacy Jev integration retains raw native distributions and stable ties.
- Three-stage generic object localization with coarse/fine grids and enlarged candidates.
- Abortable bounded operations, strict schemas, explicit provider routing and optional refinement port.
- CLI, Node examples, offline regressions, corpus and explicit real-provider benchmark tooling.
- MIT code licensing and separate third-party dataset notices.

Publication and acceptance status are recorded in docs/acceptance.md.
