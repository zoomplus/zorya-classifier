import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSplitPilotArgs } from '../benchmarks/v02/run-split-route-pilot.js'

await test('split-route CLI refuses implicit or ambiguous dispatch modes', () => {
  assert.throws(() => parseSplitPilotArgs([]), /exactly one/u)
  assert.throws(() => parseSplitPilotArgs(['--dry-run', '--allow-paid']), /exactly one/u)
  assert.throws(() => parseSplitPilotArgs(['--allow-paid']), /encoder and --decoder/u)
})

await test('split-route CLI dry-run accepts only explicit offline mode and fixed exposed DEV defaults', () => {
  const options = parseSplitPilotArgs(['--dry-run'])
  assert.equal(options.dryRun, true)
  assert.equal(options.allowPaid, false)
  assert.equal(options.inputManifestPath.endsWith('/benchmarks/v02/corpus/dev/inputs.json'), true)
  assert.equal(options.encoderPath, '')
  assert.equal(options.decoderPath, '')
})
