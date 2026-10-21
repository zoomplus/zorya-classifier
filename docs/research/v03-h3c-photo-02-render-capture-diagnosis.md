# H3c photo-02 capture-only render diagnosis

This post-run diagnostic reconstructs the exact H3c final-verifier presentation for `pilot-v03-photo-02`. It is not a provider replay, evaluator annotation, prompt experiment, or change to the closed H3c run.

## Frozen inputs and execution

- Source: `benchmarks/v02/corpus/dev/inputs.json` photo `4f05ad23beaefd46`; SHA-256 `ad0eb4bf4a6c2c1be585846a943aa06ec2440696b7e8874374904eb25dcc594a`.
- Selected candidate: the unchanged H3b `C00` mask used by H3c; mask PNG SHA-256 `1680deae5eda207cc9b5958dd2fb08864e7987fd8065284a754e2a2909654db3`.
- Target and selection: `Bird`, `C00`; H3c's closed verifier answer was `match-incomplete`. Its recorded source-space box was `{ left: 357, top: 227, width: 342, height: 223 }`.
- The actual `createH3cVerifier` and `createSharpRaster().imageState` were called locally. A capturing `DecisionPort` returned a valid synthetic `unknown`; no provider, API credential, or native model was used.
- The source bytes were retrieved from the existing Open Images validation URL and verified against the frozen corpus hash before reconstruction. The eight captured images and the summary outputs are kept outside this repository under `/tmp/h3c-photo-02-capture/`.

## Correspondence checks

The four verifier inputs were the untouched full source, clean context crop, cyan mask overlay with magenta deterministic witness, and neutral-gray masked cutout. All four corresponding `imageState` prepared PNGs have the same dimensions and exact RGBA pixels as their respective verifier inputs. Captures and checksums are persisted under the ignored worktree path `.run/v03/h3c-photo-02-capture/`:

| View          | Input and prepared dimensions | RGBA SHA-256                                                       | Prepared matches input |
| ------------- | ----------------------------- | ------------------------------------------------------------------ | ---------------------- |
| Full source   | 1024×683                      | `c83fa4a1b5d82888d1c130ee1e25d1c63040faa18352f71a385611b507cf9d39` | Yes                    |
| Clean context | 684×447                       | `7189daa8c6aa9ce03ffe91f3ae56dc9b26b195ab8809c5d0d25e84e31846e3eb` | Yes                    |
| Mask overlay  | 684×447                       | `5e3b5e8ab4b4a781309e13750653bc2815e29d20b3274d63621d4decbb6fcac9` | Yes                    |
| Masked cutout | 684×447                       | `7490c125732e962b10d5a9998b81862692586e9bc123a0376212b5084ba79ec7` | Yes                    |

All transforms are identity (scale 1, no padding). The renderer therefore preserves the source, crop, overlay, and cutout correspondence exactly in this case. This local check cannot establish rendering correctness on the other eleven images.

## Interpretation

The source and clean crop make the requested bird readily identifiable. The dark diagonal branch crossing its body is an occluder: a gap in the extracted foreground at the occlusion is correct, and the lower-right disconnected visible piece appears consistent with the bird's tail. These are not, by themselves, material omissions or contamination. The output is not evidence of a color, alpha, resize, or source/mask coordinate defect. H3c's `match-incomplete` answer therefore raises a plausible question about how strongly its absolute completeness wording treats occlusion and disconnected visible components; the reconstruction alone does not prove the answer wrong. The independently reported H3c metrics for this candidate remain IoU `0.902043`, box IoU `0.953923`, and target coverage above `0.90`.

For the next relative-selection profile, judge visible source pixels, permit occlusion-created gaps and separated visible components, and tolerate ordinary small contour deviations, antialiasing, and holes. Still reject material omissions of visible target pixels or substantial unrelated foreground/background. Keep the predeclared quantitative evaluator gates unchanged, and do not adjust prompt or threshold per case.

The manifest SHA-256 is `f387f71a84ffb6a73f60cdb12e55531c94f2f94b2b05bfa58f8d3da6e6beb1fb`; the pixel-correspondence report SHA-256 is `f509fa94fcee5e77a06c27fb1442e7363c5c4a55fd15aa1437a36b97d4379337`. The four captured views are `01-full.png`, `02-clean-context.png`, `03-mask-overlay.png`, and `04-mask-cutout.png`, with `-prepared.png` counterparts. The files remain ignored by Git and are available for root review at the worktree path above.
