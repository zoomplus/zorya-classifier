# Public API

`createClassifier({ decision, timeoutMs?, concurrency?, maxQueue?, refinement? })` creates an owned client. Defaults: 45,000ms absolute budget including queue/image work/provider work; two active operations; sixteen waiters. Configured maxima: 120s, four active,32 queued. Input images are at most16MiB and16,777,216 decoded pixels; single PNG/JPEG/WebP only. The adapter accepts prepared PNG/JPEG with sides280..1568 and a32MiB total request cap. Byte inputs are copied before the first await, including Buffer views.

`classify({ input, classes, instructions?, signal? })`: input is a string or `{ text?, image? }` with at least one field. Classes are2..255 distinct IDs plus descriptions. IDs match `[a-zA-Z][a-zA-Z0-9_-]*`; descriptions at most300 chars. Text is at most32,000 chars, custom instructions4,000. Define explicit none/other behavior in your classes. Result: `choice` (stable maximum), `nativeChoice`, raw `probabilities`, optional native `confidence`, `tied`, and metadata. A low categorical maximum is valid; confidence is not a calibrated spatial guarantee.

`locate({ image, target, exclusions?, roi?, signal? })`: target at most2,000 chars; up to16 exclusions of500 chars. ROI uses integer `left/top/width/height` in EXIF-oriented source pixels. Return coordinates reference that oriented image; metadata names this space and dimensions. Rectangles include left/top and exclude right/bottom. Normalized rectangle fields are divided by image dimensions. Tiny/impossible bounded grids return `unknown/layout-limit`.

`located` returns a selected grid region, normalized region, third-stage selection evidence and optional refinement. `not-found/absent-in-evaluated-region` is based on the initial independent presence check. A target missing from later shortlisted cells yields `unknown/candidate-union-empty`, not global absence. Noul0.5 abstains; contradictory presence/Choice returns unknown. Multiple physical matching objects are permitted; this is an any-instance locator.

The algorithm searches4×4 coarse cells, keeps four source-distinct maxima, pads each by half a coarse cell within ROI, partitions each into at most49 fine cells (global≤196, side≤256), then compares the four best fine cells as enlarged A–D/none. Edges count as matches. Scores/rank hints are not sent to the final comparison. No cell-center correction is presented as object segmentation.

`RefinementPort.refine({ image, target, region, signal })` is optional trusted code. It receives a private oriented-source byte copy. A returned refined rectangle must fit the source and intersect the selected cell. It does not replace the original area evidence. No built-in heavy refiner is downloaded.

`dispose()` cancels current/queued work, rejects further calls and waits for physical settlement. Injected ports must honor cancellation. Native image work retains its concurrency slot until completion, even if cancellation has already been requested.

`ClassifierError.code`: INVALID_INPUT, INVALID_RESPONSE, TIMEOUT, ABORTED, CAPACITY, DISPOSED, PROVIDER, AUTHENTICATION, UNSUPPORTED, RESOURCE_LIMIT. Transport failures throw; they are not successful negative classifications. Provider metadata uses null for unknown model/provider/request/cost. Localization adds knownCostUsd and unknownCostCount; knownCostUsd alone is not a complete bill when unknownCostCount>0.

`createOpenRouterJev({ apiKey, fetch?, maxRequestBytes?, maxResponseBytes? })`: fixed endpoint/model/provider, no automatic fallback/retry. Lower request/response caps can be supplied; response defaults1MiB. Direct port calls require the caller to supply a deadline-bound signal. The top-level client supplies it. The port accepts only top-level inline image parts, not remote URLs.

## Quantized Jev Choice responses

The OpenRouter adapter observed Jev 1.14 rounding scores to a 0.01 lattice: a real 153-option response sums to 0.99. Such values remain raw; they are never renormalized. For non-unit mass the adapter accepts only finite [0,1] values on that lattice whose clipped half-step intervals jointly admit total probability 1, and adds `probabilityRoundingStep: 0.01`. Complete option keys and the native maximum remain mandatory.

A custom `DecisionPort` without this explicit annotation must provide unit mass within floating-point tolerance. The annotation describes transport quantization, not calibration or confidence; many tied zeros can be compatible with rounding at high class counts and convey no ranking information. Stable input-order tie selection still applies. The result preserves both the native choice and our deterministic choice.
