# Operations

Configure a trusted model endpoint or the optional OpenRouter route. SDK factories receive endpoint/model/key explicitly; the core knows only DecisionPort. Keep server-specific credentials separate from OpenRouter credentials. Store keys in ignored local files or a secret manager. No startup request is made.

CLI requires `ZORYA_MODEL` and defaults to `ZORYA_MODE=decisions`. For ordinary vision models/custom chat servers choose `ZORYA_MODE=chat`. OpenRouter mode requires `OPENROUTER_API_KEY` and `ZORYA_PROVIDER`; direct mode uses a full `ZORYA_ENDPOINT` with optional separate `ZORYA_API_KEY`, and never forwards the OpenRouter key. In chat mode, optional `ZORYA_REASONING_EFFORT` and `ZORYA_RESPONSE_FORMAT` must be supported by the chosen endpoint. Use `zorya-classifier --help`. Commands: classify-text text classes.json; classify-image image classes.json; locate image target. CLI calls real paid models. Native images are decoded locally through Sharp; external requests send prepared text/images to the configured route. The library neither writes nor logs media by default.

Choose a finite timeout based on your UI needs. Default 45s includes queue time; no latency SLA is asserted. Handle CAPACITY by applying upstream backpressure rather than creating more clients. Explicitly cancel superseded application requests and call dispose on shutdown. A cancelled native job may finish before its slot is released; this prevents unbounded physical concurrency.

Unknown cost remains unknown. Budget your own calls or use the benchmark's conservative reservations. Do not implement retries around locate without accounting for all prior physical calls and potential charges. Screenshots can become stale while analysis runs; acquiring current frames and deciding whether results are still relevant belongs to the application.

Build release locally with npm run check and npm run pack:check. Produce npm pack only after those gates. Review LICENSE/NOTICE/acceptance and archive contents before publishing. Publication destinations are GitHub `zoomplus/zorya-classifier` and npm `zorya-classifier` under owner `zoomplus`. Authentication stays outside the repository. Check the remote release/registry and external receipt for actual publication state.

Owner handoff and authentication steps are in [publishing](publishing.md). Secret scanning commands and their limits are in [SECURITY](../SECURITY.md); they run in Husky, source checks and the archive check. Release manifests live next to the prepared archives, outside Git/npm contents.

Compatibility with another image-capable model does not imply tested accuracy or support for all structured-output parameters. Choose prompt/JSON-object/JSON-schema mode according to server capabilities, inspect explicit failures and consult docs/vision-results.md. Never label generated ranks as calibrated probabilities.

# 0.2 additions

Whole-object location, explicit extraction backends, CLI artifacts and ownership are described in [the 0.2 guide](v02-usage.md). The core input reservation is bounded across active and queued work; native admission rejects before expensive snapshots/base64. Keep a shared segmenter alive until all owning clients have disposed. Native calls currently start a fresh owned child each time; session reuse is not implemented. Do not extrapolate cold synthetic smoke timings into production latency or photo quality.

The [native resource harness](../benchmarks/v02/NATIVE-SMOKE.md) records independent parent samples, short-child memory, idle/busy phases, cancellation and child ownership without forcing garbage collection. A short harness verification is separate from the required two-hour resource run. Use an explicit corpus/asset manifest and preserve unsuccessful results.
