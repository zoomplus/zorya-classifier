import { createHash } from 'node:crypto'
import type { DecisionRequest } from '../../src/entities/contracts.js'

const aliasPattern = /^(?:D|U)(?:0[0-9]|[12][0-9]|3[0-5])$/u
const MAX_QUESTIONS = 2
const MAX_OPTIONS = 37

export interface NativeWireQuestionSpec {
  questionId: 'selection' | 'presence'
  expectedOptionIds: string[]
  kind: 'binary' | 'categorical'
}

interface NativeWireQuestionEvidence {
  questionId: 'selection' | 'presence'
  expectedOptionIds: string[]
  chosenOptionId: string | null
  responseType: 'choice' | 'other' | null
  scores: { optionId: string; value: number }[]
  selectedValidity: 'valid' | 'missing' | 'invalid'
  validity: 'valid' | 'missing' | 'invalid'
  mass: number | null
}

export interface NativeWireEvidence {
  schema: 'h8a-native-selector-wire-evidence-v1'
  logicalId: number
  recorderPhysicalId: number
  requestSha256: string
  requestBodySha256: string
  responseSha256: string
  responseByteLength: number
  questions: NativeWireQuestionEvidence[]
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Store only question IDs and option IDs, never producer request text or image data. */
export function nativeWireQuestionSpecs(request: DecisionRequest): NativeWireQuestionSpec[] {
  const result: NativeWireQuestionSpec[] = []
  for (const [questionId, question] of Object.entries(request.questions).slice(0, MAX_QUESTIONS)) {
    if ((questionId !== 'selection' && questionId !== 'presence') || question.type !== 'choice')
      continue
    const ids = Object.keys(question.criteria)
    if (ids.length < 2 || ids.length > MAX_OPTIONS) continue
    const binary = ids.length === 2 && ids.includes('present') && ids.includes('absent')
    if (questionId === 'presence') {
      if (binary) result.push({ questionId, expectedOptionIds: ids, kind: 'binary' })
      continue
    }
    if (binary) {
      result.push({ questionId, expectedOptionIds: ids, kind: 'binary' })
      continue
    }
    if (
      ids.length <= MAX_OPTIONS &&
      ids.every((id) => id === 'none' || aliasPattern.test(id)) &&
      ids.some((id) => id !== 'none')
    )
      result.push({ questionId, expectedOptionIds: ids, kind: 'categorical' })
  }
  return result
}

/**
 * Retain bounded finite scores from the closed v5 native response vocabulary.
 * This runs on the already-buffered response before the public adapter validates it.
 */
export function buildNativeWireEvidence(input: {
  expectedQuestions: readonly NativeWireQuestionSpec[]
  responseBytes: Uint8Array
  responseBody: unknown
  logicalId: number
  recorderPhysicalId: number
  requestSha256: string
  requestBodySha256: string
}): NativeWireEvidence {
  const root = input.responseBody
  const object =
    root !== null && typeof root === 'object' && !Array.isArray(root)
      ? (root as Record<string, unknown>)
      : undefined
  const answersValue = object?.answers
  const answers =
    answersValue !== null && typeof answersValue === 'object' && !Array.isArray(answersValue)
      ? (answersValue as Record<string, unknown>)
      : undefined
  const questions: NativeWireQuestionEvidence[] = []
  for (const spec of input.expectedQuestions.slice(0, MAX_QUESTIONS)) {
    const ids = spec.expectedOptionIds.slice(0, MAX_OPTIONS)
    const rawQuestion = answers?.[spec.questionId]
    const responseQuestion =
      rawQuestion !== null && typeof rawQuestion === 'object' && !Array.isArray(rawQuestion)
        ? (rawQuestion as Record<string, unknown>)
        : undefined
    const rawScores = responseQuestion?.probabilities
    const scoreRows: { optionId: string; value: number }[] = []
    let invalid = false
    const scoresMissing = rawScores === undefined || rawScores === null
    if (
      rawScores !== undefined &&
      rawScores !== null &&
      (typeof rawScores !== 'object' || Array.isArray(rawScores))
    )
      invalid = true
    if (rawScores !== null && typeof rawScores === 'object' && !Array.isArray(rawScores)) {
      const scoreMap = rawScores as Record<string, unknown>
      if (Object.keys(scoreMap).length > MAX_OPTIONS) invalid = true
      for (const [optionId, value] of Object.entries(scoreMap).slice(0, MAX_OPTIONS)) {
        if (!ids.includes(optionId) || typeof value !== 'number' || !Number.isFinite(value)) {
          invalid = true
          continue
        }
        if (value < 0 || value > 1) invalid = true
        scoreRows.push({ optionId, value })
      }
    } else if (Array.isArray(rawScores)) {
      if (rawScores.length > MAX_OPTIONS) invalid = true
      for (const row of rawScores.slice(0, MAX_OPTIONS)) {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) {
          invalid = true
          continue
        }
        const item = row as Record<string, unknown>
        const optionId = item.optionId
        const value = item.value
        if (
          typeof optionId !== 'string' ||
          !ids.includes(optionId) ||
          typeof value !== 'number' ||
          !Number.isFinite(value)
        ) {
          invalid = true
          continue
        }
        if (value < 0 || value > 1) invalid = true
        if (scoreRows.some((existing) => existing.optionId === optionId)) invalid = true
        scoreRows.push({ optionId, value })
      }
    }
    const responseType =
      responseQuestion?.type === 'choice'
        ? 'choice'
        : responseQuestion?.type === undefined
          ? null
          : 'other'
    const rawChosen = responseQuestion?.choice ?? responseQuestion?.selected
    const chosenOptionId =
      typeof rawChosen === 'string' && ids.includes(rawChosen) ? rawChosen : null
    const complete =
      scoreRows.length === ids.length &&
      ids.every((id) => scoreRows.some((row) => row.optionId === id))
    const massTotal = complete ? scoreRows.reduce((sum, row) => sum + row.value, 0) : null
    const mass = massTotal !== null && Number.isFinite(massTotal) ? massTotal : null
    const maxScore = scoreRows.length ? Math.max(...scoreRows.map((row) => row.value)) : null
    const selectedValidity =
      rawChosen === undefined || (chosenOptionId !== null && maxScore === null)
        ? 'missing'
        : chosenOptionId === null ||
            scoreRows.find((row) => row.optionId === chosenOptionId)?.value !== maxScore
          ? 'invalid'
          : 'valid'
    if (responseType === 'other' || selectedValidity === 'invalid') invalid = true
    if (complete && (mass === null || Math.abs(mass - 1) > 1e-6)) invalid = true
    const missing =
      scoresMissing || !complete || responseType === null || selectedValidity === 'missing'
    questions.push({
      questionId: spec.questionId,
      expectedOptionIds: ids,
      chosenOptionId,
      responseType,
      scores: scoreRows,
      selectedValidity,
      validity: invalid ? 'invalid' : missing ? 'missing' : 'valid',
      mass,
    })
  }
  return {
    schema: 'h8a-native-selector-wire-evidence-v1',
    logicalId: input.logicalId,
    recorderPhysicalId: input.recorderPhysicalId,
    requestSha256: input.requestSha256,
    requestBodySha256: input.requestBodySha256,
    responseSha256: sha256(input.responseBytes),
    responseByteLength: input.responseBytes.byteLength,
    questions,
  }
}
