# Правила для агентов (Zorya Classifier)

Этот репозиторий — независимая MIT-библиотека. Общие правила владельца: [`/root/.cursor/rules/context7.mdc`](/root/.cursor/rules/context7.mdc) (актуальные внешние SDK/API — только когда задача про библиотеку/CLI/облако; не для рефакторинга и внутренней политики), [`/root/.cursor/rules/repository-cleanliness.mdc`](/root/.cursor/rules/repository-cleanliness.mdc) (уборка только task-owned артефактов, сохранять чужое состояние). Технический контракт — [AGENTS.md](../AGENTS.md) (англ.).

## Workflow Composer (принятый refactor plan)

- **Каждая coding-задача** — через **Cursor Composer** под coordination **supervisor** **`gpt-6-luna`**, reasoning **high**, **`fork_turns=none`**; supervisor **владеет каждым** Cursor CLI процессом (включая один последовательный процесс); dispatch только на **`composer-2.5-fast`** («Composer 2.5 Fast»), **без fallback** на Auto, `composer-2.5` или другие семейства при блокировке auth/quota/access — остановиться и сообщить фактический blocker.
- **Один supervisor на процесс**; **main orchestrator** (модель человека) **human-selected**, без default main model, **не запускает и не управляет** Cursor CLI напрямую.
- Dedicated research/review subagents — **только по явному запросу** владельца.
- **Session authorization** достаточна для scoped work; без лишнего owner re-dispatch/approval.
- Параллельно — **не более трёх Composer глобально**; отдельные **worktree** и **disjoint file ownership**; merge после diff и тестов.

## План до правок

`git status`, ветка, границы владения волны, не смешивать чужие незакоммиченные изменения.

## Архитектура и инварианты

Слои: `app` → processes/features/entities/shared/infrastructure; `processes` → features/entities/shared; `features` → entities/shared; `infrastructure` → infrastructure/features/entities/shared (не app/processes); `entities` → entities/shared; `shared` → shared и только `entities/errors.ts`. Проверка: `npm run boundaries` (в т.ч. `import()` type refs, package self-import `zorya-classifier/*` кроме `app/cli-route.ts`, явный fail на missing local target; declared npm deps включая `@scope/pkg` — OK; undeclared `@…` — unsupported local alias).

Строгий TypeScript и Zod на границах; без fallback провайдера; отмена и дедлайны до await; импорт не запускает фоновую работу. Frozen benchmark evidence, `hashCanonical` и порядок полей JSON не переписывать задним числом.

## Тесты и доказательства

- **Portable offline** — `npm test` (`scripts/test-catalog.json`, Zod в `scripts/test-catalog.ts`, раннер `scripts/run-portable-tests.mjs` через `node --import tsx`).
- **Local evidence** — `npm run test:local-evidence` (2 replay-группы + H10 minimal manifest; путь pinned в `benchmarks/v03/evaluate-h10-clipseg-local-evidence.test.ts`); prerequisites в каталоге.
- **Python/native** — `npm run test:python-native` (2 runner-группы; `H10_PYTHON_EXECUTABLE`, `H11_PYTHON_EXECUTABLE`).

H6/H8 optional native тесты **остаются видимыми** в portable-наборе (skip при отсутствии артефактов, не скрывать). H8/H11 evaluator — portable; H10 synthetic — portable; только historical minimal-inputs digest — local-evidence.

**Supervisor-host (Linux):** `/usr/bin/node` **v22.23.2**; Windows и Node 24 matrix — **pending**. Последний полный `npm run check` на stable tree: **761/761** pass (portable catalog + gates). Runtime evidence для shell supervisor — не путать с внутренним runtime Cursor Composer CLI без отдельного receipt.

## Секреты, платные прогоны, публикация

`npm run secrets:check`, Husky staged scan, `npm run pack:check`. Не коммитить `.env`, приватные медиа, логи. Платные провайдеры, GPU/inference и публикация — только в явно авторизованном scope с бюджетами.

## Уборка

Удалять только артефакты текущей задачи. Не трогать чужие ветки, locks и historical evidence без явного указания.
