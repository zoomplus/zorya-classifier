# Operations

Provide an OpenRouter API key through your server environment. The CLI reads OPENROUTER_API_KEY; core code receives keys explicitly. Store keys in ignored local files or a secret manager. No startup request is made.

Use `zorya-classifier --help`. Commands: classify-text text classes.json; classify-image image classes.json; locate image target. CLI calls real paid models. Native images are decoded locally through Sharp; external requests send prepared text/images to the pinned route. The library neither writes nor logs media by default.

Choose a finite timeout based on your UI needs. Default 45s includes queue time; no latency SLA is asserted. Handle CAPACITY by applying upstream backpressure rather than creating more clients. Explicitly cancel superseded application requests and call dispose on shutdown. A cancelled native job may finish before its slot is released; this prevents unbounded physical concurrency.

Unknown cost remains unknown. Budget your own calls or use the benchmark's conservative reservations. Do not implement retries around locate without accounting for all prior physical calls and potential charges. Screenshots can become stale while analysis runs; acquiring current frames and deciding whether results are still relevant belongs to the application.

Build release locally with npm run check and npm run pack:check. Produce npm pack only after those gates. Review LICENSE/NOTICE/acceptance and archive contents before publishing. GitHub repository URL, package ownership and maintainer contact are added by the publishing owner; no fictional account or remote is configured.

Owner handoff and authentication steps are in [publishing](publishing.md). Secret scanning commands and their limits are in [SECURITY](../SECURITY.md); they run in Husky, source checks and the archive check. Release manifests live next to the prepared archives, outside Git/npm contents.
