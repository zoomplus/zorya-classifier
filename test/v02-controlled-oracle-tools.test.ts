// Register the source-oracle regressions in the normal cross-platform test run.
await import(
  new URL('../benchmarks/v02/controlled_oracles/validate_evaluator_truth.test.mjs', import.meta.url)
    .href
)
