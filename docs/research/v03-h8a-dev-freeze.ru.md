# Офлайн-сборка DEV40 для H8a

## Назначение и границы

`benchmarks/v03/h8a-fresh-comparison/dev-freeze-cli.ts` собирает замороженный DEV40 только после проверки полного набора исходных данных и независимых доказательств допуска. Команда не запускает профили, не вызывает модельные или иные сетевые сервисы и не загружает runtime-активы. Ground truth остаётся в отдельном файле evaluator annotations и не добавляется в producer-строки.

Источники, маски, review receipts, roster, commitments, ценовое доказательство и кодовый closure остаются во внешнем artifact-хранилище. В репозитории находятся только код инструмента, его тест и это описание.

## Что проверяется

- Внешний preparation authority и каждый указанный в нём артефакт сверяются с отдельно закреплённым SHA-256. Пересчитываются байты файлов, JSON identities сохраняют исходный порядок ключей, а пути не могут выходить из доверенного корня или проходить через symlink.
- Для каждого review fragment множества и порядок opaque ID в producer rows, annotations и review должны совпадать. Строка должна иметь `accepted: true`, принятую квитанцию, совпадающие исходные хеши и provenance. Отдельно перепроверяются реальные source bytes, canvas, EXIF orientation и packed reference masks.
- Кодовый closure повторно проверяется по SHA-256 каждого файла относительно явно заданного checkout. Профильные policy и recipe identities строятся из текущих профилей и повторно сверяются с их контрактами.
- Зарегистрированный протокол подтверждает hash-order всех сорока opaque ID и чередование candidate/control по рангу внутри страты. Map roster проверяется по исходному протоколу, seed и формуле ID; его десять зарегистрированных слотов должны иметь десять принятых исходников.
- Поле `maxNativeWorkerThreads` фиксирует фазовый верхний предел по обоим профилям: candidate Torch использует до 8 intra-op потоков, control MobileSAM — 2 CPU потока. Число активных нативных рук ограничено одной; `maxPendingNativeJobs` — 2. Эти лимиты не означают одновременный запуск двух профилей.
- Source-group commitment использует отсортированный набор уникальных ID после той же нормализации, что и curator: удаляются завершающие `/`. Исходные строки групп и их порядок при этом сохраняются в annotations. DEV, открытая qualification-часть и исключения проверяются на пересечение.
- Public price proof сверяется с сохранёнными endpoint JSON для точной модели и маршрута `openai` или `openai/*`. Проверяются prompt, completion, cache read/write, overrides, доступный контекст, максимальный input envelope, лимит вывода рецепта и арифметика резерва. Положительные неподдерживаемые fees приводят к отказу.
- Только после проверки 40 строк строятся `PhaseFreeze`, приватные annotations и nested DEV8/DEV12 selection через существующую процедуру выборки. Результаты повторно проходят схемы и deterministic draw validation.

Сборка отказывает, если отсутствует хотя бы одна из сорока строк, не сходятся квоты photo 16/4, UI 7/3, map 7/3, есть ошибка hash/dimension/commitment или не выполнено ценовое доказательство. Байты каждого уже проверенного исходника должны быть уникальны; полный набор дополнительно должен содержать ровно сорок строк. Успешная запись атомарно публикует каталог только если его ещё нет; freeze и draw нельзя перезаписать. Команда `verify` заново собирает ожидаемый результат из тех же входов и сверяет с сохранёнными файлами.

## Текущие входы и результат проверки

Закреплённый main authority `/root/.codex/artifacts/zorya-classifier-mcp-20261101/main-dev-prerequisites-v1/partial-dev30-authority-v2.json` (SHA-256 `8d131209861c4d15ac0e82585ffc327c19afdf9078e1ff5d1ca04edd9a35ad8f`) связывает кодовый closure, runtime preflight, order protocol, map roster, split/exclusion commitments, ценовое доказательство и reviewed fragments. Исходный fragment содержит 30 принятых записей: photo 16/4 и UI 7/3. CLI проверил их реальные source bytes, canvas, все 16 packed masks, provenance и receipts.

Дополнительный map order roster закрепляет десять opaque ID для Crimson и перенесённого FreeCol. Это регистрация слотов, а не доказательство принятого кадра. При запуске с authority v2 и 30 reviewed rows проверка подтвердила 30 разных source byte digests, прошла source, runtime, policy и price gates, затем отказала без записи freeze/draw: `DEV40 incomplete: 10 registered map rows are missing (accepted 0/10)`. Отдельный authority v2 включает один дополнительно принятый отрицательный FreeCol case; все 31 исходных byte digests различны, результат — `DEV40 incomplete: 9 registered map rows are missing (accepted 1/10)`. Квота map 7/3 не заполнена. Qualification source groups ещё не открыты, поэтому текущие exclusions ничего не доказывают о составе будущей qualification-корзины. Никакие строки не дополнялись синтетическими данными.

Квитанция повторной проверки обеих authority и входных commitments находится во внешнем artifact-хранилище: `/root/.codex/artifacts/zorya-classifier-mcp-20261101/dev-assembly-v1/partial-dev30-dev31-refusal-evidence-v3.json`, SHA-256 `76a8181181732f42de4dc429451d233b078f3a9e19bf82324f306e273fc3602f`. Она фиксирует проверенное число строк, уникальные source digests и оба review manifest для DEV31. Ни один freeze/draw или staging/lock каталог не публиковался; provider calls — 0.

## Запуск

Команда сборки требует внешний authority JSON, его независимо полученный SHA-256, checkout с кодовым closure и новый путь для output. Повторное использование существующего output запрещено:

```sh
node --import tsx benchmarks/v03/h8a-fresh-comparison/dev-freeze-cli.ts assemble \
  --authority <путь к полному main preparation authority> \
  --authority-sha256 <SHA-256 этого authority, переданный main отдельно> \
  --source-root '/root/projects/Zorya/Zorya Classifier' \
  --output-dir /root/.codex/artifacts/zorya-classifier-mcp-20261101/dev-assembly-v1/dev40-freeze-v1
```

С текущим partial authority команда намеренно не создаёт каталог DEV40. Для будущего запуска сначала нужны десять полностью принятых map admissions, обновлённые per-fragment reviews и новый закреплённый authority; пересобирать freeze по map roster без них нельзя. После успешной сборки сохранённый каталог можно перепроверить той же парой authority и SHA:

```sh
node --import tsx benchmarks/v03/h8a-fresh-comparison/dev-freeze-cli.ts verify \
  --authority <путь к тому же main preparation authority> \
  --authority-sha256 <тот же отдельно закреплённый SHA-256> \
  --source-root '/root/projects/Zorya/Zorya Classifier' \
  --output-dir /root/.codex/artifacts/zorya-classifier-mcp-20261101/dev-assembly-v1/dev40-freeze-v1
```

Эти команды только проверяют и собирают offline freeze. Ни `assemble`, ни `verify` не являются разрешением запускать профили на DEV40.
