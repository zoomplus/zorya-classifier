# Paired segmentation component comparison

This report compares the pinned MobileSAM and GrabCut components on the same five public development photos. It does not measure end-to-end localization or classifier quality. Each run uses the fixture image, whole-region box, target, and seed directly; no HTTP or model API requests were made.

The first panel preserved the fixture seeds exactly. The Hat seed had no annotated foreground inside it, so I derived a second, explicitly oracle-assisted panel for all five cases. The corrected panel changes only `seedRegion`; image bytes, masks, whole-region boxes, and assets are unchanged. It is a component diagnostic and must not be interpreted as a deployable grounding method.

## Reproducibility

- Base source revision: `c63da6ac24493a1b891fb230528c8d8d76bdd2e9`. The separately frozen seed-derivation helper was added in `ee9fe39645d809021b83f001e167cfa92756f4d4`; the complete manifest below, rather than the base revision alone, identifies the compared files.
- Source manifest SHA-256: `4e0880890385cf535c2c0e8fc7e9d8bb0dd66fb3243af6d4b2811c72d193c00c` (60 files including the source, harness, fixture manifest, and seed derivation helper).
- Original fixture manifest SHA-256: `9d2b4c0fffc06edb5c736c67bfee0b7c2352e1d19764956e5f53a071cea3591b`.
- Corrected seed manifest SHA-256: `cd3acde186eb6e7f0bad3c428a169188ea6306a176a98832457e91b4fb7bcdf5`.
- Corrected seed derivation SHA-256: `bc94dae937cb4da6a1a490fc24e2d2bbc13e99a2303e70ee0320bb6b72d593d3`.
- MobileSAM encoder / decoder SHA-256: `580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749` / `8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe`.
- OpenCV.js 4.13.0 SHA-256: `63366510248adf3a7eddf3e793dd825404efb7df3749f4d6f8557c7fa4ca8aa0`.

The derivation helper uses an exact four-neighbor Manhattan distance transform from each binary mask to its background, including the image exterior. It chooses the first row-major foreground pixel with maximum clearance and centers an odd seed patch on that pixel. The generated derivation record verifies the chosen center is foreground in every case. The corrected seed centers are `06 (494,319)`, `08 (49,486)`, `09 (814,509)`, `13 (134,134)`, and `15 (367,254)`.

## Mask IoU results

The table shows each backend’s mean IoU across its repeated successful masks for that case. All five cases remain visible in both panels.

| Case                         | Foreground pixels in original seed | Corrected seed center | GrabCut original → corrected | MobileSAM original → corrected |
| ---------------------------- | ---------------------------------: | --------------------: | ---------------------------: | -----------------------------: |
| photo-dev-present-06 (Bird)  |                                144 |             (494,319) |                0.553 → 0.553 |                  0.878 → 0.878 |
| photo-dev-present-08 (Bird)  |                                144 |              (49,486) |                0.593 → 0.593 |                  0.859 → 0.859 |
| photo-dev-present-09 (Knife) |                                144 |             (814,509) |                0.750 → 0.750 |                  0.943 → 0.943 |
| photo-dev-present-13 (Hat)   |                                  0 |             (134,134) |                0.000 → 0.545 |                  0.670 → 0.670 |
| photo-dev-present-15 (Cat)   |                                 45 |             (367,254) |                0.531 → 0.531 |                  0.947 → 0.947 |

Across the five cases, mean per-case IoU was GrabCut 0.486 with the original seeds and 0.595 with corrected seeds; MobileSAM was 0.859 in both panels. At IoU ≥0.8, GrabCut reached 0/5 cases in either panel and MobileSAM 4/5. The original Hat result is retained: its seed contained zero ground-truth foreground pixels, so that result is not a valid semantic-grounding comparison. Cat’s original seed intersects its mask in 45 pixels while its center is outside the mask; the corrected panel uses the deterministic interior center and leaves Cat’s source/mask untouched.

## Run outcomes and limits

| Panel / backend       | Configured busy window | Segmented / unknown / failed | Owned child starts / closes / still owned |
| --------------------- | ---------------------: | ---------------------------: | ----------------------------------------: |
| Original / GrabCut    |                   60 s |                   21 / 0 / 0 |                               21 / 21 / 0 |
| Original / MobileSAM  |                   60 s |                   43 / 0 / 0 |                               43 / 43 / 0 |
| Corrected / GrabCut   |                   60 s |                   22 / 0 / 0 |                               22 / 22 / 0 |
| Corrected / MobileSAM |                   60 s |                   43 / 0 / 0 |                               43 / 43 / 0 |

Each harness run also passed its synthetic positive control, absent-target control, cancellation, capacity rejection, invalid-input, missing-asset, and repeated-disposal checks. No native children remained owned in any report. The harness aggregate retains per-case successful IoU observations but only overall status totals; consult the raw reports for those complete totals and lifecycle/resource samples.

These short comparison windows use the older harness's wall-clock configuration. They are not independent physical-duration evidence and do not replace the separate monotonic two-hour resource acceptance.

Runs were serialized by backend, but overlapped the separately running public-path MobileSAM soak and other disclosed CPU screening. Operation counts and latencies are therefore non-ranking evidence. Repeated reported mask IoU values were identical within each panel; the aggregate does not retain every mask byte. The sample is small and development-only; the results support comparing these components under this supplied geometry, not a general backend guarantee.

## Raw artifacts

The immutable JSON reports, generated corrected panel and per-case derivation are under `.run/v02/paired-components-c63da6/` in the `native-compare` worktree. Raw report SHA-256 values:

- Original GrabCut: `62c87a8781763f82302105e8ab1ce9a204848cdda8e7e21915347055e6d1cfc5`.
- Original MobileSAM: `224206002e42152b178d35a3418177a45eba70be32eaddb3dd83a136a83a2c57`.
- Corrected GrabCut: `57c1952428665c6b9c893ec0e680812d10bef5a4752f86223815635e760dd864`.
- Corrected MobileSAM: `fca473ef5f4cad5b56e61a0eb828450e3e7e532018332e239f8803f8c55978b6`.
