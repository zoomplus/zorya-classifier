# OpenRouter: выбор узла провайдера по скорости

Обычные OpenRouter-адаптеры для vision- и text-запросов принимают необязательное поле `providerSort`: `'latency'` или `'throughput'`. Оно задаёт OpenRouter предпочтительный порядок подходящих узлов провайдера (endpoint-ов): `latency` предпочитает меньшую задержку, `throughput` — большую пропускную способность. Это предпочтение маршрутизации, а не гарантия ускорения: фактическое время зависит также от сети, очереди, загрузки узла и вычисления модели.

`providerSort` не меняет модель. Поле `provider` остаётся явным. Базовый slug провайдера допускает стандартные подходящие узлы этого провайдера, которые OpenRouter может упорядочить. Если под заданными ограничениями остался один подходящий узел, сортировка может не повлиять на маршрут. Если владелец хочет выбрать конкретный доступный endpoint variant, его точный slug можно указать тем же полем `provider`; если имя провайдера в ответе отличается от ожидаемого, используйте существующее поле `providerName`. Доступность конкретных slug зависит от модели и текущего каталога OpenRouter.

Сортировка не включает priority tier и не добавляет новый тарифный режим. Чтобы использовать отдельный tier или региональный вариант, владелец должен явно выбрать доступный endpoint slug через `provider`. Стоимость и условия обработки такого варианта могут отличаться; проверьте их у OpenRouter до использования. Библиотека не выбирает tier или вариант за владельца и не меняет их автоматически.

Для каждого запроса библиотека сохраняет явную модель и ограничения `provider.only: [provider]`, `allow_fallbacks: false` и `require_parameters: true`. Клиент отправляет один HTTP-запрос и не переключает модель или провайдера при ошибке. OpenRouter сортирует только узлы, допустимые заданным `provider`. Если `providerSort` не указан, `provider.sort` полностью опускается из тела запроса, поэтому прежний JSON body и поведение остаются неизменными.

Параметр доступен только в `createOpenRouterVision` и `createOpenRouterText` для обычного chat-completions маршрута. Общие `createOpenAICompatibleVision` и `createOpenAICompatibleText` его не принимают; строгая схема отклоняет неизвестное поле. Native `createOpenRouterDecisions` и native Decisions-маршрут не меняются.

Пример использует значения окружения, заданные владельцем приложения. Перед запуском установите `OPENROUTER_API_KEY`, `ZORYA_MODEL` и `ZORYA_PROVIDER`. Ни модель, ни провайдер библиотекой не выбираются:

```ts
import { createClassifier } from 'zorya-classifier'
import { createOpenRouterVision } from 'zorya-classifier/openrouter'

const apiKey = process.env.OPENROUTER_API_KEY
const model = process.env.ZORYA_MODEL
const provider = process.env.ZORYA_PROVIDER
if (!apiKey || !model || !provider) {
  throw new Error('Set OPENROUTER_API_KEY, ZORYA_MODEL, and ZORYA_PROVIDER')
}

const client = createClassifier({
  decision: createOpenRouterVision({
    apiKey,
    model,
    provider,
    providerSort: 'latency', // Use 'throughput' to prefer throughput instead
  }),
})

try {
  const result = await client.classify({
    input: 'Where is my order?',
    classes: [
      { id: 'delivery', description: 'Delivery or tracking questions' },
      { id: 'other', description: 'All other requests' },
    ],
  })
  console.log(result.choice)
} finally {
  await client.dispose()
}
```

Для text-only запроса используйте `createOpenRouterText` с теми же настройками; он отклоняет части изображения. Без `providerSort` сохраняется прежнее тело запроса. Не выбирайте сортировку по предположению о качестве: она влияет только на предпочтение маршрута, а не на ответ модели.

**OpenRouter не ускоряет локальную native-генерацию H8a.** Он не запускает GroundingDINO, OmniParser или SAM2. В CPU-прогоне H8a p50 локальной генерации предложений и масок составила 18,1063 секунды на строку; это отдельная локальная стадия без VLM-решения. Время облачного model request и время локальной генерации масок нельзя приравнивать. `providerSort` не меняет сохранённые результаты Wave 1, маски, frozen quality-study route или выводы о качестве.

См. официальную документацию OpenRouter: [Provider Routing — Provider Selection](https://openrouter.ai/docs/guides/routing/provider-selection). В ней описаны `provider.sort` для `latency` и `throughput`, ограничение `only`, отключение fallback и сопоставление базового slug и точного endpoint-а.
