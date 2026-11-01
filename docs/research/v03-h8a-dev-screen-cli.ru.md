# Запуск этапов DEV H8a

`dev-screen-cli.ts` запускает один уже выбранный этап (`dev8`, `dev12` или `dev40`) за один вызов. Перед запуском он повторно проверяет сохранённый freeze, исходный код рабочего checkout, runtime receipt, веса, бинарные файлы Node/Python и архивный v0.2 control. Неполные DEV-входы отклоняются до чтения переменной ключа, блокировки кампании, открытия ledger или инициализации нативных runtime.

Один закреплённый campaign config задаёт общий корень и лимиты `$10 / 2000` физических вызовов. Команда `init` создаёт там ledger ровно один раз после полного подтверждённого freeze. Последующие `run` открывают только существующие marker и ledger, используют один `dev-screen-selection.json` для всего вложенного draw и держат отдельную блокировку корня до завершения `dispose()`. Удаление ledger или запуск с другим корнем не создаёт новую квоту незаметно. В campaign marker закреплены общие лимиты; отдельный `phase-bindings/dev40-binding.json` фиксирует authority и commitment именно DEV. Следующая фаза может получить собственную phase binding при том же campaign ledger.

## Предварительная проверка

Текущий authority содержит только 31 принятую строку, поэтому DEV40 ещё не заморожен. Проверка не запрашивает ключ и не запускает runtime. Для этого authority основным первым отказом нового CLI является устаревшая привязка `producer-code-closure-v2.json` к предыдущей версии `dev-freeze-assembly.ts`; обновлённый кодовый closure и authority должны быть выпущены после интеграции драйвера. С актуальным closure та же проверка должна пройти все 31 source bytes и вернуть отказ по девяти незаполненным map slots. Ни один из этих вариантов не создаёт run root, ledger или native runtime.

Проверка выполняется из того checkout, который будет исполнять frozen producer. Параметр `--source-root` должен указывать на checkout самого CLI; подставлять отдельный каталог с подходящими файлами нельзя. CLI также требует, чтобы проверенный closure включал байты самого драйвера, `runtime-ports.ts`, `campaign-ledger.ts` и все ключевые загрузчики DEV runner. Runtime proof закреплён SHA-256 `5a75be16864e3b9560aa21ca79511f74bccf10360804e539040ae8751e402697`, campaign config — `12da3eb42a9f8dae52ff678241686af2775c0592539827df6801996ed48ee076`.

## Создание общей кампании

После появления полного принятого DEV40, обновлённого authority и сохранённого freeze основной orchestrator запускает однократную инициализацию:

```sh
node --import tsx benchmarks/v03/h8a-fresh-comparison/dev-screen-cli.ts init \
  --authority <полный-authority.json> \
  --authority-sha256 <закреплённый-main-SHA256> \
  --freeze-dir <проверенный-freeze-каталог> \
  --source-root '<checkout-который-исполняет-этот-CLI>' \
  --runtime-files /root/.codex/artifacts/zorya-classifier-mcp-20261101/main-dev-prerequisites-v1/checked-runtime-files-v1.json \
  --runtime-files-sha256 5a75be16864e3b9560aa21ca79511f74bccf10360804e539040ae8751e402697 \
  --campaign-config /root/.codex/artifacts/zorya-classifier-mcp-20261101/main-dev-prerequisites-v1/shared-campaign-config-v1.json \
  --campaign-config-sha256 12da3eb42a9f8dae52ff678241686af2775c0592539827df6801996ed48ee076 \
  --run-root /root/.codex/artifacts/zorya-classifier-mcp-20261101/h8a-fresh-dev-qual-campaign-v1
```

Этот корень сейчас не инициализирован; команда выше описывает контракт и не является подтверждением готовности DEV40. После успешного `init` marker и общий ledger нельзя переносить или пересоздавать для следующего этапа.

## Один этап за вызов

`OPENROUTER_API_KEY` читается только после проверки freeze, runtime и campaign root. Значение ключа не выводится и не сохраняется в artifact. Этапы `dev12` и `dev40` требуют предыдущий screen report и отдельное решение `advance`, созданное через существующую `sealDevScreenReview`; CLI не принимает решение за проверяющего.

```sh
node --import tsx benchmarks/v03/h8a-fresh-comparison/dev-screen-cli.ts run \
  --authority <тот-же-полный-authority.json> \
  --authority-sha256 <тот-же-закреплённый-main-SHA256> \
  --freeze-dir <тот-же-freeze-каталог> \
  --source-root '<тот-же-checkout-который-исполняет-этот-CLI>' \
  --runtime-files /root/.codex/artifacts/zorya-classifier-mcp-20261101/main-dev-prerequisites-v1/checked-runtime-files-v1.json \
  --runtime-files-sha256 5a75be16864e3b9560aa21ca79511f74bccf10360804e539040ae8751e402697 \
  --campaign-config /root/.codex/artifacts/zorya-classifier-mcp-20261101/main-dev-prerequisites-v1/shared-campaign-config-v1.json \
  --campaign-config-sha256 12da3eb42a9f8dae52ff678241686af2775c0592539827df6801996ed48ee076 \
  --run-root /root/.codex/artifacts/zorya-classifier-mcp-20261101/h8a-fresh-dev-qual-campaign-v1 \
  --screen dev8 \
  --api-key-env OPENROUTER_API_KEY
```

Для `dev12` или `dev40` меняется только `--screen`; для каждого вызова остаются прежними authority, freeze, campaign config и `run-root`. Встроенные профили сохраняют candidate `240 s / 4 calls`, control `120 s / 6 calls`, native limits и текущий порядок без tier/sort. Никакой offline fixture, альтернативный профиль, retry или fallback через этот CLI выбрать нельзя.

Сохранённый отчёт показывает статус единственного этапа; неполный этап или hard blocker завершают CLI с ошибкой после сохранения отчёта. Решение о переходе остаётся отдельной проверкой `sealDevScreenReview`. `init` и `run` не являются разрешением продолжать на QUAL или менять frozen recipe.
