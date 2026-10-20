import { performance } from 'node:perf_hooks'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../../src/entities/contracts.js'
import { decisionResultSchema } from '../../src/entities/contracts.js'
import { ClassifierError } from '../../src/entities/errors.js'

/**
 * Benchmark-only caller composition. Choice questions go to one injected port and
 * NoUL presence questions to another; the library itself never chooses a model.
 */
export function createSplitChoiceNoulPort(
  choicePort: DecisionPort,
  noulPort: DecisionPort,
): DecisionPort {
  if (!choicePort || typeof choicePort.decide !== 'function')
    throw new ClassifierError('INVALID_INPUT', 'Choice DecisionPort is required')
  if (!noulPort || typeof noulPort.decide !== 'function')
    throw new ClassifierError('INVALID_INPUT', 'NoUL DecisionPort is required')

  return {
    async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
      const choiceQuestions: DecisionRequest['questions'] = {}
      const noulQuestions: DecisionRequest['questions'] = {}
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type === 'choice') choiceQuestions[id] = question
        else if (question.type === 'noul') noulQuestions[id] = question
        else throw new ClassifierError('INVALID_INPUT', 'Unsupported decision question type')
      }
      const choiceCount = Object.keys(choiceQuestions).length
      const noulCount = Object.keys(noulQuestions).length
      if (choiceCount === 0 && noulCount === 0)
        throw new ClassifierError('INVALID_INPUT', 'At least one decision question is required')

      const choiceRequest = { state: structuredClone(request.state), questions: choiceQuestions }
      const noulRequest = { state: structuredClone(request.state), questions: noulQuestions }
      if (choiceCount === 0) return noulPort.decide(noulRequest, signal)
      if (noulCount === 0) return choicePort.decide(choiceRequest, signal)

      const started = performance.now()
      const choiceController = new AbortController()
      const noulController = new AbortController()
      const abortBoth = (reason: unknown): void => {
        if (!choiceController.signal.aborted) choiceController.abort(reason)
        if (!noulController.signal.aborted) noulController.abort(reason)
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
      ): Promise<DecisionResult> => {
        try {
          return await port.decide(legRequest, controller.signal)
        } catch (error) {
          firstFailure ??= error
          if (!peer.signal.aborted) peer.abort(error)
          throw error
        }
      }

      try {
        const settled = await Promise.allSettled([
          runLeg(choicePort, choiceRequest, choiceController, noulController),
          runLeg(noulPort, noulRequest, noulController, choiceController),
        ])
        if (firstFailure !== undefined) throw firstFailure
        if (signal.aborted) throw new ClassifierError('ABORTED', 'Decision request was aborted')
        const choiceResult = settled[0]
        const noulResult = settled[1]
        if (choiceResult.status === 'rejected') throw choiceResult.reason
        if (noulResult.status === 'rejected') throw noulResult.reason
        const choice = decisionResultSchema.safeParse(choiceResult.value)
        const noul = decisionResultSchema.safeParse(noulResult.value)
        if (!choice.success || !noul.success)
          throw new ClassifierError(
            'INVALID_RESPONSE',
            'Split DecisionPort returned an invalid result',
          )
        const merged = decisionResultSchema.safeParse({
          answers: { ...choice.data.answers, ...noul.data.answers },
          metadata: {
            model: null,
            provider: null,
            requestId: null,
            durationMs: Math.max(0, performance.now() - started),
            costUsd:
              choice.data.metadata.costUsd !== null && noul.data.metadata.costUsd !== null
                ? choice.data.metadata.costUsd + noul.data.metadata.costUsd
                : null,
            attempts: choice.data.metadata.attempts + noul.data.metadata.attempts,
          },
        })
        if (!merged.success)
          throw new ClassifierError(
            'INVALID_RESPONSE',
            'Split DecisionPort answers could not be merged',
          )
        return merged.data
      } finally {
        signal.removeEventListener('abort', parentAbort)
        abortBoth('split decision complete')
      }
    },
  }
}
