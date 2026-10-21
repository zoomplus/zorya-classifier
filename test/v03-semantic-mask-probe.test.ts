import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { renderCandidate, requestFor } from '../benchmarks/v03/semantic-mask-probe.js'

await test('semantic mask presentation preserves the full raster and marks only mask foreground', async () => {
  const width = 64
  const height = 64
  const rawSource = Buffer.alloc(width * height * 4, 0)
  for (let index = 0; index < width * height; index++) {
    rawSource[index * 4] = 100
    rawSource[index * 4 + 1] = 100
    rawSource[index * 4 + 2] = 100
    rawSource[index * 4 + 3] = 255
  }
  const source = await sharp(rawSource, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
  const mask = new Uint8Array(width * height)
  mask[48 * width + 24] = 1
  const rendered = await renderCandidate(source, mask, width, height, 'A')
  const decoded = await sharp(rendered).raw().toBuffer({ resolveWithObject: true })
  assert.equal(decoded.info.width, width)
  assert.equal(decoded.info.height, height)
  const marked = (48 * width + 24) * 4
  const outside = (55 * width + 55) * 4
  assert.deepEqual([...decoded.data.subarray(marked, marked + 4)], [0, 220, 255, 255])
  assert.deepEqual([...decoded.data.subarray(outside, outside + 4)], [100, 100, 100, 255])
  rendered.fill(0)
  rawSource.fill(0)
  source.fill(0)
  mask.fill(0)
})

await test('semantic selection request is one closed five-way Choice over source and four candidates', () => {
  const images = Array.from({ length: 5 }, () => Buffer.from('image'))
  const request = requestFor('Bird', images)
  assert.deepEqual(Object.keys(request.questions), ['selection'])
  const selection = request.questions.selection
  assert.ok(selection?.type === 'choice')
  assert.deepEqual(Object.keys(selection.criteria), ['A', 'B', 'C', 'D', 'none'])
  assert.equal(request.state.filter((part) => typeof part !== 'string').length, 5)
  assert.ok(request.state.includes('Target: Bird'))
  assert.match(selection.instructions, /entire visible requested object/u)
  assert.ok(
    request.state.some(
      (part) => typeof part === 'string' && /unrelated objects and background/u.test(part),
    ),
  )
})
