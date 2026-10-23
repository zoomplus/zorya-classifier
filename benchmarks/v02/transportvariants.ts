export type TransportVariantId = 'low-json-schema' | 'none-json-schema'

interface TextTransportVariant {
  id: TransportVariantId
  responseFormat: 'json-schema'
  reasoningEffort: 'low' | 'none'
}

export const textTransportVariants: Readonly<Record<TransportVariantId, TextTransportVariant>> =
  Object.freeze({
    'low-json-schema': {
      id: 'low-json-schema',
      responseFormat: 'json-schema',
      reasoningEffort: 'low',
    },
    'none-json-schema': {
      id: 'none-json-schema',
      responseFormat: 'json-schema',
      reasoningEffort: 'none',
    },
  })
