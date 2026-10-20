import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertRegionChoiceContract } from './native-proposal-windows-acceptance.mjs'

const harness = fileURLToPath(new URL('./native-proposal-windows-acceptance.mjs', import.meta.url))

test('native Windows acceptance keeps proposal workflow as the default and documents opt-in flow', () => {
  const result = spawnSync(process.execPath, [harness, '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /\[--workflow=proposals\|region-segmentation\] \(default: proposals\)/u,
  )
})

test('native Windows acceptance rejects unrecognized workflow before platform checks', () => {
  const result = spawnSync(
    process.execPath,
    [
      harness,
      '--archive=fixture.tgz',
      `--sha256=${'a'.repeat(64)}`,
      `--source-commit=${'b'.repeat(40)}`,
      '--encoder=encoder.onnx',
      '--decoder=decoder.onnx',
      '--report=report.json',
      '--workflow=unsupported',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--workflow must be proposals or region-segmentation/u)
  assert.doesNotMatch(result.stderr, /Expected native Windows/u)
})

test('native Windows acceptance rejects duplicate workflow arguments', () => {
  const result = spawnSync(
    process.execPath,
    [
      harness,
      '--archive=fixture.tgz',
      `--sha256=${'a'.repeat(64)}`,
      `--source-commit=${'b'.repeat(40)}`,
      '--encoder=encoder.onnx',
      '--decoder=decoder.onnx',
      '--report=report.json',
      '--workflow=proposals',
      '--workflow=region-segmentation',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Duplicate argument: --workflow/u)
})

test('region workflow checks the DecisionPort request Choice type, not its ranked answer type', () => {
  assert.doesNotThrow(() =>
    assertRegionChoiceContract({
      questions: {
        presence: { type: 'noul' },
        selection: { type: 'choice' },
      },
    }),
  )
  assert.throws(
    () =>
      assertRegionChoiceContract({
        questions: {
          presence: { type: 'noul' },
          selection: { type: 'ranked-choice' },
        },
      }),
    /Noul \+ Choice/u,
  )
})
