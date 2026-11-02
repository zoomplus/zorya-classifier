# zorya-classifier-mcp

Отдельный MCP-сервер версии `0.2.0` для опубликованной библиотеки `zorya-classifier@0.2.3`. Сервер не выбирает модель, provider или локальные веса и не скачивает их. Для каждого запуска оператор явно задаёт профиль, модель, provider (если он нужен адаптеру) и секрет через окружение или, только в OIDC-режиме, защищённый BYOK flow.

Требуется Node.js `22.12.0` или новее. Сервер поддерживает локальный stdio и два явных HTTP-режима: OIDC с Streamable HTTP, legacy SSE, viewer и BYOK; либо Streamable HTTP с IP allowlist и краткоживущими capability-сессиями без OAuth-входа.

## Установка

Установите отдельный пакет из npm:

```sh
npm install --global zorya-classifier-mcp@0.2.0
```

## ChatGPT с IP allowlist и без OAuth-входа

Режим `http.accessMode: "ip"` предназначен для MCP-клиентов, которые не передают собственные HTTP-заголовки или API-ключи. В веб-версии ChatGPT откройте **Plugins → + → Add custom MCP server**, задайте **Server URL**, выберите **No authentication**, нажмите **Create as plugin**, затем установите личный plugin. Этот порядок соответствует [официальной инструкции OpenAI](https://developers.openai.com/api/docs/guides/custom-mcp-server). Программная проверка MCP-клиента не подтверждает доступность UI или connector в каждом аккаунте ChatGPT.

Для текущего deployment целевой адрес — `https://startzorya.com/mcp/classifier`. Используйте его только после отдельной проверки production HTTPS-маршрута; наличие адреса в документации само по себе не подтверждает публикацию сервера.

IP allowlist разрешает сетевой диапазон и не устанавливает личность пользователя: пользователи ChatGPT могут выходить через общие адреса. Поэтому каждый клиент сначала вызывает `zorya_open_session`, затем сохраняет полученный `sessionToken` приватно и передаёт его в каждом из шести `zorya_*` инструментов, `zorya_read_artifact` и при опросе задания. Этот случайный capability token ограничивает доступ к заданиям и файлам одной сессией; он не передаётся в URL или HTTP-заголовках. Откройте отдельную сессию на отдельный разговор и не публикуйте её токен.

Пример конфигурации ниже показывает форму, но `203.0.113.8/32` — зарезервированный документационный адрес, а не рабочий диапазон. Перед запуском замените его точными официальными CIDR-диапазонами ChatGPT, проверенными для вашего deployment. `allowedHosts` должен точно совпадать с HTTP `Host`, включая порт, если клиент его передаёт. Заголовок `x-real-ip` доверяется только от socket peer, входящего в `trustedProxyCidrs`; дубликаты и forwarding headers отклоняются. CIDR `/0`, wildcard-hosts и локальные файлы не разрешены.

```json
{
  "transport": "http",
  "core": {
    "profiles": {
      "luna": {
        "id": "luna",
        "adapter": "openrouter-vision",
        "credentialMode": "service",
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "model": "openai/gpt-6-luna",
        "provider": "openai"
      }
    },
    "defaultProfileId": "luna"
  },
  "http": {
    "accessMode": "ip",
    "bindHost": "127.0.0.1",
    "port": 18783,
    "mcpPath": "/mcp",
    "allowedCidrs": ["203.0.113.8/32"],
    "trustedProxyCidrs": ["127.0.0.1/32"],
    "allowedHosts": ["mcp.example.net"],
    "allowedOrigins": [],
    "maxSessions": 10000,
    "sessionTtlMs": 14400000,
    "maxJobsPerSessionPerDay": 20,
    "maxJobsPerDay": 2000,
    "maxRequestsPerMinute": 60,
    "maxConcurrentRequests": 32,
    "maxRequestBodyBytes": 32000000,
    "requestTimeoutMs": 30000
  },
  "remoteImageHosts": []
}
```

Задайте `ZORYA_MCP_CONFIG` путём к JSON вне репозитория. `OPENROUTER_API_KEY` передайте только в окружении процесса через менеджер секретов; ключ не записывайте в JSON или настройки connector. В конфигурации нужны только `service` или явные keyless-профили; `byok`, browser login, PKCE, HTTP uploads и viewer в IP-режиме отключены. Для изображений через URL добавьте только проверенные hostname в `remoteImageHosts`. Модель и provider задаются явно; профиль по умолчанию не означает автоматический fallback.

Сессии, задания и лимиты IP-режима хранятся в памяти одного процесса. По умолчанию capability-сессия истекает через 4 часа; лимиты 20 отправок на сессию в сутки и 2000 отправок глобально в сутки ограничивают количество заданий, но не являются бюджетом стоимости. После перезапуска сессии и задания теряются. Токены сессий хранятся на сервере только в виде SHA-256 хэшей.

## Явная конфигурация stdio

Проверьте, что каталог global npm binaries доступен в `PATH` процесса MCP-клиента; при необходимости укажите полный путь к `zorya-classifier-mcp`.

Создайте JSON-конфигурацию вне репозитория. Укажите `ZORYA_MCP_CONFIG` в окружении MCP-клиента; секреты не помещайте в аргументы запуска, tool inputs, URL или файл конфигурации. Ниже приведён пример явного сетевого профиля. Названия модели и provider — только примеры: замените их на значения, поддерживаемые вашим аккаунтом.

```json
{
  "transport": "stdio",
  "core": {
    "profiles": {
      "vision": {
        "id": "vision",
        "adapter": "openrouter-vision",
        "credentialMode": "service",
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "model": "openai/gpt-4o-mini",
        "provider": "openai"
      }
    },
    "defaultProfileId": "vision",
    "stdio": {
      "inputRoot": "/srv/zorya/images"
    }
  },
  "credentialVault": { "mode": "memory-only" },
  "remoteImageHosts": []
}
```

Задайте переменные окружения MCP-клиента:

```json
{
  "mcpServers": {
    "zorya": {
      "command": "zorya-classifier-mcp",
      "env": {
        "ZORYA_MCP_CONFIG": "/absolute/path/to/zorya-mcp.json"
      }
    }
  }
}
```

Сервисные ключи задавайте в окружении процесса через менеджер секретов ОС, не в JSON конфигурации или настройках MCP-клиента.

MCP `stdio` резервирует stdout под протокол; диагностические сообщения идут в stderr. Локальные пути разрешены только внутри явно заданного `core.stdio.inputRoot`. URL-картинки по умолчанию запрещены: добавляйте конкретные доверенные hostname в `remoteImageHosts`, если этот способ ввода нужен.

Доступны инструменты `zorya_classify`, `zorya_locate`, `zorya_extract`, `zorya_get_job`, `zorya_cancel_job` и `zorya_capabilities`. Классификация принимает закрытые идентификаторы классов. Ранжированные ответы не преобразуются в вероятности. Геометрия грубой области или bbox не выдаётся за маску. Extraction требует явно заданных локальных ресурсов сегментатора и не устанавливает их автоматически.

## Удалённый HTTP

Для удалённого клиента задайте `transport: "http"`, тот же объект `core`, явные настройки `http` и настройки OIDC. HTTP endpoint следует публиковать только через HTTPS reverse proxy с проверкой Host и точным списком Origin. OIDC issuer должен быть настроен оператором. MCP access token и ключ provider — разные секреты.

```json
{
  "transport": "http",
  "core": {
    "profiles": {
      "vision": {
        "id": "vision",
        "adapter": "openrouter-vision",
        "credentialMode": "byok",
        "model": "openai/gpt-4o-mini",
        "provider": "openai"
      }
    },
    "defaultProfileId": "vision"
  },
  "credentialVault": {
    "mode": "encrypted-file",
    "filePath": "/var/lib/zorya/credentials.enc",
    "keyEnv": "ZORYA_VAULT_KEY"
  },
  "remoteImageHosts": ["images.example.net"],
  "browserLogin": {
    "clientId": "zorya-mcp-client",
    "scopes": ["profile", "mcp:invoke"]
  },
  "openRouterPkceProfileId": "vision",
  "http": {
    "bindHost": "127.0.0.1",
    "port": 8787,
    "publicOrigin": "https://mcp.example.net",
    "resourceUrl": "https://mcp.example.net/mcp",
    "resourceMetadataUrl": "https://mcp.example.net/.well-known/oauth-protected-resource/mcp",
    "issuer": "https://identity.example.net/",
    "audience": "https://mcp.example.net/mcp",
    "requiredScopes": ["mcp:invoke"],
    "allowedHosts": ["mcp.example.net"],
    "allowedOrigins": ["https://mcp.example.net", "https://client.example.net"],
    "credentialProfileIds": ["vision"]
  }
}
```

Передайте конфигурацию путём `ZORYA_MCP_CONFIG`. `resourceMetadataUrl` должен указывать на метаданные, которые встроенный сервер отдаёт по пути, вычисленному из `resourceUrl`. Если включён `browserLogin`, `allowedOrigins` должен содержать собственный origin сервера: форма BYOK отправляет same-origin POST с CSRF токеном. На POSIX для `encrypted-file` задайте `ZORYA_VAULT_KEY` как canonical Base64 ровно 32 байт, используя имя из `keyEnv`; каталог и файл хранилища должны быть доступны только владельцу процесса. Этот режим проверяет POSIX-права файла и каталога и на Windows завершается типизированной ошибкой `UNSUPPORTED_OPERATION`. На Windows явно выберите `memory-only`; BYOK ключи тогда теряются при остановке. Ключ не передаётся в аргументах или JSON. OpenRouter PKCE подключает provider credential отдельно от OIDC bearer token. Если PKCE не нужен, удалите `openRouterPkceProfileId`.

Для browser login CLI запрашивает объединение `browserLogin.scopes` и `http.requiredScopes`, убирая повторы; scope `openid` браузерный сервис добавляет сам. В примере `mcp:invoke` задан как разрешение ресурса и включён в authorization request.

Для удалённого клиента используйте собственный HTTPS hostname, reverse proxy, OIDC issuer и адрес MCP из `resourceUrl`. После OAuth авторизации provider credential подключается отдельно через OpenRouter PKCE. Настройки endpoint, OIDC и proxy принадлежат оператору сервера; доступность интерфейса или production-функций в конкретном аккаунте ChatGPT проверяется отдельно.

Поддерживаются URL, inline base64 и HTTP uploads в пределах лимитов конфигурации. URL принимается только с явно перечисленных hostname; проверяются публичный DNS адрес и редиректы. Upload, исходные изображения, маски, cutout и результаты заданий хранятся только в памяти процесса и удаляются по TTL или при остановке. После перезапуска активные задания и файлы не восстанавливаются. BYOK сохраняется после перезапуска только в режиме `encrypted-file`; при `memory-only` ключи теряются при остановке.

`zorya_extract` и whole-object `zorya_locate` требуют настроенный caller-owned сегментатор. Конфигурация `core.segmentation` указывает локальные пути к runtime assets. Установите runtime и предоставьте файлы самостоятельно; пакет не загружает веса. Обычная vision-модель не требует native classifier API. Для интеграции с уже созданным `DecisionPort` используйте programmatic API.

Для extraction создайте отдельный локальный runtime-проект. Добавьте `segmentation` в объект `core`, укажите локальные файлы encoder/decoder и установите optional runtime в этот же проект:

```json
{
  "core": {
    "segmentation": {
      "kind": "mobile-sam",
      "encoderPath": "/srv/zorya/models/encoder.onnx",
      "decoderPath": "/srv/zorya/models/decoder.onnx",
      "executionProvider": "cpu",
      "threads": 2
    }
  }
}
```

```sh
mkdir -p /srv/zorya/mcp-runtime
cd /srv/zorya/mcp-runtime
npm init -y
npm install zorya-classifier-mcp@0.2.0 onnxruntime-node@1.23.2
```

В stdio-конфигурации MCP-клиента для такого локального проекта задайте `command: "/usr/bin/node"` и `args: ["/srv/zorya/mcp-runtime/node_modules/zorya-classifier-mcp/dist/cli.js"]`; переменную `ZORYA_MCP_CONFIG` передайте в окружении процесса.

Получите и проверьте веса самостоятельно по [инструкции опубликованной библиотеки v0.2.3](https://github.com/zoomplus/zorya-classifier/blob/v0.2.3/docs/v02-usage.md#extract-with-an-explicit-local-backend) и [манифесту размеров и SHA-256](https://github.com/zoomplus/zorya-classifier/blob/v0.2.3/docs/evidence/v02/segmentation/README.md). Для GrabCut вместо encoder/decoder задайте `{"kind":"grabcut","assetPath":"/srv/zorya/models/opencv.js"}`; этот вариант не требует ONNX Runtime и использует отдельно полученный OpenCV 4.13.0 asset. Ни runtime, ни веса не скачиваются MCP пакетом.

Viewer показывает ограниченное представление результата и файлов с проверкой владельца; он не является встроенным интерфейсом ChatGPT. Наличие MCP endpoint или успешная проверка SDK не доказывают включение production deployment либо пользовательского UI в конкретном аккаунте ChatGPT — эти проверки выполняются отдельно.

## Docker

Соберите образ из каталога пакета и передайте конфигурацию снаружи контейнера:

```sh
docker build -t zorya-classifier-mcp:0.2.0 .
docker run --rm \
  --publish 127.0.0.1:8787:8787 \
  --mount type=bind,src=/srv/zorya/config.json,dst=/run/zorya/config.json,readonly \
  --mount type=bind,src=/srv/zorya/state,dst=/var/lib/zorya \
  --env ZORYA_MCP_CONFIG=/run/zorya/config.json \
  --env ZORYA_VAULT_KEY \
  zorya-classifier-mcp:0.2.0
```

Образ запускается от непривилегированного пользователя. Конфигурация, ключи, изображения и веса не включаются в build context или образ. В production используйте secret manager для окружения и HTTPS reverse proxy; не публикуйте незашифрованный HTTP порт напрямую в сеть.

В Docker укажите `http.bindHost: "0.0.0.0"` внутри контейнера, чтобы reverse proxy мог подключиться к опубликованному порту. Привязка хоста в примере выше оставляет порт доступным только на loopback хоста.
