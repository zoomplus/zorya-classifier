# Development photo manifests

This folder contains metadata only: a 20-case provider-input allowlist, independent evaluation truth, and per-image source/license ledger. The 20 JPEGs and source-sized mask PNGs are not included; they remain under gitignored `benchmarks/cache/v02/corpus/` and are addressed by hashes and relative paths in these records.

The source annotations (boxes, image-level verification labels and instance masks) are from Open Images V5 validation and CC BY 4.0. Each photo has a separate CC BY 2.0 declaration and page-specific Flickr evidence in `source-ledger.json`. This is not a claim that the Flickr user owns the photo. Open Images and the image author/rights holder are not affiliated with this library.

The manifest lists 16 positive and 4 explicit human-verified absent targets. A missing source label is never used as an absent case. Five positive dev cases include seven official reference mask instances, normalized by nearest-neighbor scaling to the downloaded image raster. Evaluator truth must never be serialized in a producer request.
