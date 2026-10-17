# Original support-intent text fixtures

This directory contains 30 original assistant-authored messages, written for this task on 2026-10-18. They are synthetic fixtures, not customer records or an external real-world corpus. The assistant also authored the expected labels and reasons; no independent human ground truth or human adjudication is claimed. No external model/provider calls were used to create or label these examples.

| Split | Total | Per class | Russian | English |
| --- | ---: | ---: | ---: | ---: |
| dev | 10 | 2 | 5 | 5 |
| heldout | 20 | 4 | 10 | 10 |

The five classes are `order_status`, `refund`, `technical_support`, `general_feedback`, and `unknown`. The shared definitions and ordered routing rules are in `inputs/policy.json`. The full `text-manifest.json` also records them, but is **evaluator-only**, because it contains expected labels and reasons. Negated/resolved/hypothetical requests and unadopted quoted speech do not count as current requests. Two active service classes without an exclusive priority produce `unknown`; ordering two tasks does not remove either. Feedback does not override a single active service request. Refund-status questions are `refund`, while a request to fix the tracking website is `technical_support`.

Producer files are physically separated from evaluator labels:

- `inputs/policy.json`: shared task, routing rules and the five class definitions; no example labels or rationales.
- `inputs/dev.json` and `inputs/heldout.json`: ordered arrays whose rows contain **only `text`**.
- `ground-truth/dev.json` and `ground-truth/heldout.json`: evaluator-only labels, rationales and metadata. Each `input_index` is the zero-based row index in its corresponding input array; verify the exact text hash before scoring.
- `text-manifest.json`: complete evaluator-only provenance/label manifest; never load it in the model-request producer.

Pass **only the selected input row's `text` plus `inputs/policy.json`** to the classifier. The class definitions necessarily describe the taxonomy, but contain no answers for individual examples. Keep ground-truth files, the full manifest, labels, reasons, IDs, split, tags, row indices and hashes outside model inputs. Use dev for development and reserve heldout for evaluation after freezing the policy/prompt. The split was assigned during joint authoring; it is not independently hidden and does not establish statistical representativeness. Report per-class confusion counts and raw mistakes, not only aggregate accuracy. No classifier has been evaluated by this authoring task.

`text_sha256` hashes the exact UTF-8 message without adding a newline. `validation.json` records structural checks of counts, IDs, languages and hashes; it is not a model-quality or independent-label-validation report.

## License and provenance

The original fixture texts, policy, explanations and accompanying documentation in this directory are offered under the [MIT License](LICENSE), to the extent copyright or other licensable rights exist. This notice does not assert that AI-generated material has copyright protection in any particular jurisdiction. No external web text, image, customer message or third-party dataset content is included. This license applies only to these original text artifacts and cannot relicense any photographs supplied elsewhere.

## Open Images: separate photo licensing evidence

The official [Open Images V7 licensing statement](https://storage.googleapis.com/openimages/web/factsfigures_v7.html) describes annotations as CC BY 4.0 and lists images as CC BY 2.0, while requiring users to verify individual photo licenses themselves. The official [download documentation](https://storage.googleapis.com/openimages/web/download_v7.html) provides image metadata including original URLs, author/title and license fields. A code repository license or a mirror's public accessibility does not itself license every photo. These pages were checked on 2026-10-18; no photographs were downloaded or licensed by this text task.

For every redistributed photograph, retain the Open Images ID/split, original landing page and direct download URLs, creator name/profile URL, title when available, exact photo-license URI/version, retrieval date, saved original-page/API license evidence and its SHA256, the downloaded asset SHA256/size/dimensions, any crop/resize/transformation record, and an attribution entry distributed with the image. Dataset metadata is useful provenance, but unresolved original-photo licensing should remain unverified. Keep photo licenses and any imported annotation license separate from this directory's MIT notice. This is an evidence checklist, not a legal opinion or a claim that any selected photo was verified here.
