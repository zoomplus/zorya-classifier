# Fresh text and no-image DEV profiles

`fresh-text-dev.ts` runs exactly one named profile over the same pinned 20-photo DEV and 10 independent UI DEV inputs as the native run. The six profiles use the frozen `textEncodersV1` registry; `no-image-control` uses the same classifier and whole-object locator inputs while a decision-port wrapper removes only image parts from the provider request. It preserves the same questions, choices, target text and geometry metadata. It does not add an `unknown` classification class. A locator that returns semantic unknown remains an unknown result.

Every profile is an immutable run with an independent 250-physical-fetch/$5 budget, sequential dispatch, no retries or fallback, 45-second operation timeout, 8-pixel extent tolerance and at most three extent passes. The pinned route is DeepSeek Flash through Together. All profiles use `grammar-plus-examples`, the `none-json-schema` transport, 1,024 output tokens for classification and 4,096 for whole-object localization. The synthetic decoder examples are shared across profiles and do not contain benchmark labels or geometry.

Run a single profile explicitly:

```sh
node --import tsx benchmarks/v02/fresh-text-dev.ts --dry-run --profile ascii-luma-v1
node --import tsx benchmarks/v02/fresh-text-dev.ts --allow-paid --profile ascii-luma-v1
```

Replace `ascii-luma-v1` with another registered encoder ID or `no-image-control`. The paid command reads only `OPENROUTER_API_KEY` from the configured private env file and emits only run IDs and aggregate counts to stdout. Producer manifests, image hashes, physical receipts and sanitized request traces remain local in the immutable run directory; truth and evaluator code are never imported or read.
