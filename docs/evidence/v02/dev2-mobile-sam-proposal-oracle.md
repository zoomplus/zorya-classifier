# DEV2 MobileSAM proposal-universe diagnostic

This is an offline component diagnostic, not an end-to-end quality result or qualification run. I replayed the first three saved spatial-choice decisions for the five DEV photos that have independent instance-mask annotations, reconstructed each seed using the same frozen spatial-layout functions, and ran only the CPU MobileSAM proposal adapter. It made no HTTP/model calls. All 36 packed masks per seeded case were written and hashed before the independent masks were opened for scoring.

Four photos had a positive final seed decision and produced 144 persisted proposal masks. The fifth photo’s final presence response was 0.4, so the original pipeline had no seed and this probe did not invent one. Candidate results were scored against all six reference instances across the four seeded cases:

| Case                 | Seed intersects reference instances | Nine prompt-point hits by instance | Best proposal mask IoU by instance | Original public extraction outcome        |
| -------------------- | ----------------------------------: | ---------------------------------- | ---------------------------------- | ----------------------------------------- |
| photo-dev-present-06 |                                 1/1 | 6/9                                | 0.810                              | timeout after proposal generation         |
| photo-dev-present-08 |                                 0/2 | 0/9, 0/9                           | 0.000, 0.000                       | extracted; selected-mask IoU 0.000, 0.000 |
| photo-dev-present-09 |                                 1/1 | 9/9                                | 0.945                              | timeout after proposal generation         |
| photo-dev-present-13 |                             no seed | —                                  | —                                  | contradictory-evidence before proposals   |
| photo-dev-present-15 |                                 1/2 | 0/9, 7/9                           | 0.606, 0.942                       | extent-uncertain after proposals          |

Three of six reference instances had at least one proposal with mask IoU ≥ 0.8. This shows that useful masks were present in the native candidate set for some seeds, while the two reference instances in photo08 had no seed-rectangle overlap, so those targets had no matching mask. It does not show that a model would select those candidates: proposal aliases were not ranked by this evaluator, and no held-out data was read. The original user-visible pipeline still produced no successful extraction on this five-photo annotated subset: two timeouts, one selected mask with near-zero overlap, one upstream contradictory decision, and one extent-uncertain result.

For box diagnostics, the best proposal bounding-box IoUs against each independent instance-mask extent were 0.708; 0.000 and 0.124; 0.957; and 0.741 and 0.962, respectively. The annotation uses the independently supplied mask extent for this component comparison; these figures are not whole-object localization scores.

The replay used input manifest SHA `6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a`, truth SHA `793e26845deaa2cb56748ef270b8cb02877218d680068573f02e5af92b26af6a`, and the frozen DEV2 proposal run (`run-manifest.json` SHA `9e51ecb89e153a79e145ae171884d82373b0d9fb163266ada330c498d484ffe5`). The replay manifest SHA is `5f3547508feef50664f952b1c7ce9a0eb62088a0fd87def670b76e27fc304d95`; independent candidate-universe score SHA is `c0854f7d0be121ff1bf4487b3db7a5b52913bd00f679890e69595f39c21f7189`; selected-mask check SHA is `f8743f6ba9d5d0c07017448df13c339263d15c786ab0fcdc4dc0740d04b8152a`; and the detailed local provenance record SHA is `bda9356fc023448cece843274c147494834be7471ddcb3262f91dc751f2ce9c9`.

All raw candidate masks, metadata and scoring files remain in the ignored local run cache. The diagnostic retains the single-source-family limitation of this DEV subset and is separate from natural-image corpus-diversity claims.
