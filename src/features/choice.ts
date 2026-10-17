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
function selectRanking(
  ranking: readonly string[],
  keys: readonly string[],
  rankingSize = 4,
): ChoiceSelection {
  if (
    keys.length < 2 ||
    ranking.length !== Math.min(rankingSize, keys.length) ||
    new Set(ranking).size !== ranking.length ||
    ranking.some((id) => !keys.includes(id))
  )
    throw new ClassifierError('INVALID_RESPONSE', 'Invalid closed ranking')
  const choice = ranking[0]
  if (!choice) throw new ClassifierError('INVALID_RESPONSE', 'Ranking has no winner')
  return { choice, nativeChoice: null, probabilities: null, ranking: [...ranking], tied: [] }
}
export function validateDecision(request: DecisionRequest, value: unknown): DecisionResult {
  const result = parse(decisionResultSchema, value, 'INVALID_RESPONSE')
  const keys = Object.keys(request.questions)
  if (Object.keys(result.answers).length !== keys.length)
    throw new ClassifierError('INVALID_RESPONSE', 'Question count mismatch')
  for (const key of keys) {
    const question = request.questions[key],
      answer = result.answers[key]
    if (!question || !answer)
      throw new ClassifierError('INVALID_RESPONSE', 'Missing question or answer')
    if (question.type === 'choice') {
      if (answer.type === 'choice') selectChoice(answer, Object.keys(question.criteria))
      else if (answer.type === 'ranked-choice')
        selectRanking(answer.ranking, Object.keys(question.criteria), question.rankingSize ?? 4)
      else throw new ClassifierError('INVALID_RESPONSE', 'Question and answer types differ')
    } else if (answer.type !== 'noul' && answer.type !== 'presence')
      throw new ClassifierError('INVALID_RESPONSE', 'Question and answer types differ')
  }
  return result
}
export function selection(
  result: DecisionResult,
  keys: readonly string[],
  rankingSize = 4,
): ChoiceSelection {
  const answer = result.answers['selection']
  if (!answer) throw new ClassifierError('INVALID_RESPONSE', 'Missing selection')
  if (answer.type === 'choice') return selectChoice(answer, keys)
  if (answer.type === 'ranked-choice') return selectRanking(answer.ranking, keys, rankingSize)
  throw new ClassifierError('INVALID_RESPONSE', 'Missing selection')
}
export function presence(result: DecisionResult): number {
  const answer = result.answers['presence']
  if (!answer) throw new ClassifierError('INVALID_RESPONSE', 'Missing independent presence')
  if (answer.type === 'noul') return answer.noul
  if (answer.type === 'presence')
    return answer.presence === 'present' ? 1 : answer.presence === 'absent' ? 0 : 0.5
  throw new ClassifierError('INVALID_RESPONSE', 'Missing independent presence')
}
