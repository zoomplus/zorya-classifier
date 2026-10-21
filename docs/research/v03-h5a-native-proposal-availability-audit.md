# H5a native proposal availability audit

H5a v2 closed with 12 case rows and nine content-hash source rows. This independent evaluation scores actual candidate mask pixels against the fixed pilot truth using the existing whole-object gate: one candidate must have box IoU ≥ 0.50 and reference coverage ≥ 0.90. Candidate generation is availability evidence; masks on negative cases are not false-positive or semantic-selection judgments.

| Candidate family | Photo positives | UI positives | Map positives |
| ---------------- | --------------: | -----------: | ------------: |
| H3 DINO + SAM2   |             3/3 |          0/3 |           2/3 |
| Omni + SAM2      |             0/3 |          0/3 |           0/3 |
| H4e cached SAM2  |             0/3 |          3/3 |           0/3 |
| Union            |             3/3 |          3/3 |           2/3 |

The union therefore has a same-candidate available mask in 8/9 positive cases. `pilot-v03-map-02` is the only positive without one; its closest H3 candidate has IoU 0.775 and coverage 0.8843, below the unchanged coverage threshold. The Omni family adds no passing positive candidate in this pilot. H4e contributes the passing UI candidates, while H3 contributes the passing photo and two map candidates.

Negative candidate counts are photo-04: H3 4; UI-04: H3 9 and H4e 36; map-04: H3 7 and Omni 36. These counts report availability only and make no false-positive claim.

The evaluator checked all 265 candidate mask paths as nonempty binary PNGs, verified encoded hashes and pixel-derived geometry, checked nine source images, and verified 19 producer/source closure receipts. It also checked the frozen run and freeze identities, upstream H3/H4e identities, and source-row locks. H5a source-result JSON metadata files do not have frozen file-hash receipts in the run/freeze; their observed hashes are recorded but their proposal payloads were not used for scoring. Candidate scores come from the run-hash-locked mask integrity receipts and actual PNG pixels.

Full per-case, per-family candidate receipts, passing IDs/hashes and gate scores are in [the machine-readable evaluation](../evidence/v03/h5a-native-proposal-availability-evaluation.json). Reproduce with `npx tsx benchmarks/v03/evaluate-h5a-native-proposals.ts <new-output-path>` from the evaluation-design worktree. The evaluator writes exclusively and refuses to overwrite an existing output.
