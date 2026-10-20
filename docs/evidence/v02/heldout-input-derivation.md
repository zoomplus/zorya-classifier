# HELDOUT producer input derivation

The HELDOUT producer inputs were made loadable without changing the 80 source cases, target identities, image bytes, or oracle records. The conversion reads only source case IDs, image paths/hashes/dimensions, authored prompt fields, and the AbiWord capture generator's ordered planned action names. The case generator supplies planned action names and its original 15/5 ordering; this is authoring metadata, rather than observed model outcomes. No ground-truth files, measured boxes/masks, or image pixels are inspected. The frozen source inputs remain preserved at their original hashes.

The canonical arrays contain 40 photos, 20 AbiWord UI captures, and 20 OpenTTD map captures (80 unique case IDs). `loadFreshCorpus` validated all three pinned arrays with relative image paths. The 80 source images were separately hash-checked against the source manifests without decoding them.

| Input                     | Source SHA-256                                                     | Canonical SHA-256                                                  | Cases |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ----: |
| Photo source manifest     | `f0be4b9b2d5a11bd77f1b890860745c3bf17dd185b5cc1fb73c1af674c9465d5` | `b3afaee883990e01a464929727b7b7bb1315d6e0a70e239a10f20e2f82a3e35b` |    40 |
| AbiWord source JSONL      | `598da2b326e8d4cbedf1ca0517ce6ecccc8d141125ee53a88ef397aa9a5ea0a2` | `ca6b4db64640bf08fffd055c3e7f6e6e85b3cc0c303c1ac8b41690c87a3d4572` |    20 |
| OpenTTD source manifest   | `afb2e521962573709ab25ddf53beab4f17d2e33c74192c4fd9218cc34e03efb3` | `c259be7b00040e0c852d8a75b67655b07b9deffe5e284aca33718a921a1e2b62` |    20 |
| Combined ID/image mapping | —                                                                  | `1d1e2f862f4c3f8b887a07026419ba0a513f67771b0d4485d63ee7532c94e95f` |    80 |

The conversion script SHA-256 is `ab85c7ab2f9c1b36b38479233f5afa272aabefa4f39f4348f00e6bf018dfbf23`; the source UI generator SHA-256 is `0ab479cfe54cef954c340d382088101087bf91cc1698641c52f2324594c0c5f1`. The canonical prompt identity SHA-256 is `281c55d76cae2970099d97c0b6734714bd9343dd710083aebb64c2893834619e`. Full conversion provenance, including the template and UI source-order mapping, is retained in the ignored run artifact `.run/heldout-canonicalization-v3/provenance.json` (SHA-256 `55962b91a5acfbb101c4a5e5b48127aa7ae97622e4c556b7f47e80874598d63d`).

This records input canonicalization only. It does not authorize or record a model dispatch, and it contains no HELDOUT outcomes or truth values.

The recorded conversion used the script first introduced in commit `ec099430888152f8880c92e20013a2ddb73b24da`, whose bytes match the conversion hash above. A later filesystem-error type guard preserves its output. These canonical hashes replace unusable source-oracle hashes in the producer/evaluator phase configuration before any winner freeze or HELDOUT dispatch; the original source pins and provenance remain unchanged.
