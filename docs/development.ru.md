# Разработка Zorya Classifier

Руководство для участников разработки и исполнителей Composer. Контракт: [AGENTS.md](https://github.com/zoomplus/zorya-classifier/blob/main/AGENTS.md). Слои и порты: [architecture.ru.md](architecture.ru.md). Порядок работы агентов: [agents.ru.md](agents.ru.md). **Измеренные контрольные точки** (Linux Node 22/24, Windows, интерпретатор Python) — в [плане рефакторинга](refactoring-plan.ru.md#платформы-и-ci).

## Быстрый старт

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix packages/mcp
npm run prepare    # по желанию: локальный Husky
npm run test:mcp
npm run check
npm run pack:check
npm run mcp:check
npm run mcp:pack:check
npm run format:check
```

`zorya-classifier` и `packages/mcp` — два независимо блокируемых npm-пакета: устанавливайте оба lockfile, не рассчитывайте на workspace hoisting. Root `npm run check` и `npm run pack:check` охватывают обе package-поверхности, сохраняя отдельные dependency locks и working directories. Таргетированные `mcp:check` и `mcp:pack:check` запускают gates только MCP-пакета. MCP использует опубликованную `zorya-classifier@0.2.3` и собственную Zod 4; библиотека сохраняет Zod 3 и свой публичный API.

`npm test` по умолчанию остаётся офлайн-каталогом переносимых тестов библиотеки (без живого провайдера). Root test catalog содержит отдельную четвёртую группу `mcp`, которая запускает runner пакета из `packages/mcp` cwd; это гарантирует резолв опубликованной зависимости из package lock, без подстановки root TypeScript aliases. Импорт пакета не запускает фоновые процессы и не скачивает веса. Подробности и подтверждённые текущие receipts: [MCP README](../packages/mcp/README.md) и [MCP validation](mcp-validation.ru.md).

## Порядок чтения

1. [README.ru.md](README.ru.md) — возможности, примеры, статус без универсальных заявлений о качестве.
2. [Контракт участников](https://github.com/zoomplus/zorya-classifier/blob/main/AGENTS.md) — предметная область, жизненный цикл, каталог `benchmarks`, секреты.
3. [Архитектура](architecture.ru.md) — зависимости слоёв, пространственный поток `extract`.
4. [api.md](api.md) — публичные типы и лимиты.
5. [CONTRIBUTING.md](https://github.com/zoomplus/zorya-classifier/blob/main/CONTRIBUTING.md) — ожидания запроса на слияние.
6. Пространственные сценарии v0.2: [v02-usage.md](v02-usage.md), [0.2.0-plan.md](0.2.0-plan.md).
7. Итерация качества: [план 0.3.0](https://github.com/zoomplus/zorya-classifier/blob/main/docs/0.3.0-quality-plan.md).
8. Отдельный MCP-сервер: [README пакета](../packages/mcp/README.md), [план реализации](mcp-implementation-plan.ru.md), [результаты проверок](mcp-validation.ru.md).

## Скрипты

| Команда                                    | Назначение                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `npm test`                                 | Переносимый каталог: `node --import tsx scripts/run-classified-tests.mjs portable`         |
| `npm run test:mcp`                         | MCP-группа каталога: делегирование runner-у пакета из его рабочего каталога `packages/mcp` |
| `npm run test:local-evidence`              | 5 файлов, 16 тестов с локальными/замороженными артефактами; нужны предварительные условия  |
| `npm run test:python-native`               | Тесты с предварительными условиями Python и нативной среды                                 |
| `npm run check`                            | Проверки root-библиотеки и обязательная MCP package test lane                              |
| `npm run pack:check`                       | Байты и API архивов обоих пакетов в изолированных consumers                                |
| `npm run mcp:check`                        | Полный check независимо заблокированного `packages/mcp`                                    |
| `npm run mcp:pack:check`                   | Архивный, установленный consumer и secret checks для `zorya-classifier-mcp`                |
| `npm run secrets:check` / `secrets:staged` | Сканирование рабочего дерева и версий файлов, добавленных в индекс Git                     |
| `npm run boundaries`                       | Слои и циклы                                                                               |
| `npm run dead-code:ci`                     | Knip (явные точки входа; исключение — необязательный `onnxruntime-node`)                   |

Единый раннер: `scripts/run-classified-tests.mjs` и Zod-каталог `scripts/test-catalog.ts` / `scripts/test-catalog.json`.

## Четыре группы тестов

| Группа               | Команда                                                                       | Состав                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`portable`**       | `npm test`                                                                    | Заглушки, фикстуры, границы слоёв, большинство `test/*.test.ts`, часть `benchmarks/v03/*.test.ts`; необязательные нативные проверки (включая H6 и native H8) **видны здесь** и могут **пропускаться** без предварительных условий. Синтетическая проверка `ui-state-zero-query-execution-v2.test.ts` не читает внешнее дерево evidence.                                                                                                             |
| **`local-evidence`** | `npm run test:local-evidence`                                                 | **5 файлов, 16 тестов:** H5 (`benchmarks/v03/h5-replay-local.test.ts`), `grounded-mask` (`grounded-mask-replay-local.test.ts`), H10 (`evaluate-h10-clipseg-local-evidence.test.ts`), `test/jev-native-box-local-evidence.test.ts` и четыре сценария `benchmarks/v03/h8a-fresh-comparison/ui-state-zero-query-execution-v2-local-evidence.test.ts`. Последние проверяют реальные закреплённые protocol/predecessor receipts из внешнего frozen root. |
| **`python-native`**  | `npm run test:python-native`                                                  | `h10-clipseg-runner.test.ts`, `h11-sa2va-runner.test.ts`                                                                                                                                                                                                                                                                                                                                                                                            |
| **`mcp`**            | `npm run test:mcp` (`node --import tsx scripts/run-classified-tests.mjs mcp`) | Запускает runner MCP-пакета из `packages/mcp`; тесты разрешают опубликованную `zorya-classifier@0.2.3` по MCP lockfile, а не по root source aliases.                                                                                                                                                                                                                                                                                                |

Необязательные native H6 и native H8 проверки остаются в `portable` и могут пропускаться при отсутствии своих условий. Четыре H8 zero-query сценария, которым нужны внешние protocol/predecessor artifacts, входят в `local-evidence`; они отделены от одноимённого по теме синтетического portable fixture. Новый тест добавляют в `*.test.ts` и **ровно одну** группу каталога; `test/test-catalog.test.ts` проверяет классификацию.

`mcp` — группа отдельного package test runner, а не дополнительный источник library tests. Root `portable` остаётся группой библиотеки; уже опубликованные исторические счётчики этого каталога и платформенные измерения не заменяются количеством MCP package tests. Состав и точные receipts MCP указаны в [MCP validation](mcp-validation.ru.md).

### Предварительные условия `local-evidence`

Тесты воспроизведения ожидают **заранее подготовленное** дерево данных и журналы, а не только исходники репозитория:

- Воспроизведение `grounded-mask` ищет **соседний** архив модели/данных и Python-журнал относительно **родителя** каталога, заданного корнем данных (переменная `ZORYA_V03_DATA_ROOT` и связанные пути в секции предварительных условий каталога). Нужна корректная структура архивного каталога и квитанции модели/окружения.
- Указать `ZORYA_V03_DATA_ROOT` только на каталог с исходниками репозитория **не создаёт** эти артефакты автоматически.
- Четырём `ui-state-zero-query-execution-v2-local-evidence` сценариям нужен подготовленный frozen artifact root, заданный в политике как `UI_STATE_DEV40_ROOT`, с закреплённым zero-query protocol и predecessor evidence authority/freeze/execution. Проверки сверяют путь внутри этого root и соответствие pinned SHA-256; отсутствующее или изменённое свидетельство приводит к отказу.
- Переносимая `ui-state-zero-query-execution-v2.test.ts` использует локальный синтетический protocol fixture для проверки схемы, счётчиков и deadline. Этот fixture не читает `UI_STATE_DEV40_ROOT`, не подменяет реальные receipts и не считается подтверждением frozen H8 evidence.

При **правильной** раскладке данных на Linux Node 22 зафиксирован исторический успешный прогон **7/7** только для трёх исходных suites — журнал `final-local-evidence-node22-configured.log`. Ранний прогон с неверной конфигурацией — `final-local-evidence-node22.log` (три падения `grounded-mask`) — сохранён как исторический, его не скрывают. Эти старые counts относятся только к прежним трём suites и не являются результатом нынешней группы из пяти файлов и 16 сценариев.

Не коммитьте пути к частным корпусам и абсолютные адреса конкретного хоста в документацию.

## Добавить адаптер, операцию или тест

1. **Контракт** — Zod и типы в `src/entities/*`; правила в `features` или оркестрация в `processes`; HTTP- и нативная реализация — в `infrastructure`, без импорта `infrastructure` из `entities`/`features`/`processes`.
2. **Публичный адаптер** — транспорт в `infrastructure/decision-transport` + `vision-chat`; фасад в `src/openrouter.ts` / `openai-compatible.ts` (одна из четырёх точек входа библиотеки).
3. **Тесты смысла:** отмена после постановки в очередь, поздний результат после отмены, `CAPACITY`, мутация входа после старта, ожидание завершения в `dispose`, реальные публичные адаптеры и лимиты подготовленного изображения 280–1568 (не только заглушка `DecisionPort`).
4. После новых импортов — `npm run boundaries`; при смене состава `dist` и экспортов — `npm run pack:check`.
5. Только исследования — под `benchmarks/experiments/`; не расширять npm `files` без отдельного продуктового решения.

Не добавляйте сетевые микросервисы и абстракции «ради архитектуры».

## Учётные данные каталога `benchmarks`

`benchmarks/credentials.ts`: по умолчанию `process.env.OPENROUTER_API_KEY`. Явный **`--env-file`** поддерживают **только** `benchmarks/v02/run-region-seeded-dev.ts` и `benchmarks/v03/run-quality-pilot.ts` среди изменённых платных CLI каталога `benchmarks`; остальные читают переменные окружения процесса. `readOpenRouterKeyFromEnvFile(path)` при отсутствии или невалидности файла **не** откатывается к окружению процесса. Чужие `.env` других проектов не загружаются.

Тесты группы `portable` и библиотека ключа в окружении не требуют.

## Секреты, архив пакета, зависимости

- **Husky:** сканирование **версий файлов, добавленных в индекс Git**, затем проверки и форматирование.
- **`secrets:check`:** отслеживаемые и неигнорируемые неиндексированные файлы **рабочего дерева**.
- **`pack:check`:** байты **установленного** архива, компиляция потребителя; пути исследований отклоняются.
- Единственный шаблон переменных окружения — **пустой** `.env.example` (тоже проверяется на содержимое).
- Зависимости среды выполнения (Zod, Sharp и др.) в этой волне рефакторинга **не менялись**; необязательный ONNX — только явный путь фонового процесса.

Платные CLI каталога `benchmarks` не заменяют `npm test` / `npm run check`.

## Python, Windows и нативные предварительные условия

### `python-native` (вызывающий, изолированный офлайн Python)

Набор `npm run test:python-native` требует задать обе переменные окружения: `H10_PYTHON_EXECUTABLE` и `H11_PYTHON_EXECUTABLE`. Библиотека не устанавливает Python и не скачивает веса.

Проверенный прогон 44/44, 0 пропусков на ревизии `4877d05` использовал один изолированный интерпретатор CPU (без CUDA) для обеих переменных и следующий замороженный стек:

| Компонент    | Версия         |
| ------------ | -------------- |
| Python       | **3.12.3**     |
| NumPy        | **2.5.2**      |
| PyTorch      | **2.6.0+cpu**  |
| torchvision  | **0.21.0+cpu** |
| transformers | **4.57.3**     |
| Pillow       | **12.3.0**     |

Перед прогоном задайте `HF_HUB_OFFLINE=1` и `TRANSFORMERS_OFFLINE=1`. H10 CLIPSeg использует уже существующие закреплённые локальные файлы модели на стороне вызывающего и корень каталога по предварительным условиям тестов (не создаются репозиторием). В двух тестах H11 на CPU создаются фикстуры FakeTensor только с метаданными (в том числе синтетические метаданные CUDA-устройства для отдельных случаев валидации и загрузчика); проверяется логика валидации и загрузчика рабочего кода и негативные случаи. Такой офлайн-прогон не проверяет реальный CUDA, GPU, выделение физической видеопамяти или живой инференс модели H11.

Воспроизводимый рецепт для Linux, проверенный на этой платформе. В наборе `python-native` есть проверка завершения дочернего процесса при завершении родительского процесса на Linux; этот набор на Windows не проверялся. Без привязки к частному хосту: создать venv на Python 3.12.3, установить пакеты из таблицы с CPU-колёсами PyTorch/torchvision, задать корень локальных файлов модели H10 по каталогу тестов (например `H10_CLIPSEG_ASSETS`, если файлы не берутся из закреплённого контракта в репозитории), затем явно задать обе переменные и офлайн-флаги:

```bash
export H10_PYTHON_EXECUTABLE=/path/to/venv/bin/python
export H11_PYTHON_EXECUTABLE=/path/to/venv/bin/python
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
npm run test:python-native
```

Первый сбой офлайн-настройки сохранён как `python-native.log`; принятый прогон — `python-native-rerun.log` (каталог артефактов `zorya-classifier-completion-20261023`).

Контрольные тесты геометрии на Python (**6/6**, `controlled-oracles-current.log`) — **отдельно** от `python-native`.

### Windows (разработка и локальная матрица)

На свежей Windows Server 2025 для полного `npm run check` (этап Knip / native binding oxc-resolver 11.24.2) может понадобиться установленный на машине разработчика [Microsoft Visual C++ Redistributable для x64](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist/) — см. официальное руководство Microsoft. Репозиторий не ставит runtime автоматически и не менял зависимости; проверки установленного архива (`pack:check`) проходили и без этой установки. В одноразовой оценочной VM runtime ставился вручную с дистрибутива Microsoft (Authenticode OK); первая проба загрузки через Node `-e` с пустым stdout не принята, принята отдельная проверка загрузки модуля через CJS-файл с точным маркером stdout и exit 0 (`windows/vc-runtime-verified-smoke.json`).

Принятая локальная матрица (ревизия `4877d05`): Windows Server 2025 build 26100, Node 22.23.4 и 24.22.1 — все проверки с exit 0, 765/772 с 7 заранее существовавшими пропусками (POSIX FIFO, симлинк без привилегий, две маски H3b/H4e, два H6, один H8); байты архива совпадают с Linux. Удалённый GitHub Actions CI не запускался.

В WSL перед проверками проверьте `process.platform` и явные пути к `node`/`npm` ([контракт участников](https://github.com/zoomplus/zorya-classifier/blob/main/AGENTS.md)).

**Финальная верификация (волна 9):** полная матрица Linux + Windows + `python-native` на **`4877d05`** — [план рефакторинга](refactoring-plan.ru.md#волна-9--финальная-верификация-завершено). Исторический снимок только Linux на **`7a74226`** там же сохранён отдельно.

## Перед запросом на слияние

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix packages/mcp
npm run check
npm run pack:check
npm run mcp:check
npm run mcp:pack:check
npm run format:check
```

Платные прогоны каталога `benchmarks` в CI для запроса на слияние не обязательны.
