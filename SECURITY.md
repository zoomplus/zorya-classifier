# Security

Never post API keys, private photographs, raw sessions or personal data in public issues. A minimal synthetic reproduction is preferable. Use GitHub private vulnerability reporting when the repository owner enables it; if unavailable, request a private contact without publishing exploit details or secrets.

The library sends supplied text and prepared image fragments to OpenRouter/TypeSafe only when classify or locate is called with the real adapter. The library does not store them. Explicit benchmark runs can save request/response media locally, so review those outputs before sharing them.

Local inputs are restricted to byte arrays; the public API does not fetch arbitrary image URLs. The built-in provider endpoint is fixed, redirects are rejected, request/response/image sizes are bounded and external responses are validated. Injected DecisionPort/RefinementPort implementations are trusted code and must honor AbortSignal and terminate their own work.

Call dispose during shutdown. It cancels owned operations and waits for physical work. Native image processing is bounded but not preemptively interrupted midway; its slot is held until completion. A malicious or hung injected adapter cannot be forcibly terminated by this in-process library.

## Repository and package checks

`.gitignore` excludes local environment files, npm credentials, private keys, private directories, raw benchmark runs, image pixels, dependencies, build caches and release archives. `.env.example` contains only an empty key variable. An ignore rule does not remove an already tracked file.

`npm run secrets:staged` reads the actual added/modified Git index blobs by object ID, so editing a working file after staging it cannot hide the staged secret. The Husky pre-commit hook runs it before `npm run check`. The latter runs `npm run secrets:check` over tracked and non-ignored untracked worktree files; CI runs this too. The scanner reports only rule, path and line, never matching values. Forced-staged ignored credentials, symlinks, nonregular files and exceeded resource limits fail the check. Install local hooks with `npm run prepare` after `npm ci --ignore-scripts`.

The npm package uses an explicit `files` allowlist. `npm run pack:check` scans allowed file paths/content, installs the produced archive with lifecycle scripts disabled, checks its actual bytes against the scanned files, and exercises its exported API outside the repository. `prepublishOnly` runs the source and archive checks for a normal directory publication. A separate Gitleaks scan is recorded in release evidence.

These checks are heuristics, not a guarantee against all secret formats, encoded payloads or malicious concurrent filesystem mutation. Binary content is counted as skipped; private binary filenames are still blocked. Hooks can be bypassed locally, so retain CI and enable GitHub secret scanning/push protection when publishing. If a credential was ever published, revoke or rotate it before treating history cleanup as remediation.
