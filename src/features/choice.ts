import type {
  ChoiceAnswer,
  ChoiceSelection,
  DecisionRequest,
  DecisionResult,
} from '../entities/contracts.js'
import { decisionResultSchema, parse } from '../entities/contracts.js'
import { ClassifierError } from '../entities/errors.js'
import { acceptsChoiceMass } from '../shared/choice-mass.js'

function selectChoice(answer: ChoiceAnswer, keys: readonly string[]): ChoiceSelection {
  if (
    keys.length < 2 ||
    new Set(keys).size !== keys.length ||
    Object.keys(answer.probabilities).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(answer.probabilities, k))
  )
    throw new ClassifierError('INVALID_RESPONSE', 'Incomplete Choice distribution')
  const probabilities = keys.map((k) => answer.probabilities[k] ?? NaN)
  if (!acceptsChoiceMass(probabilities, answer.probabilityRoundingStep))
    throw new ClassifierError('INVALID_RESPONSE', 'Invalid Choice distribution')
  const max = Math.max(...probabilities)
  if (!keys.includes(answer.choice) || answer.probabilities[answer.choice] !== max)
    throw new ClassifierError('INVALID_RESPONSE', 'Native Choice contradicts maximum probability')
  const tied = keys.filter((k) => answer.probabilities[k] === max)
  const choice = tied[0]
  if (!choice) throw new ClassifierError('INVALID_RESPONSE', 'Choice has no winner')
  return {
    choice,
    nativeChoice: answer.choice,
    probabilities: { ...answer.probabilities },
    tied,
    ...(answer.probabilityRoundingStep === undefined
      ? {}
      : { probabilityRoundingStep: answer.probabilityRoundingStep }),
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
  }
}
export function validateDecision(request: DecisionRequest, value: unknown): DecisionResult {
  const result = parse(decisionResultSchema, value, 'INVALID_RESPONSE')
  const keys = Object.keys(request.questions)
  if (Object.keys(result.answers).length !== keys.length)
    throw new ClassifierError('INVALID_RESPONSE', 'Question count mismatch')
  for (const key of keys) {
    const question = request.questions[key],
      answer = result.answers[key]
    if (!question || !answer || question.type !== answer.type)
      throw new ClassifierError('INVALID_RESPONSE', 'Question and answer types differ')
    if (question.type === 'choice' && answer.type === 'choice')
      selectChoice(answer, Object.keys(question.criteria))
  }
  return result
}
export function selection(result: DecisionResult, keys: readonly string[]): ChoiceSelection {
  const answer = result.answers['selection']
  if (!answer || answer.type !== 'choice')
    throw new ClassifierError('INVALID_RESPONSE', 'Missing selection')
  return selectChoice(answer, keys)
}
export function presence(result: DecisionResult): number {
  const answer = result.answers['presence']
  if (!answer || answer.type !== 'noul')
    throw new ClassifierError('INVALID_RESPONSE', 'Missing independent presence')
  return answer.noul
}
