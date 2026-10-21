import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import sharp from 'sharp'
import { decodeH4dMask } from '../benchmarks/v03/evaluate-h4d-samhq-ui-mask-availability.js'

await test('shared H4d/H4e mask decoder checks encoded byte receipt and pixel geometry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v03-h4d-mask-decode-'))
  try {
    await mkdir(join(root, 'masks'))
    const pixels = Buffer.alloc(1280 * 800)
    pixels[3 * 1280 + 2] = 255
    const bytes = await sharp(pixels, { raw: { width: 1280, height: 800, channels: 1 } })
      .png()
      .toBuffer()
    await writeFile(join(root, 'masks', 'mask.png'), bytes)
    const receipt = {
      mask_path: 'masks/mask.png',
      mask_sha256: createHash('sha256').update(bytes).digest('hex'),
      mask_bytes: bytes.byteLength,
      mask_box_xyxy: [2, 3, 3, 4],
      mask_pixel_area: 1,
      source_width: 1280,
      source_height: 800,
      empty: false,
    }
    const decoded = await decodeH4dMask(root, receipt)
    assert.equal(decoded.area, 1)
    assert.deepEqual(decoded.bounds, { left: 2, top: 3, width: 1, height: 1 })
    await assert.rejects(
      decodeH4dMask(root, { ...receipt, mask_bytes: bytes.byteLength + 1 }),
      /mask-byte-size-mismatch/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
