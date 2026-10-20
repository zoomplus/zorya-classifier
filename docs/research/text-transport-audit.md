# Text-only transport audit for 0.2

Audited on 2026-10-20 against baseline `b6e562d`. This is a protocol audit, not a paid model evaluation or a claim that text-encoded photographs can be reliably recognized.

## Existing behavior to retain

`src/infrastructure/vision-chat.ts` already implements a generic non-streaming Chat Completions transport. Images are optional: strings become text content parts, the final `CLASSIFICATION_TASK` follows all data, and a single strict output parser handles categorical rankings and independent presence answers. It does not require a native classifier API.

The transport owns a bounded JSON snapshot before the first await. It forwards the caller's cancellation signal, disables redirects, reads a bounded response, and releases/cancels its reader through `readResponse`. There is one physical request and no transport retry or provider/model fallback. Model aliases in responses are accepted only through explicit identities or validated date snapshots. Missing `usage.cost` remains `null`; a response with ranking IDs never acquires invented probabilities.

`src/infrastructure/openrouter-vision.ts` pins the Chat Completions endpoint and requires an explicit provider. Its request contains `provider.only`, `allow_fallbacks: false`, and `require_parameters: true`. `src/openai-compatible.ts` accepts an explicit trusted HTTP(S) endpoint and optional credentials, with no OpenRouter dependency.

## Minimal additive implementation

1. Factor the existing implementation into an internal chat factory with an explicit modality argument, `vision` or `text`. Retain `createVisionChat` as a compatible wrapper. Add `createTextChat` with the same transport/parser/options. No caller-controlled or extra wire field is necessary.
2. In text mode, inspect the validated, owned request before fetch and reject every non-string state part with `UNSUPPORTED`. Do not silently strip images, stringify them, or accept their URLs as an alternative protocol. This check happens after plain-value snapshot validation, so accessors/proxies do not execute during modality validation.
3. Select an accurate system introduction for text mode: a closed-set classifier interpreting supplied text representations, rather than a visual evidence ranker. Keep the untrusted-data warning, final closed task schema, independent presence semantics, and exact rank cardinality unchanged.
4. Add `createOpenAICompatibleText` beside the existing direct vision wrapper and `createOpenRouterText` beside the OpenRouter vision wrapper. Public exports/types are coordinated by A0. Text and vision wrappers share schemas and transport implementation, rather than maintaining a second response parser.
5. Keep existing per-part validation intact. The representation layer, rather than this transport, owns normalization, view de-duplication, grid geometry, and the stricter aggregate representation budget. The transport should not infer an image codec or select models.

These changes do not depend on new whole-object or segmentation contracts and need no runtime dependency. The old vision code path must produce the same request body for the same input/options.

## Existing limits and integration implications

| Boundary             | Current limit                          | Consequence                                                                                                    |
| -------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| State parts          | 1–64                                   | Account for codec grammar, metadata, and all views together.                                                   |
| Each state string    | 1–64,000 UTF-16 code units             | A single 64 KiB ASCII payload may exceed this; split on meaningful complete view boundaries within this limit. |
| Prepared image parts | At most 9                              | A library policy, not the provider's universal maximum. Text mode allows zero.                                 |
| Decision questions   | 1–16                                   | Four extent questions fit in one call.                                                                         |
| Choice options       | 2–255                                  | Closed interval IDs and `unknown` fit.                                                                         |
| Request body         | At most 32 MiB                         | Includes task schema, escaping, headers excluded; text representation has its own tighter 64 KiB budget.       |
| Response body        | At most 1 MiB                          | Bounded reading also applies to error responses.                                                               |
| Ranking size         | Exactly 1 or 4, capped at option count | Whole-object sides need rank 1; spatial beam needs rank 4.                                                     |

The 64 KiB representation budget is a UTF-8 byte budget and includes all textual image views, not arbitrary task text. It must not be confused with the current 64,000-code-unit individual string schema. No byte truncation should attempt to repair an over-budget view: reduce and declare its resolution before serialization, or return a representation-limit result.

## Required offline regressions

- A real local HTTP server receives text parts only from the new direct adapter, without any key or OpenRouter route.
- Both new factories reject a valid prepared `image_url` part before fetch; test images appearing at the beginning, middle, and end of mixed state.
- Malformed, proxy, and accessor inputs remain rejected before transport. Raw image-like strings stay ordinary untrusted strings, not decoded images.
- Input mutation after invocation cannot change the emitted payload. A rejected image cannot be replaced with a text-only request through silent filtering.
- Text factory preserves explicit model/provider routing and all response-format options, body/response caps, cancellation, abort cleanup, route identity checks, closed ID/cardinality checks, and unknown cost semantics.
- Existing vision payload snapshots and behavior remain unchanged. Rank-only output still produces `probabilities: null` through the classifier.
- The textual codec grammar precedes its encoded views, and the final `CLASSIFICATION_TASK` stays last. No ground truth or model-specific expected answer enters either part.
- Experimental request preparation has a negative assertion over the serialized payload: no `image_url`, `input_image`, binary/base64 media, or media URL part. This assertion belongs to tests/benchmark capture, not a heuristic transport scan of all ordinary strings.

## Public metadata availability check

The following requests were unauthenticated metadata reads, with no inference dispatch and no key access. Retrieved at 2026-10-20 07:20 UTC:

- `GET https://openrouter.ai/api/v1/models?output_modalities=decisions&input_modalities=image` returned `openai/gpt-6-luna-decisions`, input text/image, output decisions, context 1,050,000. Catalog pricing was $0.10 per million prompt tokens and zero completion charge. This does not verify its current inference route or success rate.
- `GET https://openrouter.ai/api/v1/models` returned `deepseek/deepseek-v4.1-flash`, input text/image, output text. The benchmark may intentionally send text only even when the selected model also supports images; report payload modality separately from model capability.
- `GET https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints` contained the exact `together` tag, display name `Together`, status `0`, and supported parameters including `response_format`, `structured_outputs`, and `reasoning_effort`. That endpoint advertised $0.30 per million prompt tokens and $1.20 per million completion tokens. The cheaper model-level aggregate price belongs to other endpoints and must not be used to price the pinned Together route.

Default model catalog queries do not list all Decisions output models. An omitted Luna entry in the unfiltered text-output list is not evidence of removal. The guessed `/api/alpha/decisions/models` path returned 404 and must not be used as a catalog.

## Primary references

- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection): explicit provider allow-list, disabling fallback, and parameter support.
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs): strict JSON schema support is endpoint-specific; `require_parameters` is required when relying on it.
- [OpenRouter multimodal Decisions](https://openrouter.ai/docs/guides/community/multimodal-decisions): image parts go directly in `state`; text items are strings; filter the Models API by output modality.
- [OpenRouter API overview](https://openrouter.ai/docs/api_reference/overview): Chat Completions text content and response envelopes.

The official documentation allows considerably more images on Luna than this library's conservative nine-image bound. Raising that bound is unnecessary for this extension. Documentation also lists model-specific truncation behavior for other routes; do not add them as automatic text-encoding fallbacks.
