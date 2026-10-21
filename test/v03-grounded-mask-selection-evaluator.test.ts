import assert from 'node:assert/strict'
import test from 'node:test'
import {
  finalOutputDisposition,
  groundedMaskProfileIdentity,
} from '../benchmarks/v03/evaluate-grounded-mask-selection.js'

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

await test('H3c final verifier match is the only new complete disposition', () => {
  assert.equal(
    finalOutputDisposition({
      status: 'complete',
      verdict: 'match-complete-pure',
      selected: true,
      maskPath: 'selected-mask.png',
      cutoutPath: 'selected-cutout.png',
    }),
    'validate-artifacts',
  )
  for (const verdict of ['wrong-object-or-contaminated', 'match-incomplete', 'unknown']) {
    assert.equal(
      finalOutputDisposition({
        status: 'unknown',
        verdict,
        selected: true,
        maskPath: 'diagnostic-mask.png',
        cutoutPath: null,
      }),
      'missing',
    )
  }
})

await test('profile identity preserves H3b and requires H3c schema, selector pin and verifier closure', () => {
  const h3b = {
    schema: 'v03-grounded-mask-selection-pilot-v1',
    initialProducerClosureSha256: 'a'.repeat(64),
    finalProducerClosureSha256: 'a'.repeat(64),
  }
  const h3bFreeze = {
    schema: 'v03-grounded-mask-selection-freeze-v1',
    producerClosure: { sha256: 'a'.repeat(64) },
  }
  assert.equal(groundedMaskProfileIdentity(h3b, h3bFreeze), 'h3b')
  const files = [
    {
      path: 'benchmarks/v03/grounded-mask-selector.ts',
      sha256: '46416dd3ab98b51e0870a8f55eb09bc764adbec004b718b2ad29ed974acc0737',
    },
    { path: 'benchmarks/v03/h3c-verifier.ts', sha256: 'b'.repeat(64) },
  ]
  const h3c = {
    schema: 'v03-grounded-mask-h3c-pilot-v1',
    verificationProfile: 'h3c',
    initialProducerClosureSha256: 'c'.repeat(64),
    finalProducerClosureSha256: 'c'.repeat(64),
    initialProducerClosure: files,
    finalProducerClosure: files,
  }
  const h3cFreeze = {
    schema: 'v03-grounded-mask-h3c-freeze-v1',
    verificationProfile: 'h3c',
    producerClosure: { sha256: 'c'.repeat(64), files },
  }
  assert.equal(groundedMaskProfileIdentity(h3c, h3cFreeze), 'h3c')
  const changedSelector = structuredClone(h3cFreeze)
  changedSelector.producerClosure.files[0]!.sha256 = 'd'.repeat(64)
  const changedRun = {
    ...h3c,
    initialProducerClosure: changedSelector.producerClosure.files,
    finalProducerClosure: changedSelector.producerClosure.files,
  }
  assert.throws(
    () => groundedMaskProfileIdentity(changedRun, changedSelector),
    /selector-or-verifier/u,
  )
  assert.throws(() => groundedMaskProfileIdentity(h3c, h3bFreeze), /profile-identity/u)
})
