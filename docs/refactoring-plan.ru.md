# План рефакторинга (принятые волны)

Исторические планы и frozen evidence в `docs/` не редактировать задним числом. Список удалений пуст до доказанной избыточности (волна 7).

## Волна 1 — baseline (DONE)

- Зафиксирован baseline `npm test` (только `test/*.test.ts`): **674** теста, **671** pass, **3** fail.
- Типичный сбой до WAVE2A: integrity receipt loader в H6 не сопоставлял symlink-алиасы каталогов с каноническим `realpath` (ломало replay/evaluator при разных путях к одному файлу).
- **WAVE2A (DONE на ветке):** `buildIntegrityReceiptByRealPath` + portable тест `test/v03-h6-integrity-receipt-path-identity.test.ts`; evidence — `/root/.codex/artifacts/zorya-classifier-refactor-20261023/wave2a-*.log`.

## Волна 2 — foundation (DONE)

| #   | Владение                                                                                             | Проверки                                |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 0   | `benchmarks/v03/h6-replay-kernel.ts`, тест integrity                                                 | отмена в catch `realpath`               |
| 1   | `scripts/boundaries.mjs`, `test/boundaries.test.ts`                                                  | `npm run boundaries`                    |
| 2   | `scripts/test-catalog.*`, `scripts/run-*-tests.mjs`, `package.json`, split H10 local test            | `test/test-catalog.test.ts`, `npm test` |
| 3   | `knip.json`                                                                                          | `npm run dead-code:ci`                  |
| 4   | `AGENTS.md`, `.cursor/rules/zorya-classifier.mdc`, `docs/agents.ru.md`, этот файл, `CONTRIBUTING.md` | review + CI                             |

**WAVE2B (DONE):** review-fixes main — import-type/self-import/resolution в boundaries, Zod-каталог тестов, knip без избыточных benchmark entry, документация workflow Composer; исторические логи focused gates сохранены (`wave2b-final-check.log` и др.).

**Checkpoint Linux22 (root, measured):** commit `c3923f073de1f53c6a687bd9ef7e797d9ab53052` на `work/classifier-refactor-20261023`; `npm run check` **764/764** pass, 0 fail, 0 skip (secrets staged/worktree, typecheck, lint, boundaries, knip, build, format) — receipt `/root/.codex/artifacts/zorya-classifier-refactor-20261023/wave2-root-checkpoint-retry.log`. Ранний прогон того же checkpoint: **762/762** pass, единственный сбой commit hook — `format:check` на `test/boundaries.test.ts` (`wave2-root-checkpoint.log`, не перезаписывать). Shell Composer: Node **v24.22.1** at `/root/.local/share/cursor-agent/versions/2026.10.22-27dcf5f/node`. Root Linux22: `/usr/bin/node` **v22.23.2**. Успех Windows/CI matrix здесь **не заявлять**.

Инварианты совместимости: публичные entrypoints, v0.2 region flow, benchmark identities, secret hygiene без ослаблений.

**Knip (п. 3):** сохранён glob `benchmarks/**/*.ts` в entry (без дублирующих named patterns); `eslint.config.mjs` убран из entry/project; скрипты вызывают `node --import tsx`. Полный переход на точечные entry — волна 7.

## Волна 3 — контракты + geometry (DONE)

- Leaf-модули `geometry`, `image`, `decision`, `classification`, `localization`, `validation`; фасад `contracts.ts` сохраняет прежние export names.
- Metadata: `decisionMetadataSchema` + локальные `.strict()`/`.extend()` (box-check max 256/512; extract-from-region stages strict); segmentation Zod (`segmentationMetadataSchema`, `segmentationMetadataSafeSchema`) и interface `SegmentationMetadata` в `segmentation-metadata.ts`.
- Geometry: `containsRect`, `containsNonEmptyRect`, `intersectsRect`; extraction `contains()` = non-empty variant.
- Публичный `dist/index.d.ts` совпадает с baseline manifest; `entities/contracts.d.ts` — re-export facade (доп. leaf `.d.ts` в dist). Evidence: `/root/.codex/artifacts/zorya-classifier-refactor-20261023/wave3-*`; post-review-fixes — `wave3-review-fixes-*`.
- **Checkpoint Linux22 (root, measured):** commit `0a5095fcf5d2b4eec31ab920b17086c81be4cff6` на `work/classifier-refactor-20261023`; `npm run check` **764/764** pass, 0 fail, 0 skip (secrets staged/worktree, typecheck, lint, boundaries, knip, build, format); root `pack:check` — 383 archive files, 126 runtime dist files, 207 consumer declarations, 0 provider HTTP calls. Receipts: `/root/.codex/artifacts/zorya-classifier-refactor-20261023/wave3-root-checkpoint.log`, `wave3-root-pack.log`.

## Волна 4 — app factory / lifecycle (DONE)

- Разделение `create-classifier.ts` на `classifier-contracts`, `classifier-config`, `classifier-runtime`, `classifier-spatial`, `classifier-representation`; публичные export names и поведение без изменений.
- **Checkpoint Linux22 (root):** commit `1515f15c1ff7c11cc0fcb6240619f57115d5cf2c`; `npm run check` **764/764**; pack 393/136/208 — receipts `wave4-root-pack.log` (не перезаписывать).

## Волна 5 — extraction / proposals / presentation (DONE)

- Shared segmentation validation: `src/features/segmentation/validation.ts`, `source-mask.ts`, `region-result.ts`; processes `extract.ts`, `extract-from-region.ts` — orchestration only.
- Proposal validation/presentation: `src/features/proposals/validation.ts`, `presentation.ts`; process `proposal-location.ts`.
- Infrastructure split: `proposal-presentation-input.ts`, `proposal-presentation-pixels.ts` из `proposal-presentation.ts`.
- Публичные entrypoints и семантика v0.2 region flow без изменений; `contains()` wrapper удалён — прямой `containsNonEmptyRect`.
- **Checkpoint Linux22 (root):** commit `abc68b3a4fd39afa8e454d44a5262d213c23c3de`; `npm run check` **765/765** (receipt checkpoint владельца, не перезаписывать).

## Волна 6 — transports / native (ACTIVE)

| #   | Владение                                                                                                                                                                                         | Статус    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| 6A  | `decision-transport/*`, split `vision-chat/*`, фасад `vision-chat.ts`; удалён `openrouter-common.ts`; closure/metadata в `ordinaryvisionpilot.ts`, `seedunboundedpilot.ts`, `model-selection.ts` | IN REVIEW |

## Волны 7–9 (ожидают)

7. Research / npm dist + dead-code (полный Knip по benchmarks)
8. Русская документация / provenance (расширение)
9. Финальный review: check, pack, Windows/Node 24 matrix, integration evidence

## Платформы

CI matrix (целевая): `ubuntu-latest`, `windows-latest` × Node 22 и 24. **Локально на хосте:** `/usr/bin/node` **v22.23.2**; прогоны Windows и Node 24 — **pending** (не заявлять успех CI или локального Node 24 без receipt).
