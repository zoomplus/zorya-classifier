# H5b: bounded paid-replay runner plan

**State: implementation plan only.** This work authorizes local validation, mock transport tests, and producer-side artifact rendering. It does not authorize a real provider dispatch. The first live replay requires a separately frozen recipe and explicit owner authorization.

## Frozen inputs and boundary

Load only the fixed 12-case manifest and the completed H5a producer output. Pin H5a v2 `run.json` SHA-256 `86d0aab4f7fad3ce0fae182b840ddd540275309471b27cb091dc4e85866d56f0`, `freeze.json`, post-run integrity sidecar SHA-256 `43b6502dae3a0303a4700cc9692e1cb59a618fa645a110cfd40474f1a4825f50`, and worker-closure sidecar SHA-256 `d899e970aee5e893e1d0bcac97eefe6b15831936c6d6bb20723e95942293a76f`. Verify every source, case row, candidate record, packed mask, and inherited producer receipt before rendering. H3b and H4e remain pinned to the closed runs recorded by H5a. Own all source and mask bytes before asynchronous work; never rewrite or bundle caller-owned model assets.

The runner receives only fixed source bytes, authored target/exclusion text, and H5a candidate-family records. It must not read evaluator reports, truth labels, strata, or availability shortlists. Use the H5b composer only after its module and exact interface are committed and reviewed. Proposed boundary: validated H5a candidates in stable producer order in; per-family aliases/rank evidence and a final selected alias or `none` out. Composer receives no case ID, stratum, truth, evaluator gate result, or cross-family score comparison.

## Replay behavior and limits

For each row, make two within-family nomination choices (`D00`–`D35`, `U00`–`U35`, each with `none`) followed by one final mask-aware choice over at most eight nominees plus `none`. Use `rankingSize: 4` for family choices and retain the actual response: preserve raw categorical scores and stable input-order ties when supplied; preserve rank-only order without invented probabilities. A top-four `none` consumes its rank and is not a nominee. The final view includes the full source and one large card per nominee, with clean context, actual overlay, and cutout, at most nine image parts total. Accept only a closed nominee alias or `none`; do not accept model-generated boxes or coordinates. Final acceptance criteria require target identity, mask purity, and whole visible extent.

Use an explicit OpenAI `DecisionPort` configured for `openai/gpt-6-luna-decisions`; no provider fallback or retry. The frozen replay budget is at most 36 physical fetches and $2 total, reserving $0.10 per call for unknown cost. Enforce the absolute 240-second deadline per case, including all preparation and calls. Preserve exactly 12 result rows, including errors, timeout, unknown, and abstention. Stop before a request that would exceed call, cost, image-part, byte, or time limits. Keep native H5a generation timings separate from replay preparation and provider latency; the 240-second limit applies to replay only.

## Evidence and validation

Write an exclusive output directory with a pre-dispatch freeze, source closure, exact request/response receipts, all family rankings and raw distributions when present, selected alias provenance, selected full-resolution mask PNG plus hash, failure rows, physical-fetch count, known and reserved unknown cost, and separate native/replay timing fields. Do not send native quality scores to the model. Keep corpus truth and evaluator measurements in a later independent evaluation step.

Before any live replay, add offline preflight tests for input hash/ownership validation, candidate alias stability, nominee-card byte/image-part caps, empty and small family pools, raw-score tie handling, rank-only preservation, `none` handling, budget/deadline enforcement, all-12 failure preservation, and output-mask provenance. Exercise the public transport with a mocked fetch and actual frozen H5a source/mask artifacts, following the existing grounded-mask replay-local test pattern. Record the exact producer/composer/runner closure and run the repository gates on the reviewed stable tree. No assets are downloaded and no provider request is made in this phase.
