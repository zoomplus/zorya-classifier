# Categorical-presence whole-DEV target-instruction comparison

This is a benchmark-only comparison of two caller-owned target strings. It does not change the library default or select a provider for library users. Both profiles run the full frozen 40-case DEV producer set, in order, with independent per-profile budgets and immutable output directories. The split-route DEV6 result remains a failed development result and is not replaced or reclassified by this comparison.

| Profile                                                       | Whole-object target sent to the classifier                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `native-luna-categorical-presence-sam-target-plus-neutral-v1` | The authored target followed by the approved neutral instruction, when present. |
| `native-luna-categorical-presence-sam-target-only-v1`         | The authored target alone.                                                      |

The only intended model-input difference is omission of the neutral instruction in the second profile. Before either profile starts, the runner rejects any nonempty instruction other than `Locate the visible physical instance of the named object; return unknown when unsupported.` The first profile preserves that instruction. The second omits it. UI and map cases without an instruction receive the same target in both profiles. Each manifest retains the original authored task, including the instruction, so the comparison remains auditable.

Both profiles use the same pinned native Decisions route, one native Choice request for each classifier decision, MobileSAM proposal adapter, classification prompt/classes, and all localization settings. The conversion from binary presence to closed Choice is inside the per-case provider recorder: physical receipts, request hashes, and decision traces therefore describe the actual native Choice request. Spatial Choice questions pass through unchanged. The categorical answer contains only `present`, `absent`, or `unknown`; no score is invented.

The input pins are 20 photo, 10 independent UI, and 10 independent map cases: `6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a`, `6013a54bebba277f6457765cd8ef78e12e2dd5bab4453a752967233ebb429bfc`, and `b04ba6cac5b39c927281f61e4af7dcc7a5c5c2272a637aa9676ab3009fbd5d15`. The producer loads only these arrays and their images; it does not read truth or evaluation ledgers.

The frozen policy is 120 seconds per operation, two case workers, one active native worker plus two waiting jobs, 8-pixel tolerance, three extent passes, no retries or fallback, and a separate 300-call / $5 / $0.05 unknown-cost budget for each profile. A per-case admission ceiling of six calls yields at most 240 physical calls per full profile, below the profile cap. Profiles run serially. Timing is marked unranked because calls and native processing overlap across the two case workers.

Each case writes its result and call journal under `<run>/<caseId>/`, including extracted binary masks and cutouts when available. The summary records all planned/completed IDs, typed failures and unknown outcomes, receipts, known and unknown cost, and source-hash equality from before to after the profile. The paired controller stops before profile two if profile one is incomplete or its source snapshot changed. This is a development comparison only; it does not change the predeclared heldout gates or authorize another model run by itself.
