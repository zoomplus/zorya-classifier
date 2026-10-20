import { performance } from 'node:perf_hooks'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../../src/entities/contracts.js'
import { decisionResultSchema } from '../../src/entities/contracts.js'
import { ClassifierError } from '../../src/entities/errors.js'
import { selection, validateDecision } from '../../src/features/choice.js'

const presenceCriteria = Object.freeze({
  present: 'The exact proposition in the question instructions is true.',
  absent: 'The exact proposition in the question instructions is false.',
  unknown: 'The available evidence is insufficient to decide the exact proposition.',
})

/** Convert a NoUL proposition to one closed categorical Choice question. */
export function categoricalPresenceRequest(request: DecisionRequest): {
  choice: DecisionRequest
  categorical: DecisionRequest
} {
  const choiceQuestions: DecisionRequest['questions'] = {}
  const categoricalQuestions: DecisionRequest['questions'] = {}
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === 'choice') {
      choiceQuestions[id] = structuredClone(question)
      continue
    }
    if (question.type !== 'noul')
      throw new ClassifierError('INVALID_INPUT', 'Unsupported decision question type')
    categoricalQuestions[id] = {
      type: 'choice',
      rankingSize: 1,
      instructions:
        'Judge the exact proposition stated in the original question instructions. Choose present only when that proposition is true, absent only when it is false, and unknown when the available evidence is insufficient. Do not infer a numeric score or replace the proposition with a different one.\n\nExact proposition:\n' +
        question.instructions,
      criteria: { ...presenceCriteria },
    }
  }
  if (Object.keys(choiceQuestions).length + Object.keys(categoricalQuestions).length === 0)
    throw new ClassifierError('INVALID_INPUT', 'At least one decision question is required')
  return {
    choice: { state: structuredClone(request.state), questions: choiceQuestions },
    categorical: { state: structuredClone(request.state), questions: categoricalQuestions },
  }
}

function validatedChoiceResult(request: DecisionRequest, result: unknown): DecisionResult {
  return validateDecision(request, result)
}

function categoricalResult(request: DecisionRequest, value: unknown): DecisionResult {
  const result = validatedChoiceResult(request, value)
  const answers: DecisionResult['answers'] = {}
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type !== 'choice')
      throw new ClassifierError('INVALID_INPUT', 'Categorical presence request must use Choice')
    const selectionResult: DecisionResult = {
      answers: { selection: result.answers[id]! },
      metadata: result.metadata,
    }
    const selected = selection(selectionResult, Object.keys(question.criteria), 1).choice
    if (selected !== 'present' && selected !== 'absent' && selected !== 'unknown')
      throw new ClassifierError('INVALID_RESPONSE', 'Categorical Choice returned an unknown label')
    answers[id] = { type: 'presence', presence: selected }
  }
  return { answers, metadata: result.metadata }
}

/**
 * Caller-owned experiment composition. Ordinary spatial Choice goes to choicePort;
 * binary NoUL questions are translated to categorical Choice before categoricalPort
 * (and therefore before any recorder wrapping that port) receives the request.
 */
export function createCategoricalPresencePort(
  choicePort: DecisionPort,
  categoricalPort: DecisionPort,
): DecisionPort {
  if (!choicePort || typeof choicePort.decide !== 'function')
    throw new ClassifierError('INVALID_INPUT', 'Choice DecisionPort is required')
  if (!categoricalPort || typeof categoricalPort.decide !== 'function')
    throw new ClassifierError('INVALID_INPUT', 'Categorical DecisionPort is required')

  return {
    async decide(request, signal): Promise<DecisionResult> {
      const partitions = categoricalPresenceRequest(request)
      const choiceCount = Object.keys(partitions.choice.questions).length
      const categoricalCount = Object.keys(partitions.categorical.questions).length
      if (choiceCount === 0) {
        const response = await categoricalPort.decide(partitions.categorical, signal)
        return categoricalResult(partitions.categorical, response)
      }
      if (categoricalCount === 0)
        return validatedChoiceResult(
          partitions.choice,
          await choicePort.decide(partitions.choice, signal),
        )

      const started = performance.now()
      const choiceController = new AbortController()
      const categoricalController = new AbortController()
      const abortBoth = (reason: unknown): void => {
        if (!choiceController.signal.aborted) choiceController.abort(reason)
        if (!categoricalController.signal.aborted) categoricalController.abort(reason)
      }
      const parentAbort = (): void => abortBoth(signal.reason)
      signal.addEventListener('abort', parentAbort, { once: true })
      if (signal.aborted) parentAbort()

      let firstFailure: unknown
      const runLeg = async (
        port: DecisionPort,
        legRequest: DecisionRequest,
        controller: AbortController,
        peer: AbortController,
        categorical: boolean,
      ): Promise<DecisionResult> => {
        try {
          const raw = await port.decide(legRequest, controller.signal)
          return categorical
            ? categoricalResult(legRequest, raw)
            : validatedChoiceResult(legRequest, raw)
        } catch (error) {
          firstFailure ??= error
          if (!peer.signal.aborted) peer.abort(error)
          throw error
        }
      }

      try {
        const settled = await Promise.allSettled([
          runLeg(choicePort, partitions.choice, choiceController, categoricalController, false),
          runLeg(
            categoricalPort,
            partitions.categorical,
            categoricalController,
            choiceController,
            true,
          ),
        ])
        if (firstFailure !== undefined) throw firstFailure
        if (signal.aborted) throw new ClassifierError('ABORTED', 'Decision request was aborted')
        const choice = settled[0]
        const categorical = settled[1]
        if (choice.status === 'rejected') throw choice.reason
        if (categorical.status === 'rejected') throw categorical.reason
        return decisionResultSchema.parse({
          answers: { ...choice.value.answers, ...categorical.value.answers },
          metadata: {
            model: null,
            provider: null,
            requestId: null,
            durationMs: Math.max(0, performance.now() - started),
            costUsd:
              choice.value.metadata.costUsd !== null && categorical.value.metadata.costUsd !== null
                ? choice.value.metadata.costUsd + categorical.value.metadata.costUsd
                : null,
            attempts: choice.value.metadata.attempts + categorical.value.metadata.attempts,
          },
        })
      } finally {
        signal.removeEventListener('abort', parentAbort)
        abortBoth('categorical presence decision complete')
      }
    },
  }
}
