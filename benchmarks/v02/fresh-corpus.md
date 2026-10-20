# Fresh producer input boundary

`loadFreshCorpus({manifests:[{path,sha256}],imageRoot},signal)` reads explicitly pinned producer arrays for photographs, maps or UI captures. It accepts at most six manifests and 120 unique case IDs. Each file is bounded to 1 MiB and read through one descriptor; a hash mismatch, additional field or duplicate ID rejects the run before paid dispatch. There is no ground-truth or source-ledger input.

The array schema is the acquired corpus's strict `{caseId,image,locate,classify}` shape. `image` contains the relative asset path, SHA256 and dimensions. `locate` contains the target and optional authored instruction. `classify` contains an optional question and the exact closed options `present,absent`.

`loadFreshImage(case,imageRoot,signal)` separately checks the canonical image path remains inside the configured root, reads bounded owned bytes, verifies the pinned SHA256 and verifies a single PNG/JPEG/WebP raster's dimensions. The source must already have normal EXIF orientation, matching these independently annotated corpora. No resize, crop or label-dependent preprocessing occurs in the loader. Each returned buffer belongs to its caller; do not retain a full corpus of decoded images in the runner.

Use `freshProducerTask(case)` to obtain only `{target,instruction?,question,classes}` for a model task. Keep `caseId`, paths, hashes, split and provenance in the controller's immutable run manifest. A case ID can reveal a positive/negative label; forwarding the whole controller case to a provider is forbidden. Evaluators read labels in a separate step after predictions have been frozen.

The loader does not dispatch requests or qualify a method. Offline tests exercise byte/hash/dimension checks, cancellation, traversal and duplicate rejection, model-facing field separation, and symlink escape rejection (the latter is skipped on unprivileged Windows hosts, where creating the test symlink is not assumed).
