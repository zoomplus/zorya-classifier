import type { Representation } from '../entities/contracts.js'
import { ClassifierError } from '../entities/errors.js'
import type { ImageRepresentationPort } from '../entities/representation.js'
import { preparedTextSchema, representationLimits } from '../entities/representation.js'
import { parse } from '../entities/contracts.js'

export function createClassifierRepresentation(experimental: ImageRepresentationPort | undefined): {
  representationFor(value: Representation | undefined): ImageRepresentationPort | undefined
} {
  const textRepresentation: ImageRepresentationPort | undefined = experimental
    ? {
        async prepare(input) {
          const result = parse(
            preparedTextSchema,
            await experimental.prepare(input),
            'INVALID_RESPONSE',
          )
          const bytes = result.state.reduce((sum, part) => sum + Buffer.byteLength(part, 'utf8'), 0)
          if (bytes > representationLimits.totalBytes || bytes !== result.metadata.bytes)
            throw new ClassifierError(
              'INVALID_RESPONSE',
              'Representation byte accounting is inconsistent',
            )
          return {
            state: result.state,
            metadata: {
              ...result.metadata,
              views: result.metadata.views.map(({ content, ...view }) => ({
                ...view,
                ...(content === undefined ? {} : { content }),
              })),
            },
          }
        },
      }
    : undefined
  function representationFor(
    value: Representation | undefined,
  ): ImageRepresentationPort | undefined {
    if (value?.type !== 'experimental-text') return undefined
    if (!textRepresentation)
      throw new ClassifierError(
        'UNSUPPORTED',
        'No text-image profile has passed release qualification yet',
      )
    return textRepresentation
  }
  return { representationFor }
}
