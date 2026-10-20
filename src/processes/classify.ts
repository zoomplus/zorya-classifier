import type {
  ClassifyInput,
  ClassificationResult,
  DecisionPort,
  DecisionState,
  RasterPort,
} from '../entities/contracts.js'
import { selection, validateDecision } from '../features/choice.js'
import { classificationQuestion } from '../features/prompts.js'
import { assertActive } from '../entities/errors.js'
import type { ImageRepresentationPort } from '../entities/representation.js'

export async function classifyInput(
  input: Omit<ClassifyInput, 'signal'>,
  decision: DecisionPort,
  raster: RasterPort,
  signal: AbortSignal,
  representation?: ImageRepresentationPort,
): Promise<ClassificationResult> {
  const media = typeof input.input === 'string' ? { text: input.input } : input.input
  const state: DecisionState = []
  if (media.text) state.push(media.text)
  if (media.image) {
    const source = await raster.normalize(media.image, signal)
    if (representation) {
      const prepared = await representation.prepare({
        source,
        views: [
          {
            id: 'source',
            role: 'source',
            image: source,
            sourceRegion: { left: 0, top: 0, width: source.width, height: source.height },
          },
        ],
        signal,
      })
      state.push(...prepared.state)
    } else state.push(...(await raster.imageState(source, signal)))
  }
  const request = {
    state,
    questions: { selection: classificationQuestion(input.classes, input.instructions) },
  }
  const result = validateDecision(request, await decision.decide(request, signal))
  assertActive(signal)
  return {
    ...selection(
      result,
      input.classes.map((c) => c.id),
      1,
    ),
    metadata: result.metadata,
  }
}
