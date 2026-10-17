import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Linter } from 'eslint'
import { noDiscardedInterval } from '../tools/no-discarded-interval.mjs'
const linter = new Linter()
function messages(code: string) {
  return linter.verify(code, [
    {
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        globals: { setInterval: 'readonly', clearInterval: 'readonly', globalThis: 'readonly' },
      },
      plugins: { owner: { rules: { interval: noDiscardedInterval } } },
      rules: { 'owner/interval': 'error' },
    },
  ])
}
await test('leaked global/node intervals are rejected including aliases', () => {
  for (const source of [
    'setInterval(()=>{},1)',
    'void setInterval(()=>{},1)',
    'globalThis.setInterval(()=>{},1)',
    "import { setInterval as tick } from 'node:timers'; tick(()=>{},1)",
    "import * as timers from 'node:timers'; timers.setInterval(()=>{},1)",
  ])
    assert.equal(messages(source).length, 1, source)
})
await test('stored interval cleanup and shadowed names are accepted', () => {
  for (const source of [
    'const id=setInterval(()=>{},1); clearInterval(id)',
    'function f(setInterval){setInterval()}',
    'const local={setInterval(){}};local.setInterval()',
  ])
    assert.deepEqual(messages(source), [], source)
})
