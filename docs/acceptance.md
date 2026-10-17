# Acceptance: standalone0.1.0 preview

This acceptance concerns the extracted MIT Node.js library, not the Zorya desktop application, installer, microphone or game session. Native Luna Decisions is the primary documented route; ordinary vision chat, direct OpenAI-compatible servers and custom DecisionPort implementations remain alternatives. Jev is optional historical compatibility.

## Executed checks and release gates

| Check                 | Evidence                                                                                                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux source quality  | Secret scan, TypeScript, strict ESLint, boundaries, dead-code,187 offline tests and build pass. Current local receipts are preserved with the release.                                                                                                            |
| Installed archive     | Independent consumer compiles exported declarations and exercises native Sharp, fixture classification/three-stage localization, native Decisions adapter and ordinary direct adapter. Actual installed bytes are compared with the reviewed archive and scanned. |
| Hosted Windows/Linux  | The [CI matrix](https://github.com/zoomplus/zorya-classifier/actions) runs Node22/24 on both operating systems. Publication requires all four jobs green for the release source; the external release manifest records the exact run/commit and results.          |
| Native classifier     | 60 licensed photos:55 correct;40 heldout:39 correct;30 authored texts:30 correct; zero classification transport/protocol errors. [Exact model evidence](vision-results.md).                                                                                       |
| Other ordinary models | Full Luna and Qwen comparisons, Nex development screening and stopped Haiku photo batch are preserved, including errors and unstarted cases.                                                                                                                      |
| Lifecycle             | Offline regressions cover input ownership, deadlines, queue saturation, late completion, cancellation/reader cleanup,1000 operation/disposal cycles and strict rank/probability interpretation.                                                                   |
| Credentials/archive   | Staged-blob/worktree scans, independent redacted Gitleaks and actual archive checks run before publication. Results and artifact hashes belong to the external release manifest.                                                                                  |

The [first hosted CI run](https://github.com/zoomplus/zorya-classifier/actions/runs/39074647509) is retained as a failure: Linux passed; Windows exposed an8.3 temporary-directory alias mismatch in the declaration-isolation check. The check now canonicalizes with native filesystem realpaths; allowed declaration roots are unchanged. The final hosted run, rather than that failed run or historical local results, determines release eligibility.

Historical native Windows/source and secret-scan receipts remain under docs/evidence; they describe the older runtime. Current hosted Windows exercises the new adapters and full source gates without Wine. macOS and live desktop/game integration remain unverified.

## Quality limits

Luna Decisions matches the historical Jev photo/text counts on this corpus; this is not proof of statistical non-inferiority, calibration or universal superiority. Two disjoint native sessions cover the full90 classification cases without replay or prompt changes. Public photographs may overlap training; text cases are authored fixtures, not customer traffic. No independent annotation/duplicate audit was performed.

Localization is experimental. The first native smoke failed at its195-option/nine-image fine request; an explicit replay returned HTTP502 with provider refusal. The original error and diagnostic remain preserved. A separate fixed flower-image smoke completed all three native stages in4.75s; its reviewed receipt is in docs/evidence, and it does not replace a full localization evaluation. A selected cell is not segmentation, an exact object center, tracking or a universal map/minimap guarantee. Offline fixtures are not real-model quality evidence.

Paid comparison accounting is separate from the historical337-call Jev work. The owner expanded the comparison limit to1000 calls while retaining the$0.50 ceiling. Reported costs are reconciled only from retained numeric receipts; failed classifications remain failures, unknown charges retain conservative reservations. Local admission accounting is not a provider-side account cap or a verified invoice. The comparison finished at332 calls, known cost$0.03456876 and four unknown costs; conservative accounted exposure is$0.23456876. Exact receipts are in the model evidence/release manifest.

## Traceability

Live manifests pin corpus/source snapshots. The clean source archive derives from the standalone Git commit; the external release manifest pins that commit, source-file manifest, all archive SHA256 values, CI results and final secret scans. It remains outside the archives to avoid self-reference. Credentials, personal media, private history, dependencies and corpus photo pixels are excluded. See [publishing](publishing.md) and the actual GitHub/npm destinations for publication status.
