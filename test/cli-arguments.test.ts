import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCliArguments } from '../src/app/cli-arguments.js'

await test('CLI preserves legacy arguments and keeps whole-object selection explicit', () => {
  assert.deepEqual(parseCliArguments([]), { command: 'help' })
  assert.deepEqual(parseCliArguments(['--help']), { command: 'help' })
  assert.deepEqual(parseCliArguments(['classify-text', 'message', 'classes.json']), {
    command: 'classify-text',
    value: 'message',
    target: 'classes.json',
  })
  assert.equal(
    parseCliArguments(['locate', 'photo.jpg', 'object', '--mode', 'whole-object']).command,
    'locate',
  )
})
await test('CLI validates extraction backend/assets/output before any paid composition', () => {
  for (const args of [
    ['extract', 'photo', 'object'],
    ['extract', 'photo', 'object', '--backend', 'mobile-sam', '--output', 'out'],
    [
      'extract',
      'photo',
      'object',
      '--backend',
      'grabcut',
      '--output',
      'out',
      '--opencv',
      'cv.js',
      '--provider',
      'cpu',
    ],
    ['locate', 'photo', 'object', '--output', 'out'],
    ['classify-image', 'photo', 'classes', '--mode', 'whole-object'],
    ['locate', 'photo', 'object', '--mode', 'unknown'],
    ['locate', 'photo', 'object', '--unknown'],
    ['locate', 'photo', 'object', 'extra'],
  ])
    assert.throws(() => parseCliArguments(args), { code: 'INVALID_INPUT' })
  assert.equal(
    parseCliArguments([
      'extract',
      'photo',
      'object',
      '--backend',
      'mobile-sam',
      '--output',
      'out',
      '--encoder',
      'enc.onnx',
      '--decoder',
      'dec.onnx',
    ]).command,
    'extract',
  )
  assert.equal(
    parseCliArguments([
      'extract',
      'photo',
      'object',
      '--backend',
      'grabcut',
      '--output',
      'out',
      '--opencv',
      'cv.js',
    ]).command,
    'extract',
  )
})
