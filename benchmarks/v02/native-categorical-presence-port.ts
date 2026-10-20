import type { DecisionPort, DecisionRequest, DecisionResult } from '../../src/entities/contracts.js'
import { ClassifierError } from '../../src/entities/errors.js'
import { selection, validateDecision } from '../../src/features/choice.js'
import { categoricalPresenceRequest } from './categorical-presence-port.js'

export const nativeCategoricalChoiceProfile = Object.freeze({
  id: 'native-luna-choice-all-stages-categorical-presence-sam-v1',
  route: Object.freeze({
    model: 'openai/gpt-6-luna-decisions',
    provider: 'openai',
    providerName: 'OpenAI',
    apiEndpoint: '/api/alpha/decisions',
    allowFallbacks: false,
    categoricalEncoding: 'closed-choice-present-absent-unknown-v1',
  }),
  policy: Object.freeze({
    timeoutMs: 120_000,
    maxInFlightCases: 2,
    boxTolerancePx: 8,
    maxExtentPasses: 3,
    retries: 0,
    fallback: false,
    maxPhysicalCalls: 100,
    maxCostUsd: 5,
    unknownCostReserveUsd: 0.05,
  }),
  caseIds: Object.freeze([
    'photo-dev-present-01',
    'photo-dev-present-02',
    'photo-dev-absent-01',
    'photo-dev-absent-02',
    'photo-dev-absent-03',
    'photo-dev-absent-04',
  ]),
  inputManifestSha256: '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a',
})

/** Caller-owned one-route experiment; Choice stays Choice and NoUL becomes categorical Choice. */
export function createNativeCategoricalPresencePort(nativePort: DecisionPort): DecisionPort {
  if (!nativePort || typeof nativePort.decide !== 'function')
    throw new ClassifierError('INVALID_INPUT', 'Native DecisionPort is required')

  return {
    async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
      const partitioned = categoricalPresenceRequest(request)
      const questions = {
        ...partitioned.choice.questions,
        ...partitioned.categorical.questions,
      }
      const nativeRequest: DecisionRequest = {
        state: structuredClone(request.state),
        questions,
      }
      const nativeResult = validateDecision(
        nativeRequest,
        await nativePort.decide(nativeRequest, signal),
      )
      const answers: DecisionResult['answers'] = {}
      for (const [id, originalQuestion] of Object.entries(request.questions)) {
        const answer = nativeResult.answers[id]
        if (!answer)
          throw new ClassifierError('INVALID_RESPONSE', 'Native Choice omitted a decision answer')
        if (originalQuestion.type === 'choice') {
          answers[id] = answer
          continue
        }
        if (originalQuestion.type !== 'noul')
          throw new ClassifierError('INVALID_INPUT', 'Unsupported decision question type')
        const convertedQuestion = nativeRequest.questions[id]
        if (convertedQuestion?.type !== 'choice')
          throw new ClassifierError('INVALID_RESPONSE', 'Converted presence question is missing')
        const selected = selection(
          { answers: { selection: answer }, metadata: nativeResult.metadata },
          Object.keys(convertedQuestion.criteria),
          1,
        ).choice
        if (selected !== 'present' && selected !== 'absent' && selected !== 'unknown')
          throw new ClassifierError(
            'INVALID_RESPONSE',
            'Native Choice returned an unknown presence label',
          )
        answers[id] = { type: 'presence', presence: selected }
      }
      return validateDecision(request, { answers, metadata: nativeResult.metadata })
    },
  }
}
