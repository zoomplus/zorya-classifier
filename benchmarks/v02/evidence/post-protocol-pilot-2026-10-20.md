# Post-protocol diagnostic

This is an exposed-development protocol diagnostic, not candidate qualification or a latency ranking. It ran with `grammar-plus-examples` and the `concurrent-native` timing tag. The two source cases are existing exposed development inputs; the report omits their identifiers, private fixture paths, prompt/output text, and ground truth.

The Luna control now calls OpenRouter Decisions (`/api/alpha/decisions`) with the pinned OpenAI route. Together text requests use OpenRouter Chat Completions (`/api/v1/chat/completions`) with the pinned DeepSeek Flash/Together route. There is no fallback or retry.

| Route                            | Physical fetches | HTTP result      | Content-free response disposition                                                                               |
| -------------------------------- | ---------------: | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| DeepSeek V4.1 Flash via Together |               20 | 20 × 200         | 15 invalid-JSON responses with `finish_reason=length`; 5 `chat-json-object` responses with `finish_reason=stop` |
| GPT-6 Luna Decisions via OpenAI  |                9 | 8 × 200, 1 × 502 | 8 typed Decisions responses; 1 error envelope                                                                   |

The Together total includes 16 image-encoding requests and 4 no-image controls. The Luna total includes classification and multi-step localization decisions. The runner made 29 actual HTTP fetches. Four classification stages stopped at local representation limits, and four localization stages returned `representation-limit`; none dispatched a request. All but one fetch reported known usage cost, totaling $0.074137344. The Luna 502 lacked a usage receipt, so one $0.02 unknown-cost reserve remains: accounted exposure was $0.094137344 under the run's $2.50 cap.

The run ended complete with 16 logical candidate results. The 15 Together responses with `finish_reason=length` were incomplete generations, not completed malformed answers. This run does not support a text-encoder accuracy or latency ranking. Luna's ordinary typed classification succeeded; its one 502 and remaining localization outcomes stay in the evidence denominator.

The immutable local run directory is `.run/v02/v02-diagnostic-2026-10-20T081242779Z-fe22acdd/` and is not included in source control. Evidence hashes:

- Run manifest: `328cf80b59bc842050a05ea5e3b4289be584a6e32d40ab989dcb6b07396bc08c`
- Run summary: `b6a5efc70f313086b2c022c9296f3028bba444200e2f1931feb4b3b90688e98c`
- Producer input manifest: `d2a3ab497a9cff07e0199a7be9e8e91c844e2efc773cd3335bc248c334a6e7a9`
- Prompt variant: `grammar-plus-examples`, SHA-256 `e442e9dc2bb920db4bf91b11e6b1e7f507f78f3a778af19fcdb79e98eb87cf5d`

Current route documentation: [OpenRouter DeepSeek V4.1 Flash](https://openrouter.ai/deepseek/deepseek-v4.1-flash), [OpenRouter chat completion reference](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion), and [OpenRouter GPT-6 Luna Decisions](https://openrouter.ai/openai/gpt-6-luna-decisions/providers).
