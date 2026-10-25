# Changelog

## 0.2.3 — 2026-10-25

- On one exposed DEV12 pilot (12 tasks across 9 unique images), the existing candidate-mask **H8a** route—using explicitly configured OpenAI **gpt-6-luna**, without fine-tuning—passed the strict box criterion on **7/9** tasks with an object. One native **Jev 1.14** Box+Noul run passed on **3/9**. Secondary IoU-only results were **7/9 vs 8/9**; false outputs on the three absent-object tasks were **2/3 vs 1/3**. This is one development comparison, not heldout qualification or a general accuracy claim. H8a remains a research recipe, not the default `locate`/`extract` path or an npm-shipped strategy. [Report](https://github.com/zoomplus/zorya-classifier/blob/v0.2.3/docs/research/v03-jev-native-box-results.ru.md) · [Evidence](https://github.com/zoomplus/zorya-classifier/blob/v0.2.3/docs/evidence/v03/jev-native-box-dev12-20261025.json).
- Documentation, CLI help and public JSDoc no longer label existing spatial APIs “experimental” or “unqualified”. Their behavior and TypeScript signatures are unchanged: a grid cell is not a whole-object box, box validation does not establish mask quality, and models/providers/assets remain caller-supplied.
- Retire the public IMAGE-AS-TEXT representation selector. Requests using it now fail strict input validation; ordinary text classification remains supported, while the experimental encoders remain benchmark-only. See the [migration note](docs/migrations/experimental-text-image-removal.ru.md).

## 0.2.0 — 2026-10-21

- Keep the original three-Choice region locator. With an explicitly supplied segmenter, use its selected region as a prompt on the full oriented image, then derive the cutout, bounding rectangle and centre from foreground mask pixels. A closed post-mask decision checks visible box containment on the full source with a seed anchor; one enclosing-mask correction and one recheck are allowed. No model-generated coordinates or extent search is added.
- Return a transparent PNG, cropped binary mask, source offset and bounding-box centre. Empty, ungrounded or unconfirmed masks remain unknown; backend failures remain errors. A cell is never substituted for a mask.
- Add explicit caller-owned MobileSAM and GrabCut adapters with pinned local assets, bounded native queues, physical cancellation/join and complete disposal. Model weights and optional native runtimes are separate prerequisites; imports never download weights or start workers.
- Preserve default region/classification compatibility and explicit optional legacy interval/proposal research strategies. The caller chooses every decision model, provider and segmenter.
- Prepare full-source containment images for both native and ordinary public transports while retaining original mask coordinates. Add regressions for small images, desktop-sized images, producer/evaluator receipts and independent per-profile freeze identities.
- Compare six text-only image representations in benchmark tooling. None qualified; the public experimental image selector rejects explicitly rather than silently selecting a losing encoder.
- Extend source, installed-archive, native Windows/Linux, resource and secret checks. The corrected two-hour checked-flow run and frozen 80-case quality gate passed; [acceptance](docs/acceptance.md) separates seed, whole-box and mask scores, unavailable outputs and final release evidence.

## 0.1.0 — initial standalone candidate

- Primary generic native Decisions adapter with explicit Luna Decisions routing, preserving genuine distributions; no Jev requirement.
- Provider-independent text/image classification through ordinary vision chat models; explicit one-winner ranks without invented probabilities.
- Direct OpenAI-compatible endpoint and optional OpenRouter adapters; custom DecisionPort for other protocols. Optional legacy Jev integration retains raw native distributions and stable ties.
- Three-stage generic object localization with coarse/fine grids and enlarged candidates.
- Abortable bounded operations, strict schemas, explicit provider routing and optional refinement port.
- CLI, Node examples, offline regressions, corpus and explicit real-provider benchmark tooling.
- MIT code licensing and separate third-party dataset notices.

Publication and acceptance status are recorded in docs/acceptance.md.
