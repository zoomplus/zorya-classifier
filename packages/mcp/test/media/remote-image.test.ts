import assert from 'node:assert/strict'
import sharp from 'sharp'
import test from 'node:test'
import {
  validateRemoteImageAddresses,
  createRemoteImageLoader,
} from '../../src/media/remote-image.js'

await test('remote image DNS rejects every private, mapped and transition address', () => {
  for (const address of [
    '127.0.0.1',
    '10.2.3.4',
    '169.254.169.254',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:4860::1%eth0',
    '::8.8.8.8',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
  ]) {
    assert.throws(
      () => validateRemoteImageAddresses([{ address, family: address.includes(':') ? 6 : 4 }]),
      /prohibited address/u,
    )
  }
  assert.deepEqual(
    validateRemoteImageAddresses([
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ]),
    { address: '8.8.8.8', family: 4 },
  )
  assert.throws(
    () =>
      validateRemoteImageAddresses([
        { address: '8.8.8.8', family: 4 },
        { address: '192.168.1.2', family: 4 },
      ]),
    /prohibited address/u,
  )
})

await test('remote image loader rejects mixed public and private DNS before opening a socket', async () => {
  let lookupCount = 0
  const loader = createRemoteImageLoader({
    trustedHosts: ['images.example.test'],
    lookupAll: async () => {
      lookupCount += 1
      return [
        { address: '8.8.8.8', family: 4 },
        { address: '192.168.1.2', family: 4 },
      ]
    },
  })
  const controller = new AbortController()
  await assert.rejects(
    loader({
      source: { kind: 'url', url: 'https://images.example.test/picture.png' },
      principal: {
        ownerId: 'fake-owner',
        transport: 'http',
        identity: { issuer: 'https://issuer.example.test', subject: 'fake', scopes: [] },
      },
      signal: controller.signal,
      deadlineAt: Date.now() + 5_000,
      maxBytes: 1_024,
    }),
    /prohibited address/u,
  )
  assert.equal(lookupCount, 1)
})

await test('remote DNS cancellation waits for the resolver promise to settle at the absolute deadline', async () => {
  let settled = false
  const loader = createRemoteImageLoader({
    trustedHosts: ['images.example.test'],
    timeoutMs: 25,
    lookupAll: async (_hostname, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      settled = true
      return []
    },
  })
  await assert.rejects(
    loader({
      source: { kind: 'url', url: 'https://images.example.test/picture.png' },
      principal: { ownerId: 'fake-owner', transport: 'stdio' },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000,
      maxBytes: 1_024,
    }),
    /deadline expired/u,
  )
  assert.equal(settled, true)
})

await test('remote image URLs reject credentials, fragments, non-HTTPS and untrusted hosts', async () => {
  const loader = createRemoteImageLoader({ trustedHosts: ['images.example.test'] })
  const request = (url: string) =>
    loader({
      source: { kind: 'url', url },
      principal: { ownerId: 'fake-owner', transport: 'stdio' },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5_000,
      maxBytes: 1_024,
    })
  await assert.rejects(request('https://user:password@images.example.test/a.png'), /not allowed/u)
  await assert.rejects(request('https://images.example.test/a.png#fragment'), /not allowed/u)
  await assert.rejects(request('http://images.example.test/a.png'), /not allowed/u)
  await assert.rejects(request('https://attacker.example/a.png'), /not allowed/u)
})

await test('remote loader rechecks DNS after redirects and passes only the validated address to the HTTPS request seam', async () => {
  const png = await sharp({ create: { width: 2, height: 1, channels: 4, background: '#aabbcc' } })
    .png()
    .toBuffer()
  const resolved: string[] = []
  const pinned: string[] = []
  const loader = createRemoteImageLoader({
    trustedHosts: ['images.example.test'],
    lookupAll: async (hostname) => {
      resolved.push(hostname)
      return [{ address: '8.8.8.8', family: 4 }]
    },
    requestForTesting: async (url, address) => {
      pinned.push(address.address)
      if (url.pathname === '/first')
        return { statusCode: 302, headers: { location: '/second' }, body: Buffer.alloc(0) }
      return {
        statusCode: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) },
        body: png,
      }
    },
  })
  const loaded = await loader({
    source: { kind: 'url', url: 'https://images.example.test/first' },
    principal: { ownerId: 'fake-owner', transport: 'stdio' },
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5_000,
    maxBytes: 1_024 * 1024,
  })
  assert.deepEqual(resolved, ['images.example.test', 'images.example.test'])
  assert.deepEqual(pinned, ['8.8.8.8', '8.8.8.8'])
  assert.equal(loaded.width, 2)
  assert.equal(loaded.height, 1)
  assert.deepEqual(Buffer.from(loaded.bytes), png)
})

await test('remote redirect DNS rebinding to a private address stops before the second request', async () => {
  let lookupCount = 0
  let requestCount = 0
  const loader = createRemoteImageLoader({
    trustedHosts: ['images.example.test'],
    lookupAll: async () => {
      lookupCount += 1
      return [{ address: lookupCount === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]
    },
    requestForTesting: async () => {
      requestCount += 1
      return { statusCode: 302, headers: { location: '/again' }, body: Buffer.alloc(0) }
    },
  })
  await assert.rejects(
    loader({
      source: { kind: 'url', url: 'https://images.example.test/first' },
      principal: { ownerId: 'fake-owner', transport: 'stdio' },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5_000,
      maxBytes: 1_024,
    }),
    /prohibited address/u,
  )
  assert.equal(lookupCount, 2)
  assert.equal(requestCount, 1)
})
