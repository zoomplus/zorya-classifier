import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { foregroundRect, fullRoiBounds } from '../benchmarks/v02/region-grabcut-component.js'
import { parseRegionGrabCutComponentArgs } from '../benchmarks/v02/run-region-grabcut-component.js'

await test('component bounds cover the full oriented source and use half-open axes', () => {
  assert.deepEqual(fullRoiBounds(800, 600), {
    left: { start: 0, endExclusive: 800 },
    right: { start: 0, endExclusive: 800 },
    top: { start: 0, endExclusive: 600 },
    bottom: { start: 0, endExclusive: 600 },
  })
})

await test('component foreground bounds derive only from actual binary foreground pixels', () => {
  assert.deepEqual(
    foregroundRect({
      data: Uint8Array.from([0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0]),
      width: 4,
      height: 3,
      format: 'binary-u8',
    }),
    { left: 0, top: 0, width: 4, height: 2 },
  )
  assert.equal(
    foregroundRect({ data: new Uint8Array(6), width: 3, height: 2, format: 'binary-u8' }),
    undefined,
  )
  assert.throws(
    () =>
      foregroundRect({ data: Uint8Array.from([0, 255]), width: 2, height: 1, format: 'binary-u8' }),
    /binary 0 or 1/u,
  )
})

await test('native component CLI requires explicit opt-in and all frozen source inputs', () => {
  assert.throws(() => parseRegionGrabCutComponentArgs([]), /--allow-native/u)
  assert.deepEqual(
    parseRegionGrabCutComponentArgs([
      '--allow-native',
      '--summary',
      'summary.json',
      '--original-run',
      'source-run',
      '--image-root',
      'images',
      '--corpus-root',
      'corpus',
      '--asset',
      'opencv.js',
      '--out',
      'out',
    ]),
    {
      summaryPath: join(process.cwd(), 'summary.json'),
      originalRunDir: join(process.cwd(), 'source-run'),
      imageRoot: join(process.cwd(), 'images'),
      corpusRoot: join(process.cwd(), 'corpus'),
      assetPath: join(process.cwd(), 'opencv.js'),
      outputRoot: join(process.cwd(), 'out'),
    },
  )
})
