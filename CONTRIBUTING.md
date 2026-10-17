# Contributing

Use Node.js 22.12+ and npm. Run npm ci --ignore-scripts, npm run check, npm run pack:check and npm run format:check. To enable local hooks run npm run prepare; Husky first scans the actual staged Git blobs, then runs the source checks. `npm run secrets:check` also scans tracked and non-ignored untracked worktree files, and runs in the Windows/Linux CI matrix. `npm run pack:check` verifies the installed archive contents against the scanned source. Never bypass a secret finding by disabling the hook or adding a broad allowlist.

Keep domain logic independent from provider/native adapters. Use Zod for external data, strict TypeScript, explicit exports and operation-owned resources. Read AGENTS.md. New asynchronous paths require meaningful cancellation and late-result tests. Lint cannot prove memory safety.

Do not commit credentials, private media, local logs, build caches or unrelated upstream source history. Provider fixtures must be labeled as fixtures; real benchmark evidence must record source/model/provider/version/requests/cost/errors. Do not tune against heldout results or hide failed runs.

Open a focused issue or pull request with the behavior change, reproduction and validation. Do not run paid benchmarks as a pull-request CI job. Contributions are accepted under MIT; third-party assets must retain their own licenses and attribution.
