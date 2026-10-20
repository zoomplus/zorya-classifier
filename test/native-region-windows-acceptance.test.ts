// Include the harness protocol regressions in npm test and both hosted OS jobs.
await import(
  new URL(
    '../benchmarks/v02/native-region-segmentation-windows-acceptance.test.mjs',
    import.meta.url,
  ).href
)
