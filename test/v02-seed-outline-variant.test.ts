import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseSeedOutlinePilotArgs } from '../benchmarks/v02/run-seed-outline-pilot.js'

await test('seed-outline runner is fixed to old exposed Car and Boat inputs with explicit paid intent', () => {
  assert.throws(() => parseSeedOutlinePilotArgs([]), /explicit --allow-paid/u)
  const parsed = parseSeedOutlinePilotArgs([
    '--allow-paid',
    '--image-root',
    './corpus',
    '--out',
    './.run',
  ])
  assert.equal(parsed.imageRoot, resolve('./corpus'))
  assert.equal(parsed.outputRoot, resolve('./.run'))
  assert.throws(
    () => parseSeedOutlinePilotArgs(['--allow-paid', '--case', 'photo-dev-01']),
    /Unknown option/u,
  )
})
