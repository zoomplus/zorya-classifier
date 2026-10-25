# Удаление публичного селектора IMAGE-AS-TEXT

Публичный runtime больше не принимает `representation: { type: 'experimental-text', profile: 'text-image-v1' }`. Любая попытка передать этот селектор (или неизвестные ключи в `representation`) завершается `ClassifierError` с кодом `INVALID_INPUT` **до** вызова `DecisionPort` или сетевого fetch.

Обычная **текстовая** классификация (`classify` со строкой или `{ text }`) и **vision**-адаптеры/запросы без экспериментального селектора не изменились.

Исследовательские text-image кодеки остаются только в `benchmarks/experiments/` и не входят в npm `dist`. Они не ожидают публичной квалификации; исторические замеры v0.2/v0.3 и отчёты сохранены без переклассификации.

Для офлайн-бенчмарков используйте `createResearchClassifier` с явным research-портом и benchmark-only схемами (`researchRepresentationSchema`).
