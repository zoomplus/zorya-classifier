# Optional JPEG transport experiment

`opaque-jpeg-if-smaller-v1` is a research-only request transformation. It recompresses opaque PNG views as quality-92 JPEG with 4:4:4 chroma, without resizing or changing any coordinate metadata, question or closed candidate. Transparent PNGs, oriented PNGs whose transform is not baked in, and PNGs already smaller than JPEG remain byte-identical. At most nine images and 64 MiB aggregate decoded input are admitted; per-image library limits still apply. No semantic object analysis is involved.

An offline audit on the twenty licensed development photos and the controlled Geany screenshot found 29,501,430 PNG bytes versus 4,141,846 selected transport bytes across 21 distinct source images. Preparation took approximately 1.09 seconds total on this host while the native soak was running. These figures describe original full-image views, not complete multi-view requests or provider timings. There were zero model requests. They do not establish unchanged visual accuracy or a latency improvement; a separately frozen paired model comparison is required before promotion.

The exact per-image hashes, sizes and timings are retained in the [numeric report](jpeg-transport-offline.json). This helper is excluded from npm's runtime exports and does not alter the public default.
