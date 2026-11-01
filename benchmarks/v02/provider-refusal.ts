import { z } from 'zod'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const questionIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u)

const providerRefusalObservationSchema = z.discriminatedUnion('protocol', [
  z
    .object({
      protocol: z.literal('openrouter-native-named-refusal-v1'),
      scope: z.literal('question'),
      questionId: questionIdSchema,
      route: z.literal('/api/alpha/decisions'),
      responseStatus: z.union([z.literal(200), z.literal(502)]),
      physicalId: z.number().int().positive(),
      requestSha256: digestSchema,
      requestBodySha256: digestSchema,
    })
    .strict(),
  z
    .object({
      protocol: z.literal('openrouter-chat-message-refusal-v1'),
      scope: z.literal('request'),
      route: z.literal('/api/v1/chat/completions'),
      responseStatus: z.literal(200),
      physicalId: z.number().int().positive(),
      requestSha256: digestSchema,
      requestBodySha256: digestSchema,
    })
    .strict(),
])

export type ProviderRefusalObservation = z.infer<typeof providerRefusalObservationSchema>

interface ProviderRoute {
  model: string
  provider: string
  providerName: string
  apiEndpoint: string
  allowFallbacks: false
}

interface ObservationBinding {
  physicalId: number
  requestSha256: string
  requestBodySha256: string
}

const nativeErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.literal(502),
        message: z.string(),
      })
      .strict(),
  })
  .strict()

const nativeTypedRefusalSchema = z
  .object({
    answers: z
      .array(
        z
          .object({
            type: z.literal('refusal'),
            name: questionIdSchema,
          })
          .strict(),
      )
      .length(1),
  })
  .passthrough()

const chatRefusalSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                refusal: z.string().min(1),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .length(1),
  })
  .passthrough()

const nativeRequestQuestionSchema = z.object({ questions: z.record(z.unknown()) })

const pinnedRequestSchema = (route: ProviderRoute) => {
  const providerSchema =
    route.apiEndpoint === '/api/alpha/decisions'
      ? z
          .object({
            only: z.array(z.literal(route.provider)).length(1),
            allow_fallbacks: z.literal(false),
          })
          .strict()
      : z
          .object({
            only: z.array(z.literal(route.provider)).length(1),
            allow_fallbacks: z.literal(false),
            require_parameters: z.literal(true),
            sort: z.enum(['latency', 'throughput']).optional(),
          })
          .strict()
  const schema = z
    .object({
      model: z.literal(route.model),
      provider: providerSchema,
    })
    .passthrough()
  return schema
}

function isNativeRoute(route: ProviderRoute): boolean {
  return (
    route.model === 'openai/gpt-6-luna-decisions' &&
    route.provider === 'openai' &&
    route.providerName === 'OpenAI' &&
    route.apiEndpoint === '/api/alpha/decisions' &&
    route.allowFallbacks === false
  )
}

function isChatRoute(route: ProviderRoute): boolean {
  return (
    route.model === 'openai/gpt-6-luna' &&
    route.provider === 'openai' &&
    route.providerName === 'OpenAI' &&
    route.apiEndpoint === '/api/v1/chat/completions' &&
    route.allowFallbacks === false
  )
}

function observation(
  value: z.input<typeof providerRefusalObservationSchema>,
): ProviderRefusalObservation | undefined {
  const parsed = providerRefusalObservationSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** Recognize only the frozen refusal envelopes on their exact configured routes. */
export function observeProviderRefusal(input: {
  body: unknown
  dispatchedUrl: string
  dispatchedMethod: string
  dispatchedBody: string
  route: ProviderRoute
  status: number
  responseDisposition: string | null
  requestedQuestionIds: readonly string[]
  binding: ObservationBinding
}): ProviderRefusalObservation | undefined {
  const {
    body,
    dispatchedUrl,
    dispatchedMethod,
    dispatchedBody,
    route,
    status,
    responseDisposition,
    requestedQuestionIds,
    binding,
  } = input
  const nativeRoute = isNativeRoute(route)
  const chatRoute = isChatRoute(route)
  if (!nativeRoute && !chatRoute) return undefined
  if (dispatchedMethod !== 'POST') return undefined
  let url: URL
  try {
    url = new URL(dispatchedUrl)
  } catch {
    return undefined
  }
  const expectedPath = nativeRoute ? '/api/alpha/decisions' : '/api/v1/chat/completions'
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'openrouter.ai' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== expectedPath
  )
    return undefined
  let dispatchedRequest: unknown
  try {
    dispatchedRequest = JSON.parse(dispatchedBody)
  } catch {
    return undefined
  }
  const pinnedRequest = pinnedRequestSchema(route).safeParse(dispatchedRequest)
  if (!pinnedRequest.success) return undefined
  if (nativeRoute) {
    const nativeRequest = nativeRequestQuestionSchema.safeParse(dispatchedRequest)
    if (!nativeRequest.success) return undefined
    if (status === 502) {
      const parsed = nativeErrorEnvelopeSchema.safeParse(body)
      if (!parsed.success) return undefined
      const questionId = requestedQuestionIds.find(
        (candidate) =>
          questionIdSchema.safeParse(candidate).success &&
          Object.hasOwn(nativeRequest.data.questions, candidate) &&
          parsed.data.error.message === `OpenAI refused to answer question "${candidate}"`,
      )
      if (!questionId) return undefined
      return observation({
        protocol: 'openrouter-native-named-refusal-v1',
        scope: 'question',
        questionId,
        route: '/api/alpha/decisions',
        responseStatus: 502,
        ...binding,
      })
    }
    if (status !== 200) return undefined
    if (responseDisposition !== 'typed-decisions-response') return undefined
    const parsed = nativeTypedRefusalSchema.safeParse(body)
    if (!parsed.success) return undefined
    const [answer] = parsed.data.answers
    if (
      !answer ||
      !requestedQuestionIds.includes(answer.name) ||
      !Object.hasOwn(nativeRequest.data.questions, answer.name)
    )
      return undefined
    return observation({
      protocol: 'openrouter-native-named-refusal-v1',
      scope: 'question',
      questionId: answer.name,
      route: '/api/alpha/decisions',
      responseStatus: 200,
      ...binding,
    })
  }
  if (chatRoute && status === 200 && responseDisposition === 'chat-refusal') {
    const parsed = chatRefusalSchema.safeParse(body)
    const refusal = parsed.success ? parsed.data.choices[0]?.message.refusal : undefined
    if (!refusal || refusal.trim().length === 0) return undefined
    return observation({
      protocol: 'openrouter-chat-message-refusal-v1',
      scope: 'request',
      route: '/api/v1/chat/completions',
      responseStatus: status,
      ...binding,
    })
  }
  return undefined
}
