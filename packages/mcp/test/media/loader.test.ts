import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import { createMediaPort, decodeInlineBase64 } from '../../src/media/loader.js'

const remote = {
  trustedHosts: ['images.example.test'],
  lookupAll: async () => [{ address: '192.168.1.3', family: 4 }],
}

function request(
  source: Parameters<ReturnType<typeof createMediaPort>['loadImage']>[0]['source'],
  ownerId = 'owner-a',
) {
  return {
    source,
    principal: { ownerId, transport: 'stdio' as const },
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5_000,
    maxBytes: 1_000_000,
  }
}

await test('inline image bytes are validated by content and returned as an owned copy', async () => {
  const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#1b2c3d' } })
    .png()
    .toBuffer()
  const data = png.toString('base64')
  const media = createMediaPort({ remote })
  const loaded = await media.loadImage(
    request({ kind: 'inlineBase64', data, mediaType: 'image/png' }),
  )
  assert.equal(loaded.width, 3)
  assert.equal(loaded.height, 2)
  assert.equal(loaded.mediaType, 'image/png')
  assert.deepEqual(Buffer.from(loaded.bytes), png)
  loaded.bytes[0] = 0
  assert.notEqual(png[0], 0)
  await assert.rejects(
    media.loadImage(request({ kind: 'inlineBase64', data: `${data}junk` })),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'INVALID_INPUT',
  )
  await assert.rejects(
    media.loadImage({ ...request({ kind: 'inlineBase64', data }), maxBytes: 8 }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'RESOURCE_LIMIT',
  )
})

await test('inline base64 validation handles the maximum supported image length without regex recursion and rejects bad padding', () => {
  const maximumBytes = 16_777_216
  const source = Buffer.alloc(maximumBytes, 0x41)
  const encoded = source.toString('base64')
  const decoded = decodeInlineBase64(encoded, maximumBytes)
  assert.equal(decoded.byteLength, maximumBytes)
  assert.equal(decoded[0], 0x41)
  assert.equal(decoded.at(-1), 0x41)
  assert.throws(() => decodeInlineBase64('AA=A', 4), /invalid/u)
  assert.throws(() => decodeInlineBase64('AB==', 1), /canonical/u)
})

await test('EXIF orientation reports oriented dimensions and preserves the original JPEG bytes', async () => {
  const jpeg = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#4080c0' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer()
  const media = createMediaPort({ remote })
  const loaded = await media.loadImage(
    request({ kind: 'inlineBase64', data: jpeg.toString('base64'), mediaType: 'image/jpeg' }),
  )
  assert.equal(loaded.width, 3)
  assert.equal(loaded.height, 2)
  assert.equal(loaded.mediaType, 'image/jpeg')
  assert.deepEqual(Buffer.from(loaded.bytes), jpeg)
})

await test('local file reads are stdio-only, rooted, bounded and reject traversal', async (context) => {
  const temp = await mkdtemp(join(tmpdir(), 'zorya-mcp-media-'))
  const root = join(temp, 'input')
  await mkdir(root, { mode: 0o700 })
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#abcdef' } })
    .png()
    .toBuffer()
  await writeFile(join(root, 'image.png'), png, { mode: 0o600 })
  await writeFile(join(temp, 'outside.png'), png, { mode: 0o600 })
  await symlink(join(temp, 'outside.png'), join(root, 'escape.png'))
  context.after(async () => rm(temp, { recursive: true, force: true }))
  const media = createMediaPort({ remote, stdioInputRoot: root })
  const loaded = await media.loadImage(request({ kind: 'localPath', path: 'image.png' }))
  assert.deepEqual(Buffer.from(loaded.bytes), png)
  await assert.rejects(
    media.loadImage(request({ kind: 'localPath', path: '../image.png' })),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'INVALID_INPUT',
  )
  await assert.rejects(
    media.loadImage(request({ kind: 'localPath', path: 'escape.png' })),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'INVALID_INPUT',
  )
  await assert.rejects(
    media.loadImage({
      ...request({ kind: 'localPath', path: 'image.png' }),
      principal: {
        ownerId: 'owner-a',
        transport: 'http',
        identity: { issuer: 'https://id.example.test', subject: 's', scopes: [] },
      },
    }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'INVALID_INPUT',
  )
})
