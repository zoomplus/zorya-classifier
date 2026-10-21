import assert from 'node:assert/strict'
import test from 'node:test'
import { H7OwnedChild } from '../benchmarks/v03/h7-owned-child.js'

const mock = `
const readline = require('node:readline');
let calls = 0;
process.stdout.write(JSON.stringify({type:'ready'})+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line);
  if (request.command === 'hang') return;
  if (request.command === 'exit') process.exit(3);
  if (request.command === 'close') {
    process.stdout.write(JSON.stringify({type:'closed'})+'\\n', () => process.exit(0));
  } else if (request.command === 'bad') process.stdout.write('not-json\\n');
  else process.stdout.write(JSON.stringify({type:'case_result',calls:++calls})+'\\n');
});
`

function worker() {
  return new H7OwnedChild(process.execPath, ['-e', mock], process.cwd())
}

await test('H7 persistent worker reuses one process and joins successful close', async () => {
  const child = worker()
  const signal = new AbortController().signal
  try {
    assert.deepEqual(await child.exchange(undefined, performance.now() + 5000, signal), {
      type: 'ready',
    })
    const pid = child.receipt.pid
    assert.deepEqual(await child.exchange({ command: 'case' }, performance.now() + 5000, signal), {
      type: 'case_result',
      calls: 1,
    })
    assert.deepEqual(await child.exchange({ command: 'case' }, performance.now() + 5000, signal), {
      type: 'case_result',
      calls: 2,
    })
    assert.equal(child.receipt.pid, pid)
    await child.finish(signal)
    assert.equal(child.receipt.closed, true)
    assert.equal(child.receipt.code, 0)
  } finally {
    await child.dispose()
  }
})

for (const mode of ['cancel', 'timeout', 'exit', 'bad'] as const) {
  await test(`H7 ${mode} joins physical exit before rejecting`, async () => {
    const child = worker()
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    try {
      await child.exchange(undefined, performance.now() + 5000, controller.signal)
      if (mode === 'cancel') timer = setTimeout(() => controller.abort(), 20)
      const request = mode === 'cancel' || mode === 'timeout' ? 'hang' : mode
      await assert.rejects(
        child.exchange(
          { command: request },
          performance.now() + (mode === 'timeout' ? 20 : 5000),
          controller.signal,
        ),
        mode === 'cancel' ? { code: 'ABORTED' } : mode === 'timeout' ? { code: 'TIMEOUT' } : /./u,
      )
      assert.equal(child.receipt.closed, true)
      if (mode === 'exit') assert.equal(child.receipt.code, 3)
      await assert.rejects(
        child.exchange({ command: 'case' }, performance.now() + 5000, new AbortController().signal),
      )
    } finally {
      if (timer) clearTimeout(timer)
      await child.dispose()
    }
  })
}
