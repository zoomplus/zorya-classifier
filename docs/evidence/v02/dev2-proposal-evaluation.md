# DEV2 fresh proposal evaluation

DEV2 is a complete, independently scored 40-case development run for the frozen `native-mobile-sam-proposals-v1` profile. The report contains aggregate outcomes only; per-case outputs, image bytes, truth rows, and mask rasters remain in ignored run directories. This run does not qualify the profile: positive localization and mask coverage are inadequate.

The raw producer run is `v02-fresh-native-mobile-sam-proposals-v1-2026-10-20T125410679Z-69e9be19`. Its summary SHA-256 is `5e3d6b9c59a062dea5985fb600bdf4037a1f463a3870ee69fa6730f87136a912`, and its run-manifest SHA-256 is `9e51ecb89e153a79e145ae171884d82373b0d9fb163266ada330c498d484ffe5`. The active DEV input manifests are photo (6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a), independent UI (6013a54bebba277f6457765cd8ef78e12e2dd5bab4453a752967233ebb429bfc), and independent map (b04ba6cac5b39c927281f61e4af7dcc7a5c5c2272a637aa9676ab3009fbd5d15); the independently pinned truth files are dev (793e26845deaa2cb56748ef270b8cb02877218d680068573f02e5af92b26af6a), dev-independent-ui (c7944190e1cadab695f2688351df10a14132986040dafb72794bb1df4571abfe), dev-independent-map (874971d3e9344f7c54207064115257e5c802260d2a996a53f96bb6a68b2afad3). The derived summary, evaluator output, and provenance hashes are respectively `aca9506688d189fe420154d37403080dcdb89d3c723c9f741afd17a7a7630590`, `abf393674f518080f915f619f4feadb4fd9f24eb677eb544fbfc869b628d4e80`, and `8551e3b796c08f696980e3862019d5926828df56520c57757585613a1d7d5a46`.

All 40 planned cases were reported. Classification was correct on 35/40. Whole-object localization matched 1/30 positive cases (3.33%); there were 0/10 false locations on verified negatives. The complete localization denominator also includes 21 unknowns, 9 failed results, 7 not-found results, and 2 located-but-incorrect boxes. Six of 40 outcomes were correct when verified negative cases are included.

| Stratum | Cases | Classification correct | Positive boxes matched | Localization outcomes |
| --- | ---: | ---: | ---: | --- |
| Photos | 20 | 17/20 | 1/16 (6.25%) | {"unknown":5,"failed":8,"not-found":5,"located":2} |
| Controlled real UI | 10 | 8/10 | 0/7 | {"unknown":9,"failed":1} |
| Controlled real map | 10 | 10/10 | 0/7 | {"located":1,"unknown":7,"not-found":2} |

The producer returned 21 unknown, 9 failed, 7 not-found, 3 extracted extraction outcomes; failures were 6 `PROVIDER`, 3 `TIMEOUT`. It made 172 physical calls against a 300-call cap. Known cost was $0.0779143; 9 unknown-cost calls reserved a total accounted exposure of $0.2579143 against the $5 cap. Reserved exposure is not an invoice. Latency ranking was marked eligible by the run policy, but these measurements do not change the quality conclusion.

For masks, independent truth contains 7 instances across 5 annotated cases. Only 2 instances in 1 extracted case were scoreable; both instance IoUs were below 0.8 (best 0.0001863). 4 annotated cases containing 5 instances lacked a prediction mask, while 35 cases had no reference mask. No case passed the 0.8 mask threshold. This mask metric is separate from box localization.

Against DEV1 on the same frozen 40-case source and truth pins, classification stayed at 35/40, while whole-object positives fell from 3/30 to 1/30; photo positives fell from 3/16 to 1/16. Unknown localization outcomes increased from 8 to 21; failures changed from 21 to 9. Mask cases passing IoU 0.8 fell from 1 to 0; DEV1 scored 3 instances in 2 cases, versus 2 instances in 1 case here. DEV1 provenance SHA-256: `8e7ee0676d0c0187d621c5721993e94a3748f4c08aa9367cdd79583c7c78d557`; raw summary SHA-256: `0ca5613d4c2a244377b9f02afaa48c881dde28c1ce2ab3b67acea54a2a9c0ba7`; run-manifest SHA-256: `740919de4c27deda9126d7f8c2816e2f10cb039d9ac25c6dd0d27feb555d6712`.

The older no-image-control development report is not a paired comparator: it contains 30 cases, 7/30 correct classifications, 0/23 positive localizations, and 30 unknown localization outcomes, rather than the current pinned 40-case cohort. It is reported only as context and is not used to qualify this profile.
