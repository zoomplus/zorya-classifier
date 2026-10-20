# Reasoning-effort transport probe

This one-call request checks the named `none-json-schema` transport variant on an already exposed development photo. It is protocol evidence only; its classification result is not quality evidence or a qualification attempt.

The request used model `deepseek/deepseek-v4.1-flash`, pinned provider `together`, OpenRouter Chat Completions (`/api/v1/chat/completions`), `reasoning: { effort: "none" }`, `max_tokens: 1024`, `stream: false`, and strict JSON Schema response format. The prompt remained `grammar-plus-examples`. It made exactly one physical request, with no retry or fallback.

The response was HTTP 200 from Together, returned the pinned model, produced a JSON object with `finish_reason=stop`, and reported cost $0.0008247. The local stage returned `absent`. Since this is one exposed development example, it cannot establish classification quality or prove that reasoning effort caused the earlier truncated outputs. It does show that this pinned route accepted `reasoning.effort=none` and completed a structured response under the same 1,024-token ceiling.

The immutable run directory is `.run/v02/v02-transport-probe-2026-10-20T082537333Z-4f7a9b59/` and is not included in source control. Evidence hashes:

- Run manifest: `f2124521535720ddc0a25bf9d2122ea000e36968238ed8ccfad66a68b7878a7c`
- Run summary: `11ec5a768aa37f60f1163fe887273e540ec89acf54406898641ffff1f5b0d885`
- Request-body hash: `ab1274034da9392f10da370dac989e68b463f524ae2fb18fc3a098a3712ac24b`
- Transport variant: `none-json-schema`, SHA-256 `e9d94773b78e697584eb819ef31d400759435e56d1bf26221007e2225d820e0f`
- Prompt variant: `grammar-plus-examples`, SHA-256 `e442e9dc2bb920db4bf91b11e6b1e7f507f78f3a778af19fcdb79e98eb87cf5d`
