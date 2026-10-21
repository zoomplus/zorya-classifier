# H8: ordinary vision reasoning on the fixed H6 evidence

Status: accepted benchmark-only comparison, written before implementation or provider dispatch. This experiment can proceed independently of H7: local similarities test nomination, while H8 tests semantic decisions including absence. Neither changes the published library's defaults or chooses a model for consumers.

Pre-dispatch correction for H8b, 2026-10-21: H8a closed on source `72259cd`; constructing the subsequent Sol ledger failed before any Sol dispatch because the shared DEV ledger permits at most USD 5. The original USD 12 ceiling was incompatible with that existing guard. Reproduction confirmed zero calls. H8b now uses the tighter USD 5 ceiling with the same USD 0.25 unknown-call reserve, and an explicit budget factory exercises both arm constructions in a regression test. The shared ledger limits, model parameters, prompts, images, masks and scoring criteria are unchanged. The old plan and launcher failure remain in Git/run evidence. H8a's source is retained separately for its independent audit; the corrected H8b source is frozen in its own worktree before dispatch. This correction is unrelated to the model's quality outcomes.

## Hypothesis and sources

H6 has usable masks for eight of nine positives but selects six correctly and falsely locates all three absent targets. Its failures include a Back icon mistaken for Undo and a sidebar portrait selected instead of the requested map instance. Keeping its image evidence and questions fixed, an ordinary vision-chat reasoning route may interpret these distinctions better than the current native Decisions route. This is an empirical comparison of complete model/adapter arms, not a claim that a different API alone causes a gain.

The existing public `createOpenRouterVision` adapter supports closed rank-only answers. OpenRouter documents [image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding) and endpoint-dependent [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs). The [Luna catalog](https://openrouter.ai/openai/gpt-6-luna) and [Sol route listing](https://openrouter.ai/openai/gpt-6.1-sol/providers) currently advertise image inputs and structured outputs. These establish feasibility, not localization accuracy. [POPE](https://arxiv.org/abs/2305.10355) motivates preserving hard negatives rather than measuring only selected positive examples.

## Frozen arms and execution

- Retain the completed H6 native `openai/gpt-6-luna-decisions` / OpenAI run as a historical paired comparator; do not rerun it until favorable.
- H8a: `openai/gpt-6-luna`, provider slug `openai`, display identity `OpenAI`.
- H8b: `openai/gpt-6.1-sol`, the same explicitly pinned provider.
- Both new arms use `/api/v1/chat/completions`, the existing vision adapter, strict `json-schema`, reasoning effort `medium`, and 4096 maximum output tokens. No fallback, retries, tools, coordinates, probability synthesis or extra captioning step. Freeze the actual endpoint capability and price receipts before dispatch. Stop on unsupported routing rather than silently modifying the recipe.
- Use all twelve H5a cases once in the existing fixed order, the identical actual D/U mask pools, targets, exclusions, H6 compositor, prepared source/candidate pixels and logical questions. Only the injected adapter/model and its required transport serialization change. Do not add a target explanation, source label, ground truth or failure-specific hint.
- Preserve four as the nomination ranking size and one for presence/final choice. Rank-only answers remain rank-only; retain raw native scores solely in the historical native evidence. A stronger similarity or rank is not calibrated confidence.
- Each arm owns a fresh recorder and budget. Maximum 48 physical requests per arm, 96 across the comparison; maximum cost USD 2.40 for H8a and USD 5 for H8b, unknown-call reserves USD 0.05 and USD 0.25 respectively. Stop admissions on budget exhaustion and retain unknown charges. These are ceilings, not expected costs. Existing session authorization covers this public-corpus test.
- One active case per arm; run arms sequentially. Retain H6's 240-second absolute case deadline including preparation, provider work and serialization, its cancellation/disposal semantics and its image/mask byte caps. Errors, truncation and timeouts are outcomes, not reasons for a hidden replay.
- Freeze plan, model/provider/parameters, executed source closure, dependencies, input hashes and physical-fetch recorder before dispatch; rehash afterward. Store outside the repository, retaining request/response receipts, every row and every selected original mask. No new public API or dependency is required.

## Implementation ownership and checks

The spatial owner implements a narrow H8 runner around the existing composer and replay kernel, in its separate worktree. Share replay mechanics where practical; keep explicit recipe identities and strict H6 validation intact instead of duplicating hundreds of lines or relabeling a different model as H6. Inject the recorded ordinary adapter and retain actual chat route/parameters in every arm's freeze and receipt. Extend source closure to every newly executed helper.

Before live work, use the real public chat adapter with a controlled fetch to exercise all stages on the fixed mock roster. Verify one-label versus four-rank schema, rank-only persistence, physical accounting, explicit route, abort/partial/error behavior and no accidental external fetch. Existing H6 regressions must remain valid. Root owns integration and dispatch; the evaluation owner independently checks the new arm identities, rank-only selection, source/mask joins, receipts and quality metrics.

## Comparison and next decision

Report each arm separately: presence retention, nominated availability, final positive successes by stratum, negative false outputs, technical errors, elapsed time and known/unknown cost. Compare selected masks with the unchanged whole-object gate and with H6. Do not compare native probability magnitudes with chat ranks or call this a pure API ablation.

Advance an arm only if it preserves all three photo and all three UI positives, gains at least one map positive, and produces no false output on the three negatives. If neither passes, preserve partial gains and failures; write a different implementation plan before further development runs. Do not tune wording, reasoning effort or token limits against these outcomes. An implementation defect must be reproduced and documented before a corrected run. Passing this pilot still requires DEV40, independent qualification and the existing technical/release checks.
