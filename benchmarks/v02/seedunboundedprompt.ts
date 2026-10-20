import type { DecisionPort, DecisionRequest } from '../../src/entities/contracts.js'

export const seedUnboundedPromptId = 'seed-unbounded-v1' as const
export const seedUnboundedInstruction =
  'The target means the entire visible physical target in ORIGINAL. SEED is only an interior witness for identifying the same instance; the SEED crop boundaries do not limit the target extent. Include every visible part of that same target outside SEED, subject only to HARD_ROI.'

/**
 * Adds one prompt-only instruction to the strict whole-object boundary/identity
 * questions. It does not alter state, criteria, answer schemas, or image parts.
 */
export function withSeedUnboundedPrompt(delegate: DecisionPort): DecisionPort {
  return {
    decide(request: DecisionRequest, signal: AbortSignal) {
      const isExtentRequest = Object.keys(request.questions).some(
        (id) =>
          id === 'instance' || id === 'left' || id === 'right' || id === 'top' || id === 'bottom',
      )
      const questions = Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => [
          id,
          id === 'instance' || id === 'left' || id === 'right' || id === 'top' || id === 'bottom'
            ? {
                ...question,
                instructions: `${question.instructions}\n\n${seedUnboundedInstruction}`,
              }
            : question,
        ]),
      )
      const state = isExtentRequest
        ? request.state.map((part) =>
            typeof part === 'string'
              ? part.replace(
                  'A matching fragment anywhere inside a cell counts; no center requirement.',
                  seedUnboundedInstruction,
                )
              : part,
          )
        : request.state
      return delegate.decide({ state, questions }, signal)
    },
  }
}
