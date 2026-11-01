import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ClassifierError } from '../../src/entities/errors.js'

const h6QueryPolicyIdSchema = z.enum(['legacy-v1', 'strict-authored-scope-v1'])

export type H6QueryPolicyId = z.infer<typeof h6QueryPolicyIdSchema>

export const H6_QUERY_POLICY_INSTRUCTIONS = Object.freeze({
  presenceState:
    'Assess the full original image independently of proposal masks. Apply every explicit part of the authored expression, including its scope, roles, relations, and exclusions. Use the required structured response schema to return exactly one closed state: present, absent, or uncertain. Use uncertain when those constraints cannot be reliably established; use absent only when no visible instance satisfies them.',
  presenceQuestion:
    'Using the required structured response schema, which single closed state describes whether a visible instance satisfies the complete authored expression within its stated scope?',
  nominationState:
    'Order available closed candidate aliases by fit to the complete authored expression, including its explicit scope, roles, relations, and exclusions. Use only supplied aliases; do not invent candidates. If none fits, put none first, then fill only the remaining positions required by the response schema with available aliases; those tail entries do not imply a match. Let the schema determine the list length, up to four. Do not invent probabilities or add prose explanations.',
  nominationQuestion:
    'How should the available candidate aliases be ordered by fit to the complete authored expression in the required response schema? If none fits, place none first.',
  finalState:
    'Use the required structured response schema to choose exactly one supplied mask alias or none. First require a match to the complete authored expression, including its explicit scope, roles, relations, and exclusions, then consider visible-extent coverage. Preserve gaps and disconnected visible parts caused by occlusion; do not infer hidden geometry. Do not add prose explanations or invent probabilities.',
  finalQuestion:
    'Within the required closed response schema, which single supplied mask alias, if any, best matches the complete authored expression and its stated scope?',
})

const policyBody = {
  schema: 'h6-query-policy-v1',
  policyId: 'strict-authored-scope-v1',
  hypothesisSha256: 'dac1bf0eeecfaa204a70e3a89d5e16d7c64ced576a972923a3a1665287426ab2',
  compositionMode: 'append-to-legacy-instruction-v1',
  instructions: H6_QUERY_POLICY_INSTRUCTIONS,
} as const

export const H6_QUERY_POLICY = Object.freeze(policyBody)

export const H6_QUERY_POLICY_SHA256 = createHash('sha256')
  .update(JSON.stringify(H6_QUERY_POLICY))
  .digest('hex')

export function resolveH6QueryPolicyId(value: unknown): H6QueryPolicyId {
  if (value === undefined) return 'legacy-v1'
  const result = h6QueryPolicyIdSchema.safeParse(value)
  if (!result.success)
    throw new ClassifierError('INVALID_INPUT', 'H6 query policy identifier is invalid')
  return result.data
}

export function appendH6QueryInstruction(
  policyId: H6QueryPolicyId,
  instruction: keyof typeof H6_QUERY_POLICY_INSTRUCTIONS,
  legacy: string,
): string {
  return policyId === 'legacy-v1'
    ? legacy
    : `${legacy} ${H6_QUERY_POLICY_INSTRUCTIONS[instruction]}`
}
