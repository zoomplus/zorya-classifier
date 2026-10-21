# H6 closed pilot audit

H6 improved the exposed positive pilot from H5b's 3/9 to **6/9**, but **did not pass advancement**. All three negatives still produced false locations, and no map passed the whole-object gate. Preserve the useful photo/UI gain without claiming a qualified pipeline or independent generalization. [Machine-readable evaluation](../evidence/v03/h6-context-identity-independent-evaluation.json).

| Stage                            | Photos | UI  | Maps | All positives |
| -------------------------------- | ------ | --- | ---- | ------------- |
| Actual qualifying mask available | 3/3    | 3/3 | 2/3  | 8/9           |
| Preserved by presence stage      | 3/3    | 3/3 | 2/3  | 8/9           |
| Preserved in nominations         | 3/3    | 3/3 | 1/3  | 7/9           |
| Final selected mask passes       | 3/3    | 3/3 | 0/3  | 6/9           |

The presence stage selected `present` on all twelve inputs. Its twelve requests cost USD 0.0014001 and rejected no negative. The complete replay used 44 physical calls, USD 0.0175759, zero unknown charges, zero in-flight calls and no persistence failures. Replay elapsed time was 183.257 seconds, excluding the previously completed native proposal generation; this is not production end-to-end latency. H5b's replay was 116.064 seconds, so H6's positive gain also incurred more work.

## What failed

- Map 01 lost its qualifying candidate during nomination and selected a copy of the unit in the left sidebar. Map 02 also selected the sidebar portrait, but its frozen native pool contains no mask meeting the unchanged geometry gate; better selection alone cannot make that case pass.
- Map 03 selected a fragment at the correct map unit. Its mask shares 494 of its 514 foreground pixels with the qualifying parent candidate, but covers only 42.4% of that parent's foreground. A hit on the right object is not a whole-object extraction.
- The negative photo selected a closed decorated egg-shaped container for `Bowl`. Record the visual similarity as a diagnostic; the frozen negative label is unchanged.
- The negative UI selected Back for Undo. The exact source's AT-SPI capture inventory confirms Back/Forward controls and no visible Undo control. Arrow appearance alone must not be used to relabel it as a disabled Undo action.
- The negative map selected the Explorer sidebar portrait for the requested Fighter. A source-level presence answer did not establish the correct unit type or requested main-canvas scope.

## Integrity and limits

The producer ran at Git commit `9a9cf89ea5ac35b51c3e521d0cf2abd712b38220`, after the integrated 652-test suite, lint, typecheck, boundaries, dead-code, build and format checks passed. Ten additional composer tests had passed in the owner worktree and were subsequently moved into normal test discovery in `32e02c9`; that relocation changed no producer source.

Independent checks verified 288 input artifacts, all 44 physical receipt sets, all 44 persisted raw decision traces and all twelve selected mask files. Pre/post executable closure matched. Raw run SHA-256 is `a820c01caedb0bf300fc6d6d5d2a682a2619cb255563788cd60f1f349c3ef6e4`; freeze SHA-256 is `61309468721835923e2aef449e785868705105f6251df67c0ffb70e70ba5ae75`. Absolute private run location is retained in local execution records, not required by consumers.

The evaluator initially expected the wrong reserve-field name. The producer correctly persisted `unknown_reserve_usd_per_call`; the evaluator-only fix and a regression were committed in `ff253ed`. No producer result or threshold changed and no paid replay was repeated. Separately, an early mock-test setup omitted its controlled base fetch and made one request with a dummy credential; it failed authentication. Its exact HTTP status and deleted temporary receipt cannot now be independently reconstructed. The corrected fixture is confined to a controlled transport, validates serialized image state and audits persisted receipts/traces. This failed fixture is not quality evidence or part of the live replay ledger.

The pilot's styled Geany screenshot and related Freeciv sources remain narrow development data. H7 now tests a different local semantic ranking mechanism under its [prospective plan](v03-h7-local-semantic-reranking-plan.md). Scope, object extent and negative rejection remain separate unresolved problems; no release or full qualification is authorized by these pilot scores alone.
