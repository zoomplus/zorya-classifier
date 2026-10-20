import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { parseCategoricalPilotArgs } from '../benchmarks/v02/run-categorical-presence-pilot.js'

await test('categorical-presence CLI requires an explicit offline or paid mode', () => {
  assert.throws(() => parseCategoricalPilotArgs([]), /exactly one/u)
  assert.throws(() => parseCategoricalPilotArgs(['--dry-run', '--allow-paid']), /exactly one/u)
  assert.throws(() => parseCategoricalPilotArgs(['--allow-paid']), /encoder and --decoder/u)
})

await test('categorical-presence dry-run pins six exposed DEV cases and allows a named env credential', () => {
  const options = parseCategoricalPilotArgs(['--dry-run', '--api-key-env', 'RUNNER_OPENROUTER_KEY'])
  assert.equal(options.allowPaid, false)
  assert.equal(options.dryRun, true)
  assert.equal(options.inputManifestPath, resolve('benchmarks/v02/corpus/dev/inputs.json'))
  assert.equal(options.apiKeyEnvironmentName, 'RUNNER_OPENROUTER_KEY')
  assert.equal(options.encoderPath, '')
  assert.equal(options.decoderPath, '')
})

await test('categorical-presence CLI rejects unsafe environment variable names', () => {
  assert.throws(
    () =>
      parseCategoricalPilotArgs([
        '--allow-paid',
        '--encoder',
        '/e',
        '--decoder',
        '/d',
        '--api-key-env',
        'X;printenv',
      ]),
    /invalid_string/u,
  )
})
