# Tested models and results

## Historical 0.1 classification comparison

The routes in this report are explicit benchmark configurations, not library defaults. The caller selects and connects every model through an injected `DecisionPort` or an adapter they configure. **Luna Decisions was the selected 0.1 classification recipe:** it matched the historical photo/text counts on this corpus, while ordinary vision chat models remain configurable alternatives. This is an observed result on a small public corpus, not a statistical non-inferiority or universal-accuracy guarantee.

These classification results do not qualify the new 0.2 whole-object or extraction workflows. Their [current acceptance state](acceptance.md) records the failed first blind localization run and the remaining checks independently.

The fixed corpus has60 licensed photos (20 development/40 heldout) and30 authored text fixtures (10/20). Ground truth never enters model requests. Errors stay in the accuracy denominator; unstarted cases remain unverified. Public images may overlap model training. Exact [summaries/source pins](evidence/vision-model-summary.json) and individual run reports below retain failures.

| Model / route                            | API                       | Photos | Heldout photos | Texts | Protocol/provider errors |
| ---------------------------------------- | ------------------------- | ------ | -------------- | ----- | ------------------------ |
| `openai/gpt-6-luna-decisions · openai`   | Decisions                 | 55/60  | 39/40          | 30/30 | 0                        |
| `openai/gpt-6-luna · openai`             | Chat                      | 54/60  | 38/40          | 30/30 | 1                        |
| `qwen/qwen3.7-flash · alibaba`           | Chat                      | 53/60  | 37/40          | 26/30 | 3                        |
| `anthropic/claude-haiku-5.5 · anthropic` | Chat, stopped photo batch | 11/16  | 0/0            | 29/30 | 3                        |
| `nex-agi/nex-n2.5-mini · nex-agi/bf16`   | Chat screening            | 6/10   | 0/0            | 0/0   | 0                        |

The legacy Jev result was55/60 photos,37/40 heldout and30/30 texts; it remains in the [historical report](results.md). Jev is excluded from the new recommendation by owner preference. Luna Decisions produced55/60,39/40 heldout and30/30 texts with zero classification protocol/provider errors. Among the fully tested non-Jev routes, it alone met the recorded photo/text target. Lower-cost Qwen did not retain that accuracy; Nex received only a10-photo development screen. Haiku stopped its photo batch after two consecutive errors, leaving44 photos unverified.

## Latency and reported cost

End-to-end per-operation latency includes preparation, network and provider processing. Quantiles use nearest rank, include failed attempts and describe this one run; they are not a service SLA. Cost below covers validated classification metadata only, with rejected-response billing reconciliation described separately.

| Route          | Photo p50 / p95 | Text p50 / p95 | Known classification cost |
| -------------- | --------------- | -------------- | ------------------------- |
| luna-decisions | 1.43s / 3.44s   | 0.22s / 0.41s  | $0.00793950               |
| luna           | 3.20s / 4.79s   | 0.96s / 1.26s  | $0.01314735               |
| qwen           | 3.94s / 5.32s   | 1.10s / 1.25s  | $0.00330488               |
| haiku          | 3.09s / 4.19s   | 0.76s / 1.00s  | $0.00719360               |
| nex            | 1.60s / 3.90s   | — / —          | $0.00030315               |

The [Luna Decisions catalog](https://openrouter.ai/openai/gpt-6-luna-decisions) listed$0.10/M input tokens and free output on2026-10-18. Exact route receipts take precedence over a catalog floor. The90 native classification calls reported$0.00793950 total. Do not infer this price for a different image size, route, provider or future date.

## Protocol variants and failures

The first chat comparison requested two/four ranked IDs even for single-label classification. Qwen returned only one ID on three photos and failed that old contract; those failures remain failures. The revised adapter requests exactly one classification/final ID and four only for spatial beam stages. Haiku used this revised protocol and had one authentication/provider rejection and two non-JSON answers. These are different protocol snapshots and not a controlled paired prompt experiment. Luna Decisions uses actual typed Choice probabilities and Noul; it never parses a generated chat ranking and does not inherit Jev-specific rounding.

Native Luna was evaluated in two disjoint sessions:40 heldout photos+10 development texts, then the missing20 development photos+20 heldout texts. No classification was replayed, relabeled or prompt-tuned between them. The inference source is unchanged across those sessions; their manifests pin it. The mutable budget initialization was refactored after the second snapshot to satisfy the race lint rule, without changing inference.

[Chat v1](evidence/vision-selection-v1-report.json) · [Chat v2](evidence/vision-selection-v2-report.json) · [Native first session](evidence/decisions-selection-v1-report.json) · [Native completion](evidence/decisions-completion-v1-report.json).

## Localization remains experimental

The first native locator smoke reached its fine stage but received a provider error. An explicit diagnostic replay of that exact195-option/nine-image fine request returned HTTP502: `OpenAI refused to answer question "selection"`. The [diagnostic receipt](evidence/luna-decisions-fine-probe.json) is preserved. This does not establish a documented universal option/image limit or authorize silently changing geometry; model refusal stays an error. A subsequent fixed flower-image smoke completed all three native stages in4.75s and returned a region; its [report](evidence/luna-decisions-locator-smoke-report.json) includes the reference-box metric. This one success does not erase the failed request or qualify the whole locator corpus. A valid classification result does not guarantee locator compatibility.

The grid pipeline returns a hypothesized region, never a segmentation mask, tight box or object center. No map/minimap, universal localization or sub-second claim is made. Offline three-stage fixtures verify geometry/lifecycle only.

## Model and provider choice

The core depends only on `DecisionPort`. Use `createOpenRouterDecisions` for compatible typed native models, `createOpenRouterVision` for ordinary vision chat, or `createOpenAICompatibleVision` for trusted direct providers/local servers. Another native wire protocol can implement the public port. No adapter automatically changes the model/provider/protocol. These live results used OpenRouter as transport; a real local HTTP fixture separately verified direct chat protocol without a key or router fields, not a local model's factual accuracy.

A model must support its chosen API and modalities, follow the requested closed task and satisfy response validation. `classify` uses at most one image; `locate` needs up to nine. Untested models are configurable, not automatically qualified.

The completed comparison used332 requests against the expanded1000-call ceiling. Reported known cost is$0.03456876; four calls retain unknown costs. With$0.05 reservations each, accounted exposure is$0.23456876 within the$0.50 admission cap. The five rejected-chat receipts were reconciled for billing only; no accuracy failures were repaired. This accounting is separate from the historical Jev benchmark and is not an account invoice.
