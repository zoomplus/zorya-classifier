import assert from 'node:assert/strict'
import sharp from 'sharp'
import test from 'node:test'
import type { ViewerDocument } from '../../src/viewer/document.js'
import { renderViewerDocument, viewerDocumentOwnedBy } from '../../src/viewer/document.js'

const documentFixture: ViewerDocument = {
  ownerId: 'owner-a',
  jobId: 'job-a',
  title: '<script>alert(1)</script>',
  source: {
    id: 'opaque-source',
    role: 'source',
    mediaType: 'image/png',
    byteLength: 128,
    expiresAt: 99,
    width: 640,
    height: 480,
  },
  cutout: {
    id: 'opaque-cutout',
    role: 'cutout',
    mediaType: 'image/png',
    byteLength: 64,
    expiresAt: 99,
    width: 128,
    height: 96,
  },
  geometryKind: 'coarse-region',
  box: { x: 32, y: 48, width: 200, height: 120 },
  result: { label: '<img src=x onerror=alert(1)>', nested: { safe: true } },
}

await test('viewer escapes task text and overlays the source-coordinate box on the source aspect ratio', async () => {
  const response = renderViewerDocument(documentFixture)
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.match(html, /Coarse region box/u)
  assert.match(html, /viewBox="0 0 640 480"/u)
  assert.match(html, /aspect-ratio:640\/480/u)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u)
  assert.match(html, /\\u003cimg src=x onerror=alert\(1\)\\u003e/u)
  assert.doesNotMatch(html, /<script>/u)
  assert.doesNotMatch(html, /<img src=x onerror=/u)
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/u)
  assert.match(html, /\/artifacts\/opaque-source/u)
  assert.match(html, /\/artifacts\/opaque-cutout/u)
})

await test('viewer hides invalid source boxes and requires the owning principal', async () => {
  const invalidBox = { ...documentFixture, box: { x: 600, y: 0, width: 80, height: 60 } }
  assert.doesNotMatch(await renderViewerDocument(invalidBox).text(), /<rect/u)
  assert.equal(
    viewerDocumentOwnedBy(documentFixture, { ownerId: 'owner-a', transport: 'stdio' }),
    true,
  )
  assert.equal(
    viewerDocumentOwnedBy(documentFixture, { ownerId: 'owner-b', transport: 'stdio' }),
    false,
  )
})

await test('portrait EXIF-oriented dimensions and source-coordinate box share one coordinate space', async () => {
  const jpeg = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#406080' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer()
  const decoded = await sharp(jpeg).rotate().raw().toBuffer({ resolveWithObject: true })
  assert.equal(decoded.info.width, 2)
  assert.equal(decoded.info.height, 3)
  const portrait = {
    ...documentFixture,
    source: {
      ...documentFixture.source,
      mediaType: 'image/jpeg',
      byteLength: jpeg.byteLength,
      width: decoded.info.width,
      height: decoded.info.height,
    },
    geometryKind: 'whole-object' as const,
    box: { x: 0, y: 1, width: 1, height: 1 },
  }
  const response = renderViewerDocument(portrait)
  const html = await response.text()
  assert.match(html, /viewBox="0 0 2 3"/u)
  assert.match(html, /aspect-ratio:2\/3/u)
  assert.match(html, /<rect x="0" y="1" width="1" height="1"\/>/u)
  assert.deepEqual(Buffer.from(jpeg), jpeg)
})

await test('landscape source image and its overlay retain source-pixel geometry', async () => {
  const png = await sharp({ create: { width: 5, height: 2, channels: 4, background: '#234567' } })
    .png()
    .toBuffer()
  const decoded = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  const landscape = {
    ...documentFixture,
    source: {
      ...documentFixture.source,
      mediaType: 'image/png',
      byteLength: png.byteLength,
      width: decoded.info.width,
      height: decoded.info.height,
    },
    geometryKind: 'whole-object' as const,
    box: { x: 3, y: 0, width: 1, height: 2 },
  }
  const response = renderViewerDocument(landscape)
  const html = await response.text()
  assert.match(html, /viewBox="0 0 5 2"/u)
  assert.match(html, /aspect-ratio:5\/2/u)
  assert.match(html, /<rect x="3" y="0" width="1" height="2"\/>/u)
})

await test('packed lsb0 mask canvas stays cropped and positioned in source coordinates', async () => {
  const maskDocument: ViewerDocument = {
    ...documentFixture,
    source: { ...documentFixture.source, width: 6, height: 4 },
    mask: {
      id: 'packed-mask',
      role: 'mask',
      mediaType: 'application/octet-stream',
      byteLength: 1,
      expiresAt: 99,
      width: 2,
      height: 2,
      encoding: 'binary-lsb0',
    },
    maskRegion: { x: 3, y: 1, width: 2, height: 2 },
  }
  const response = renderViewerDocument(maskDocument)
  const html = await response.text()
  const nonce = response.headers
    .get('content-security-policy')
    ?.match(/script-src 'nonce-([^']+)'/u)?.[1]
  assert.ok(nonce)
  assert.match(
    html,
    /<canvas class="mask" data-mask-src="\/artifacts\/packed-mask" data-width="2" data-height="2" width="2" height="2"/u,
  )
  assert.match(html, /left:50%;top:25%;width:33\.33333333333333%;height:50%/u)
  assert.match(html, /packed\[pixel>>3\]&\(1<<\(pixel&7\)\)/u)
  assert.match(html, new RegExp(`<script nonce="${nonce}"`, 'u'))
  assert.match(response.headers.get('content-security-policy') ?? '', /connect-src 'self'/u)
  assert.doesNotMatch(html, /data:image\//u)
})
