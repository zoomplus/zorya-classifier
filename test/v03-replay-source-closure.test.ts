import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  captureH5ReplaySource,
  H5_REPLAY_SOURCE_FILES,
} from '../benchmarks/v03/replay-source-closure.js'

await test('H5 replay closure detects producer changes and remains independent of input order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-closure-'))
  try {
    const paths = ['src/z.ts', 'src/nested/a.ts', ...H5_REPLAY_SOURCE_FILES]
    for (const path of paths.toReversed()) {
      const absolute = join(root, path)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, path)
    }
    const first = await captureH5ReplaySource(root)
    assert.deepEqual(
      first.files.map((file) => file.path),
      [...paths].sort(),
    )
    assert.deepEqual(await captureH5ReplaySource(root), first)
    await writeFile(join(root, 'src/nested/a.ts'), 'changed producer bytes')
    const changed = await captureH5ReplaySource(root)
    assert.notEqual(changed.sha256, first.sha256)
    assert.equal(
      changed.files.filter((file, index) => file.sha256 !== first.files[index]?.sha256).length,
      1,
    )
    await rm(join(root, 'package-lock.json'))
    await assert.rejects(captureH5ReplaySource(root), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('H5 replay closure refuses cancelled work before scanning source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-closure-abort-'))
  try {
    const controller = new AbortController()
    controller.abort(new Error('cancelled by owner'))
    await assert.rejects(captureH5ReplaySource(root, controller.signal), /cancelled by owner/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
