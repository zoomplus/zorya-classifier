# H5a: native proposal generation closure

**State: complete, availability-only producer run.** This phase replays the closed H3b DINO/SAM2 candidates and adds the frozen OmniParser plus 25%-expanded SAM2 family. It does not select a candidate or make a localization, semantic-quality, or accuracy claim. No evaluator truth was read by the producer, and no paid calls were made.

The exact H5a producer run is `.run/v03/h5a-native-proposals-v2/run.json`, SHA-256 `86d0aab4f7fad3ce0fae182b840ddd540275309471b27cb091dc4e85866d56f0`. Its pre-generation freeze is `.run/v03/h5a-native-proposals-v2/freeze.json`; the run records the source, model, runtime, helper, H3b, H4e, and per-case hashes. The frozen H5a producer SHA-256 is `ae6abe229a4646c87d46f4d3e9a7066503b020bc4b93a86dac9509cd327b52f8`. Runtime, model, and helper receipts matched after generation. The post-run integrity sidecar rehashed 277 frozen/run/source/mask files, including all H3b and reused H4e masks; its SHA-256 is `43b6502dae3a0303a4700cc9692e1cb59a618fa645a110cfd40474f1a4825f50`. The closure sidecar `.run/v03/h5a-native-proposals-v2/worker-closure.json` records eight sequential owned children; each exited successfully and was joined before the parent continued. The four UI cases share one source SHA-256 and reused the already closed H4e mask set, with no new worker. No PID was retained by this producer.

H3b replay is pinned to its exact closed run SHA-256 `df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401` and sealed evaluator wrapper SHA-256 `1dd6408dc1b584ddd884c79ee5c0afea17f85ca3c607e4d3fc2fc6fa602e89d5`. The Omni helper source is pinned at `fd1cc46823913e143219dcb4e2faf28393f21324b146e14d9feebbb6d58d217d`; the frozen model is OmniParser revision `f55d0750e5b94db2125ef0b45b0fa4a85ddc59b4`, 281,182,680 bytes, SHA-256 `11c6cbb77f22569fab22d86c76407a83ec81ab89dbfe28279854822d6e3fb00c`, with its local MIT license receipt pinned. SAM2 Hiera-Tiny revision `7c218beaf0bb87874785f32b582f640134fc1c09` and its twelve model files are hash-checked against the existing asset manifest; H4e's closed UI run SHA-256 is `dab327f4ee13af4b5b742e681fd180bbc96372a4669833754f77a3c5f9ea55d4`.

| Case | H3b DINO/SAM2 masks | Omni/SAM2 masks | Combined packed mask bytes |
| --- | ---: | ---: | ---: |
| Photo 01 | 3 | 0 | 262,272 |
| Photo 02 | 1 | 0 | 87,424 |
| Photo 03 | 7 | 0 | 688,128 |
| Photo 04 | 4 | 0 | 349,696 |
| UI 01 | 9 | 36 | 5,760,000 |
| UI 02 | 8 | 36 | 5,632,000 |
| UI 03 | 8 | 36 | 5,632,000 |
| UI 04 | 9 | 36 | 5,760,000 |
| Map 01 | 8 | 36 | 5,632,000 |
| Map 02 | 12 | 36 | 6,144,000 |
| Map 03 | 9 | 36 | 5,760,000 |
| Map 04 | 7 | 36 | 5,504,000 |

H3b contributes 85 previously frozen candidate masks. The new Omni/SAM2 producer emitted 144 masks across the four distinct map sources, no masks on the four distinct photo sources, and reused H4e's 36-mask UI source once for the four UI case rows. This is candidate count only; it does not say whether any mask matches a target. The independent evaluator has been asked to calculate same-candidate box availability for each family and their union after validating the output hashes.

Eight unique non-UI sources ran sequentially in owned children under the 240-second per-source deadline; all completed. Their combined worker wall time, including process start and local model setup, was 42.32 seconds; each took 4.87–5.78 seconds. Omni forward/postprocess time was 1.90–2.04 seconds per source. SAM2 used one image encode and one serial decode per retained box; all 36 prompts decoded in 0.51–0.71 seconds on sources where Omni returned candidates. Peak VRAM was 1,721,326,592 bytes allocated and 1,805,647,872 bytes reserved. Each case remained below the 19 MiB packed-mask cap, with a maximum of 6,144,000 bytes. These are native-generation measurements only; they do not include any later `DecisionPort` composition.

The initial `h5a-native-proposals-v1` attempt stopped after its first worker because the parent aggregator indexed the optional `timing_ms` object on a worker result with zero Omni candidates. The worker itself had returned and been joined; this was a producer assembly defect, not a detector or SAM2 quality failure. Its freeze, worker log, and exact producer snapshot are preserved under `.run/v03/h5a-native-proposals-v1/`; the recovered snapshot matches the frozen producer SHA-256 `2ec5fd01c12da9fc6f20a5d54f1ab52783077a7d874a1fe519ff86ee75c81a59`. A regression in `test/v03-h5a-native-proposals.test.py` reproduces the v1 `KeyError` for a no-candidate worker, then checks the repaired optional-field initialization. The corrected complete run is separately named v2; v1 evidence was not rewritten.

Validation: five standard-library tests passed, covering the frozen 25%-expansion/clipping transform, invalid boxes, family and packed-mask caps, owned-child cancellation/join, and the v1 no-candidate timing regression. `py_compile` passed for the producer and tests. The producer made no downloads, package changes, provider calls, or evaluator reads. H4e was not rerun: its source-identical UI result was content-hash reused, so its mask hashes remain exactly those in the closed H4e run.
