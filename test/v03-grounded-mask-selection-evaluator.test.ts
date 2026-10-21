import assert from 'node:assert/strict'
import test from 'node:test'
import { finalOutputDisposition } from '../benchmarks/v03/evaluate-grounded-mask-selection.js'

await test('diagnostic mask paths never qualify unresolved box-check rows as delivered outputs', () => {
  for (const status of ['needs-expansion', 'unknown', 'error', 'none']) {
    assert.equal(
      finalOutputDisposition({
        status,
        verdict: status === 'needs-expansion' || status === 'unknown' ? status : undefined,
        selected: true,
        maskPath: 'diagnostic-mask.png',
        cutoutPath: null,
      }),
      'missing',
    )
  }
})

await test('complete output requires a selected alias and both persisted artifacts', () => {
  assert.equal(
    finalOutputDisposition({
      status: 'complete',
      verdict: 'complete',
      selected: true,
      maskPath: 'selected-mask.png',
      cutoutPath: 'selected-cutout.png',
    }),
    'validate-artifacts',
  )
  assert.equal(
    finalOutputDisposition({
      status: 'complete',
      verdict: 'complete',
      selected: true,
      maskPath: 'selected-mask.png',
      cutoutPath: null,
    }),
    'invalid',
  )
  assert.equal(
    finalOutputDisposition({
      status: 'complete',
      verdict: 'complete',
      selected: false,
      maskPath: 'selected-mask.png',
      cutoutPath: 'selected-cutout.png',
    }),
    'invalid',
  )
})
