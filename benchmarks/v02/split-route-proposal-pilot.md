# Split Choice/NoUL caller experiment

This research-only development pilot tests one caller-owned `DecisionPort` that routes `choice` questions to ordinary `openai/gpt-6-sol` chat (`json-schema`, reasoning `none`) and `noul` questions to `openai/gpt-6-luna-decisions` Decisions. Mixed requests execute both injected ports concurrently and merge the closed answers. A mixed result reports null model/provider/request IDs, monotonic elapsed time, total attempts, and a cost only when both route costs are known. Single-group requests pass directly to their assigned port. A failed leg aborts and joins its peer before the operation fails.

The public classifier, frozen MobileSAM proposal backend, target tasks, 8-pixel tolerance, and three extent passes are unchanged. This is a six-case screen over the two named exposed positive photos and four exposed negative photos, with at most two cases in flight and one native worker active with two waiters. The shared budget is 100 physical fetches / $5, reserving $0.05 for each unknown-cost call. No retries, provider fallback, heldout inputs, or evaluator truth are used. Timing is unranked during the concurrent development workload; this screen cannot qualify a release.

Offline checks:

```sh
node --import tsx --test test/split-choice-noul-port.test.ts test/split-route-recording.test.ts
node --import tsx benchmarks/v02/run-split-route-pilot.ts --dry-run
```

The dry run verifies the pinned exposed DEV manifest and six source images without initializing model adapters or making network calls. Paid dispatch requires the experiment owner's separate freeze and go-ahead:

```sh
node --import tsx benchmarks/v02/run-split-route-pilot.ts \
  --allow-paid \
  --encoder=/path/to/mobile_sam_image_encoder.onnx \
  --decoder=/path/to/sam_mask_decoder_multi.onnx \
  --image-root=/path/to/exposed-dev-corpus \
  --out=/path/to/v02-runs
```

Credentials are read only from the configured local environment file, never copied into the manifest or printed. Each case has separate Choice and NoUL recorder directories; both recorders share the run-level physical budget. The single shared MobileSAM adapter is disposed only after both case workers settle.
