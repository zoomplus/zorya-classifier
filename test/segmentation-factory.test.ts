import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

import { ClassifierError } from '../src/entities/errors.js'
import { createGrabCutSegmenter } from '../src/infrastructure/segmentation/grabcut/index.js'
import { createMobileSamSegmenter } from '../src/infrastructure/segmentation/mobile-sam/index.js'

await test('explicit factories reject mismatched pinned assets as unsupported before spawning work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-segmentation-assets-'))
  const bad = join(directory, 'bad.bin')
  await writeFile(bad, 'not the pinned asset')
  try {
    await assert.rejects(createGrabCutSegmenter({ assetPath: bad }), (error: unknown) => {
      assert.ok(error instanceof ClassifierError)
      assert.equal(error.code, 'UNSUPPORTED')
      return true
    })
    await assert.rejects(
      createMobileSamSegmenter({ encoderPath: bad, decoderPath: bad }),
      (error: unknown) => {
        assert.ok(error instanceof ClassifierError)
        assert.equal(error.code, 'UNSUPPORTED')
        return true
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
