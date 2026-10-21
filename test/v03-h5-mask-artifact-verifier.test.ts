import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import { assertSameBinaryMask } from '../benchmarks/v03/evaluate-h5-selection.js'

const fixtures = [
  {
    family: 'H3b + SAM2',
    path: '/root/work/zorya-classifier/.run/v03/grounded-proposals-h3-run-02/masks/pilot-v03-photo-01/C00.png',
  },
  {
    family: 'H4e + SAM2',
    path: '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h4e-sam2-context-prompt-v1/masks/candidate-013-mask.png',
  },
]

for (const fixture of fixtures) {
  await test(
    `selected-mask artifact verifier accepts byte-preserved ${fixture.family} PNG`,
    {
      skip: !existsSync(fixture.path),
    },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'v03-h5-mask-verify-'))
      try {
        const outputPath = join(directory, 'selected-mask.png')
        await copyFile(fixture.path, outputPath)
        const [sourceHash, outputHash, metadata] = await Promise.all([
          readFile(fixture.path).then((bytes) => createHash('sha256').update(bytes).digest('hex')),
          readFile(outputPath).then((bytes) => createHash('sha256').update(bytes).digest('hex')),
          sharp(fixture.path).metadata(),
        ])
        assert(metadata.width && metadata.height)
        await assertSameBinaryMask(
          fixture.path,
          outputPath,
          sourceHash,
          outputHash,
          metadata.width,
          metadata.height,
        )
        const pixels = await sharp(fixture.path).greyscale().raw().toBuffer()
        pixels[0] = pixels[0] === 0 ? 255 : 0
        await sharp(pixels, {
          raw: { width: metadata.width, height: metadata.height, channels: 1 },
        })
          .png()
          .toFile(outputPath)
        const changedOutputHash = createHash('sha256')
          .update(await readFile(outputPath))
          .digest('hex')
        await assert.rejects(
          assertSameBinaryMask(
            fixture.path,
            outputPath,
            sourceHash,
            changedOutputHash,
            metadata.width,
            metadata.height,
          ),
          /selected-mask-pixels-differ/u,
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
}
