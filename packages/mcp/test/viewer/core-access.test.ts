import assert from 'node:assert/strict'
import test from 'node:test'
import type { CoreApplication, Principal } from '../../src/contracts.js'
import { createCoreViewerAccess } from '../../src/viewer/core-access.js'

await test('viewer adapter uses authenticated private resource URIs and owns artifact bytes', async () => {
  const calls: Array<{ uri: string; principal: Principal }> = []
  const artifactBytes = Uint8Array.from([1, 2, 3, 4])
  const app: CoreApplication = {
    async invoke() {
      return {}
    },
    async readResource(input) {
      calls.push({ uri: input.uri, principal: input.principal })
      if (input.uri === 'zorya://jobs/job-1') {
        return {
          kind: 'json',
          mediaType: 'application/json',
          value: {
            id: 'job-1',
            operation: 'locate',
            state: 'succeeded',
            createdAt: 1,
            deadlineAt: 2,
            artifacts: [
              {
                id: 'source-a',
                role: 'source',
                mediaType: 'image/png',
                byteLength: 50,
                expiresAt: 100,
                width: 640,
                height: 480,
              },
            ],
            result: {
              operation: 'locate',
              result: {
                geometryKind: 'coarse-region',
                result: {
                  status: 'located',
                  region: { left: 20, top: 30, width: 90, height: 120 },
                },
              },
            },
          },
        }
      }
      return { kind: 'binary', mediaType: 'application/octet-stream', bytes: artifactBytes }
    },
    async shutdown() {},
  }
  const viewer = createCoreViewerAccess(app)
  const principal: Principal = {
    ownerId: 'verified-owner',
    transport: 'http',
    identity: { issuer: 'https://issuer.example.test', subject: 'subject-a', scopes: ['read'] },
  }
  const controller = new AbortController()
  const document = await viewer.readDocument({
    principal,
    jobId: 'job-1',
    signal: controller.signal,
    deadlineAt: Date.now() + 1_000,
  })
  assert.ok(document)
  assert.equal(document.ownerId, principal.ownerId)
  assert.deepEqual(document.box, { x: 20, y: 30, width: 90, height: 120 })
  assert.equal(document.geometryKind, 'coarse-region')
  const artifact = await viewer.readArtifact({
    principal,
    artifactId: 'source-a',
    signal: controller.signal,
    deadlineAt: Date.now() + 1_000,
    maxBytes: 100,
  })
  assert.ok(artifact)
  assert.notEqual(artifact.bytes, artifactBytes)
  artifact.bytes[0] = 99
  assert.equal(artifactBytes[0], 1)
  assert.deepEqual(
    calls.map((call) => call.uri),
    ['zorya://jobs/job-1', 'zorya://artifacts/source-a'],
  )
  assert.ok(calls.every((call) => call.principal.ownerId === principal.ownerId))
})

await test('viewer adapter maps cropped packed-mask coordinates back to the oriented source', async () => {
  const app: CoreApplication = {
    async invoke() {
      return {}
    },
    async readResource() {
      return {
        kind: 'json',
        mediaType: 'application/json',
        value: {
          id: 'extract-job',
          operation: 'extract',
          state: 'succeeded',
          createdAt: 1,
          deadlineAt: 2,
          artifacts: [
            {
              id: 'source-b',
              role: 'source',
              mediaType: 'image/jpeg',
              byteLength: 90,
              expiresAt: 100,
              width: 640,
              height: 480,
            },
            {
              id: 'cutout-b',
              role: 'cutout',
              mediaType: 'image/png',
              byteLength: 40,
              expiresAt: 100,
              width: 12,
              height: 9,
            },
            {
              id: 'mask-b',
              role: 'mask',
              mediaType: 'application/octet-stream',
              byteLength: 14,
              expiresAt: 100,
              width: 12,
              height: 9,
              encoding: 'binary-lsb0',
            },
          ],
          result: {
            operation: 'extract',
            result: {
              status: 'extracted',
              location: {
                status: 'located',
                kind: 'whole-object',
                region: { left: 100, top: 200, width: 12, height: 9 },
              },
              region: { left: 92, top: 198, width: 12, height: 9 },
              artifacts: [],
            },
          },
        },
      }
    },
    async shutdown() {},
  }
  const viewer = createCoreViewerAccess(app)
  const principal: Principal = {
    ownerId: 'verified-owner',
    transport: 'http',
    identity: { issuer: 'https://issuer.example.test', subject: 'subject-b', scopes: ['read'] },
  }
  const document = await viewer.readDocument({
    principal,
    jobId: 'extract-job',
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 1_000,
  })
  assert.ok(document)
  assert.equal(document.source.width, 640)
  assert.deepEqual(document.box, { x: 92, y: 198, width: 12, height: 9 })
  assert.deepEqual(document.maskRegion, { x: 92, y: 198, width: 12, height: 9 })
  assert.equal(document.mask?.encoding, 'binary-lsb0')
  assert.equal(document.cutout?.width, 12)
})
