# Acceptance: standalone 0.1.0 preview

The standalone library is implemented, documented and packaged for owner publication. **No GitHub or npm publication has occurred.** Classification parity is measured; localization remains experimental, with its failures retained. This acceptance concerns the extracted library, not the Zorya desktop application, installer, microphone or game session.

## Executed checks

| Check                         | Outcome / evidence                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linux source gates            | PASS: secret scan, TypeScript, ESLint with zero warnings, boundaries, dead-code, 160/160 tests, build. [Receipt](evidence/linux-check.json), [log](evidence/linux-check.txt)               |
| Native Windows runtime/source | PASS: 142/142 offline tests and source gates on Windows 11 x64 / Node 24.19.0; [receipt](evidence/windows-native.json)                                                                     |
| Native Windows secret guard   | PASS: 15 tests and one expected POSIX-only skip; actual worktree/index checks on temporary Git snapshot. [Receipt](evidence/windows-secrets.json)                                          |
| Installed archive, Linux      | PASS: independent consumer, exported declarations, actual installed archive byte/secret checks, native Sharp, fixture classify and three-stage locate. [Receipt](evidence/pack-check.json) |
| Installed archive, Windows    | PASS: independent consumer, declarations, native Sharp, fixture classify/locate. See native receipt; later documentation/secret-pack-check additions do not change runtime dist            |
| Runtime identity              | 34 dist files identical across Linux/Windows; aggregate SHA256 `62d5a0075e5ccca6627ba81f8ca8be427f499ded7508570171c00520bcf369ca`                                                          |
| Full live corpus              | Complete: 60 licensed photos + 30 authored texts; 321 HTTP calls. Failures remain recorded. [Results](results.md)                                                                          |
| Protocol diagnostics          | Two new diagnostic calls confirmed a rounding acceptance case; exact response covered offline. Historical rejected bodies were unavailable; [evidence](evidence/protocol-probes.json)      |
| Corrected runtime live smoke  | Complete: 2 dev photos + 2 dev texts, 14 HTTP calls, no protocol failures; one located box hit and one unknown. [Report](evidence/live-release-smoke-report.json)                          |
| Source/archive credentials    | Node staged/worktree checks, private-path/package allowlist checks and independent redacted Gitleaks; final snapshot results are included in release metadata                              |

The Windows checks are real native Windows executions, not Wine, but they are offline library tests rather than real game qualification. The two later benchmark-quantization regressions run on Linux; they do not alter the native-tested runtime. GitHub Actions is configured for Windows/Linux and Node 22/24; hosted CI has **not** been executed. Local native checks use Node 24. Node 22 and macOS remain unverified until those environments run.

## Quality and remaining limits

Photo classification was 55/60 and text fixtures 30/30 for both the wrapper and native Choice; there is no measured wrapper accuracy advantage. The full locator snapshot had 20 hits over 50 positives, 23 protocol failures over 60 photos, and 7 unknown outcomes. A response-quantization correction followed; the small final smoke validates integration, not final-version quality over the entire corpus. A fresh full-corpus benchmark of the corrected runtime is future work, with separate paid authorization/budget.

No all-game, map, minimap, segmentation, object-center, tracking, sub-second latency or universal detection claim is accepted. Reference-box containment is only a spatial proxy. No independent human annotation review or perceptual duplicate audit was performed. Text cases are authored policy fixtures. Read [results](results.md) before publishing any accuracy percentage.

Known reported provider cost across 337 calls is $0.079047906; 23 calls have unknown cost. Including their local reservations gives $0.539047906 accounted exposure, not a verified final bill. All source labels and historic failure reports are preserved. The original application and its private history were not changed or imported.

## Release traceability

Live manifests pin corpus and source snapshots. The source archive derives from the clean standalone Git commit; the external `release/manifest.json` pins that commit, the source-file manifest and final archive SHA256 values. It is intentionally outside the archives to avoid self-referential hashes. Public evidence omits host-specific private paths and contains no API key or raw user media. Licensed public photographs are downloaded separately; attribution/manifests remain in source.

The source/package is ready for review and owner publication as an experimental preview. Publishing destination, account authorization and final package-name availability are owner-dependent steps described in [publishing](publishing.md).
