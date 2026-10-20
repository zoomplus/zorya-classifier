# Frozen categorical heldout v4: failed qualification

Both producers completed on the frozen source and inputs before independent truth evaluation. The candidate completed 80 cases; its no-image control completed all 40 photographs. **The candidate does not qualify for release.** The [numeric report](report.json) binds the original run, source, input, truth and output hashes. The earlier [zero-HTTP admission failure](../categorical-heldout-predispatch-20261020-v3.json) remains a separate, unchanged record.

| Measurement                      | Candidate                                                                            | No-image control                            |
| -------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| Classification                   | 69/80: 59 true positives, 10 false positives, one false negative, ten true negatives | 10/40; predicted absent on every photograph |
| Positive whole-object boxes      | 1/60: photo 1/30, controlled UI 0/15, controlled minimap 0/15                        | 0/30 photographs                            |
| False locations                  | 0/20 negatives; limit one                                                            | 0/10 photograph negatives                   |
| Paired positive-photo difference | 1/30; 95% bootstrap interval **[0, 0.10]**                                           | Lower bound must be strictly positive       |
| Physical calls                   | 356; 349 HTTP 200, seven HTTP 502                                                    | 100; all HTTP 200                           |
| Known cost                       | $0.1608769 plus seven unknown charges                                                | $0.0540033                                  |

All 30 positive photo pairs count, including unknowns and failures. The fixed 10,000-resample paired bootstrap uses seed `0x5a4f5259` and nearest-rank percentiles. The negative gate passes, but the paired gate fails. The seven 502 calls occurred on negative cases; none explains the positive localization failures. No automatic retry, provider fallback or replacement case was used. The combined known cost is $0.2148802; retaining $0.05 for each unknown charge gives accounted exposure $0.5648802. This is admission accounting, not a verified provider invoice.

The candidate's 60 positive cases reconcile as follows: one initial absence decision, 22 final-grid failures, 15 selections of no mask, 18 rejected completeness checks, three incorrect returned boxes and one correct box. The 37 cases reaching native proposals include the latter four categories. Classification of presence and localization of a complete instance are different tasks; the 69/80 classification result does not qualify the whole-object path.

Whole-box and cutout-mask correctness remain separate. The original candidate evaluation below contains **zero joined mask references**, although the separately pinned official index contains 32 masks for 21 photographs. A strict source-canvas join then rejected 30 masks whose full-frame annotation resolution differs from the source image. Two canvases match exactly. This is a reporting/alignment issue, not the cause of the box or bootstrap failure. The original evaluation is preserved byte for byte; normalized-canvas mask calculations, if reported, must be explicitly exploratory and cannot repair its release result. Exact annotation sampling and original Flickr rotation are not independently established. A separate [exploratory normalized-canvas calculation](mask-normalized-exploratory.json) now verifies all 32 original PNGs and records all 21 annotated cases: seven reference instances have a saved prediction to score, three reach IoU 0.8 and 25 lack a returned mask. It projects source prediction pixel centers onto the original annotation canvas; raw references, box gates and the failed paired result remain unchanged. This explicitly uncertain alignment does not qualify mask accuracy.

Operation latency uses nearest rank over every completed case, including failures: candidate classification p50/p95 0.980/4.537 seconds and localization 6.746/41.875 seconds; control classification 0.605/1.722 seconds and localization 0.927/2.654 seconds. Physical-fetch distributions are recorded separately. These shared-host measurements are **unranked** under the frozen policy.

The no-image audit verified all 100 actual requests contained neither image parts nor image-derived state. Its DeepSeek/Together model differs from the native Luna/OpenAI candidate, so this compares complete recipes and does not isolate the causal contribution of image input. UI and map each use one controlled source family, Mousepad and Minetest respectively; this is not arbitrary real-game acceptance.

The 80 cases are now exposed regression data. Do not select a runner-up or claim a new blind success from them. A changed method requires separately named development evaluation and a new source-group-disjoint blind cohort, with the existing gates retained. Models and providers remain caller-owned, with no library default.

## Preserved artifacts

- [Candidate evaluation](candidate-evaluation.json) and [provenance](candidate-provenance.json): initial output without the separately indexed mask references.
- [Control evaluation](control-evaluation.json) and [provenance](control-provenance.json).
- [Original paired qualification](paired-qualification.json).
- [Candidate physical receipts](candidate-physical-receipts.json) and [control physical receipts](control-physical-receipts.json): metadata-only derivatives, without request bodies, media or credentials.

`report.json` records each artifact's SHA256 and byte length. The five original evaluator/provenance outputs remain byte-exact; receipt JSON preserves the original arrays as a separately identified derivative. Source, pixel and reference-mask bytes remain outside the npm package.

The exact exposed [input/truth/source metadata catalog](../../../../benchmarks/v02/evidence/exposed-regression-v4/README.md) records all corpus pins and canvas audit; source pixels require separate licensed acquisition.
