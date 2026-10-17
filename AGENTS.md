# Zorya Classifier contributor rules

This repository is independent of Zorya Games. Implement the accepted MIT library plan in docs/plan.md.
Use strict TypeScript and Zod at public/provider boundaries. No explicit any, unchecked external casts, broad lint disables, or swallowed rejected promises.
Layers: app composes; processes orchestrate features; features use entities/shared; infrastructure implements ports. Entities/shared never import infrastructure.
Use the explicitly configured model/provider, with no fallback. Ordinary vision language models must work without native classifier APIs. Rank-only answers must not be converted into fake probabilities. Native Choice scores are categorical: select a maximum, retain raw scores, stable input-order ties; no universal 0.8 gate. Preserve raw quantized probabilities and require the explicit adapter annotation/interval test for non-unit mass; never silently normalize scores. Noul presence is a separate binary decision. Never call cell geometry a segmented object.
Own input bytes before awaits. All async operations share one absolute timeout, honor cancellation, release timers/listeners and retain concurrency slots until physical work settles. Imports do not start background tasks.
Keep real-provider and offline evidence distinct. Ground truth never enters requests. No color/game heuristics, image fitting to known labels, invented negative labels or claims of universal superiority.
Do not copy .env, private media, chat/session logs, source history or unrelated dependencies. Paid diagnostics are explicit with hard call/cost budgets. Publication requires explicit owner authorization; respect existing session authorization.
Run npm run check and npm run pack:check. Update docs, provenance and benchmark evidence with behavior changes.

Secret hygiene: preserve the staged-blob scan in Husky and worktree scan in check/CI. Empty .env.example is the only environment template; templates are content-scanned too. Run pack:check against installed archive bytes, not only gitignore rules. Never print matching secrets, copy upstream credential files, or create broad test/documentation exclusions. Secret heuristics and ignore files reduce risk; they are not a proof that arbitrary data contains no secrets.

Single-label classification and final candidate selection require one closed ID. Only spatial beam stages require four ordered candidates. Never reject a valid single-label operation for missing unused alternatives or invent probability distributions from ranks. Preserve protocol variants and failed live evidence when changing this contract.

Native decision models other than Jev are the primary integration; Luna Decisions is the first documented route. Ordinary vision-chat models remain supported alternatives. Native distributions retain original scores and must not inherit Jev-specific quantization without explicit evidence/configuration.
