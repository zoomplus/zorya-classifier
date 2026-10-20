# Fresh DEV MobileSAM proposal run

`run-fresh-proposals.ts` is the source-only producer for one complete 40-case development pass: 20 photos, 10 independently authored UI captures, and 10 independently authored map screenshots. It pins all three producer input arrays, including the revised map input hash. The loader verifies each image's root containment, SHA256, format, orientation, dimensions, and task separation before the runner initializes the provider-facing classifier. It never imports evaluator truth or source ledgers.

The run uses the public `createClassifier({ decision, objectProposals })` composition, the pinned CPU MobileSAM nine-point proposal adapter, and `openai/gpt-6-luna-decisions` through the OpenRouter Decisions endpoint with provider `openai`. Fallbacks and retries are disabled. Classification and whole-object extraction run independently for each image with a 45-second operation deadline, 8-pixel boundary tolerance, and at most three extent passes. Extraction reuses the selected native proposal mask; it does not perform a second proposal inference. The MobileSAM adapter is initialized once and disposed by the runner after all cases. Successful extractions write immutable `mask.u8` (cropped row-major binary bytes) and `cutout.png` files in each case directory. JSON records their hashes, dimensions, source crop, and absolute source offset without embedding pixel arrays. Localization status is recorded independently from extraction status, so a valid whole-object extent remains visible if later cutout processing fails. Mask IoU is evaluated separately from box quality by the downstream evaluator.

The immutable manifest freezes every producer task, all source and dependency hashes, asset hashes, route, prompt, and policy. It retains case IDs, source hashes, dimensions and task descriptions only in local controller artifacts; model requests contain authored task text and image bytes, never case IDs, paths, image hashes, split labels or ground truth. Per-case classification and localization errors stay in the denominator. Interrupted runs retain completed per-case artifacts and have no fabricated complete summary.

The paid profile has one shared maximum of 300 physical fetches and $5, with unknown-cost admissions reserved at $0.02 each. The CLI requires `--allow-paid`; dispatch still requires the experiment owner's separate freeze and smoke clearance. Before dispatch, run the offline checks and the no-fetch preflight:

```sh
node --import tsx --test test/v02-fresh-proposal-runner.test.ts test/v02-fresh-proposal-cli.test.ts test/v02-fresh-proposal-budget.test.ts
node --import tsx benchmarks/v02/run-fresh-proposals.ts --dry-run
```

The paid command takes explicit private model asset paths and writes immutable local artifacts:

```sh
node --import tsx benchmarks/v02/run-fresh-proposals.ts \
  --allow-paid \
  --encoder=/path/to/mobile_sam_image_encoder.onnx \
  --decoder=/path/to/sam_mask_decoder_multi.onnx \
  --image-root=/path/to/fresh-corpus \
  --out=/path/to/v02-runs
```

Do not start it until the owner has approved the exact source, input manifest, and native smoke result. The separate evaluator reads the frozen predictions only after this producer run has closed. The frozen development policy requires one benchmark runner without another owned native stress workload. Start the resource soak and Windows native jobs after this run; its latency eligibility does not apply to later concurrent runs.
