# Independent H4e SAM2 context-prompt audit

This report evaluates the closed H4e prompt-expansion run as a same-candidate mask-box availability check. It does not evaluate semantic selection, false-positive behavior, or pixel-mask agreement with annotations.

## Frozen identity and artifact checks

The run SHA-256 is `dab327f4ee13af4b5b742e681fd180bbc96372a4669833754f77a3c5f9ea55d4`; its pre-inference freeze SHA-256 is `ea905f6e2468b0776207056d51b6c96d0eed9e6c8a6b2626b388fb14974032a2`. Both bind the same frozen H4a proposal output (`d1ff8a0f…`) and freeze (`30ff2cf2…`), and source screenshot SHA-256 `0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09`. The producer identity and pinned `facebook/sam2-hiera-tiny` model identity were checked. The producer's post-run integrity receipt is unchanged.

The frozen recipe expands each H4a XYXY box by 25% of its original width and height on every side, clips to the 1280×800 source, and prompts one mask per candidate in original order. The evaluator independently recomputed each expanded prompt box. For all 36 outputs it checked mask PNG SHA-256, byte size, source canvas, binary grayscale pixels, foreground pixel count, emptiness, and pixel-derived bounds against the producer descriptor. All 36 actual masks were valid and nonempty. The full [JSON report](../evidence/v03/h4e-sam2-context-prompt-evaluation.json) includes every mask hash and geometry and the per-case/per-candidate box scores.

## Fixed whole-box gate

For each candidate mask, its foreground-pixel bounding box must meet IoU ≥0.50 and reference coverage ≥0.90 against the _same_ authored reference instance. Both conditions must hold on the same candidate/reference pair.

| Case              | Presence | Passing masks among 36 | Best candidate |     IoU | Reference coverage |
| ----------------- | -------- | ---------------------: | -------------: | ------: | -----------------: |
| `pilot-v03-ui-01` | Present  |                      1 |             13 | 0.85684 |            1.00000 |
| `pilot-v03-ui-02` | Present  |                      1 |             14 | 0.95205 |            1.00000 |
| `pilot-v03-ui-03` | Present  |                      1 |             19 | 0.95120 |            0.97222 |
| `pilot-v03-ui-04` | Absent   | 0 scoreable references |              — |       — |                  — |

Thus the H4e masks contain at least one candidate box passing the fixed gate for 3/3 positive queries. All 36 masks also exist for the verified-negative query, but mask availability on an absent query is not a false-positive decision. No selector or final verifier ran in this evaluation, so it makes no claim about whether a candidate would be selected or returned as a location.

This is a four-query screen over one controlled Geany screenshot, with three correlated positive labels and one negative label. The result is not general UI accuracy, production behavior, or qualification evidence. The separate H4d very-large-mask validity investigation remains unresolved; this report does not use it as a quality comparison.

## Reproduction

The independent evaluator was run offline with the Linux Node 24 installation:

```sh
PATH=/root/.nvm/versions/node/v24.12.0/bin:$PATH node --import tsx benchmarks/v03/evaluate-h4e-sam2-context-prompt.ts
```

The implementation reuses the H4d actual-PNG decoding and pixel-geometry validation helper. No provider calls are made during evaluation.
