# H7 local semantic shadow: independent audit

**Result: the H7 advancement gate fails.** The fixed 12-case run completed, but the ranker placed a native-available candidate in the top four for only 3 of 9 positive cases. All three were the photo positives; it recovered none of the three UI positives or three map positives. The plan's cross-stratum gate is not met, so this result does not support promoting or tuning this profile.

| Positive stratum | Top one | Top four | Completed |
| ---------------- | ------: | -------: | --------: |
| Photos           |     3/3 |      3/3 |       3/3 |
| UI               |     0/3 |      0/3 |       3/3 |
| Maps             |     0/3 |      0/3 |       3/3 |
| **Total**        | **3/9** |  **3/9** |   **9/9** |

H7 also recovered none of H6's three known map losses (candidate-union availability, nomination, and final selection).

H7 emits similarity rankings only. It does not decide whether a target is present or absent. The three negative rows are therefore rank-only diagnostics; they are not detections, and the audit makes no false-positive or absence claim from their ranks.

The completed worker exited successfully and all 12 rows were scored. Its 14,947 ms total includes model initialization, inference, serialization, and post-run verification; it is not per-request latency. The independent audit joined 373 candidate rows to the frozen H5a availability records, rehashed all 12 source rows (9 unique source-image hashes), verified 265 unique native-mask PNGs and 74 source-closure files, and found no input-artifact changes or integrity errors. The required runtime pins matched: Python 3.12, Torch 2.6, CUDA 12.4, and Transformers 4.57.3. The observed versions were Python 3.12.3, Torch 2.6.0+cu124, CUDA 12.4, and Transformers 4.57.3 on an NVIDIA GeForce RTX 4080. NumPy 2.5.2 and Pillow 12.3.0 were recorded, but the accepted plan did not pin their exact versions.

The audit preserves two earlier failures in the independent evaluator. Attempt 1 stripped `benchmarks/cache/v02/corpus/` while resolving a frozen source image, and attempt 2 omitted the producer's nested `resize_geometry.crop_xyxy` field when comparing resize geometry. Neither attempt computed quality scores; neither changed producer artifacts. The corrected evaluator then completed the joins and scoring. These were evaluator defects, not producer or model failures.

The frozen artifact identities are:

- Run JSON SHA-256: `31ccd439108b49b25768c005b63c6f3061af78292861d2f4fd513076c1695d16`
- Freeze JSON SHA-256: `5d24e2073fcefeebee3650b3fffdc7be9228b76c07a32795083015eb0026c966`
- Input JSON SHA-256: `9d535169410e2679e42d560704f13317ee31407dbec593a73aca15732553ed7a`
- Independent evaluation JSON SHA-256: `03ae7f879da32f346f3614786af50f672c6a2f3c08ec924e9a88ab52d5c10fcc`
- Attempt 1 SHA-256: `cd9c4e548ae45124fbee5289d6b0ffbea8da9c1339a2faaad2cd7b30ecd8e287`
- Attempt 2 SHA-256: `53361f71e084e68cb8e0b454a55026566a56c9b2f1863c22cbff76025db33a8e`

Detailed per-candidate scores, ranks, aliases, mask hashes, and source-closure receipts are retained in [the machine-readable independent evaluation](h7-local-semantic-shadow-independent-evaluation.json). The initial evaluator failures are retained in [attempt 1](h7-local-semantic-shadow-independent-audit-attempt-01.json) and [attempt 2](h7-local-semantic-shadow-independent-audit-attempt-02.json).
