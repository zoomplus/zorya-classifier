import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { hashIdentity } from './hash-identity.js'
import { verifyNativeSelectorQualHistoricalExclusions } from './native-selector-qual-historical-exclusions.js'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

await test('parent-linked historical exclusions retain group-only and Pillow-only evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-selector-qual-history-'))
  try {
    const devSourceGroupIds = Array.from({ length: 24 }, (_, index) => `dev-${index}`)
    const exclusionSourceGroupIds = Array.from({ length: 440 }, (_, index) => `excluded-${index}`)
    const normalize = (value: string): string => value.replace(/\/+$/u, '')
    const groupSplit = {
      schema: 'h8a-dev-source-group-split-v1',
      devSourceGroupIds,
      qualificationSourceGroupIds: [],
      exclusionSourceGroupIds,
      devCommitmentSha256: hashIdentity(devSourceGroupIds.map(normalize).sort()),
      qualificationCommitmentSha256: hashIdentity([]),
      exclusionCommitmentSha256: hashIdentity(exclusionSourceGroupIds.map(normalize).sort()),
    }
    const pixels = {
      schema: 'study2-prior-pixel-exclusion-index-v1',
      algorithm: 'benchmarks/v03/fresh-dev/imaging.py:perceptual_hash64_from_rgb',
      sha256Implementation: 'ea06f305375ced9341d07ef5afcdc615f0b93afc340939a2bc2c654bd97495f1',
      maximumDistanceRejected: 4,
      rows: Array.from({ length: 348 }, (_, index) => ({
        encodedSha256: index.toString(16).padStart(64, '0'),
        decodedRgbSha256: (index + 1).toString(16).padStart(64, '0'),
        perceptualHash64: index.toString(16).padStart(16, '0'),
      })),
    }
    const groupPath = join(root, 'source-group-split.json')
    const pixelPath = join(root, 'historical-pixels.json')
    await mkdir(root, { recursive: true })
    const groupBytes = Buffer.from(JSON.stringify(groupSplit))
    const pixelBytes = Buffer.from(JSON.stringify(pixels))
    await writeFile(groupPath, groupBytes)
    await writeFile(pixelPath, pixelBytes)
    const preparationPath = join(root, 'preparation.json')
    const preparationBytes = Buffer.from(
      JSON.stringify({
        schema: 'h8a-independent-dev40-v2-preparation-v1',
        sourceGroupSplit: { path: 'source-group-split.json', sha256: sha256(groupBytes) },
        historicalPixels: { path: 'historical-pixels.json', sha256: sha256(pixelBytes) },
      }),
    )
    await writeFile(preparationPath, preparationBytes)
    const result = await verifyNativeSelectorQualHistoricalExclusions({
      offlineNamespaceRoot: root,
      sourceAuditReferences: [{ path: preparationPath, sha256: sha256(preparationBytes) }],
      expectedDevSourceGroups: devSourceGroupIds,
      exposed: {
        sourceGroupSplit: {
          path: groupPath,
          sha256: sha256(groupBytes),
          bytes: groupBytes.byteLength,
        },
        historicalPixels: {
          path: pixelPath,
          sha256: sha256(pixelBytes),
          bytes: pixelBytes.byteLength,
        },
      },
    })
    assert.equal(result.devSourceGroups.length, 24)
    assert.equal(result.sourceGroups.length, 440)
    assert.equal(result.encodedHashes.length, 348)
    assert.equal(result.pillowRgbHashes.length, 348)
    assert.equal(result.perceptualHashes.length, 348)
    assert.equal(Object.hasOwn(result, 'sharpRgbHashes'), false)
    assert.equal(Object.hasOwn(pixels.rows[0]!, 'sourceGroup'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('historical refs must remain linked to the parent preparation and exact source counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-selector-qual-history-bad-'))
  try {
    const preparationPath = join(root, 'preparation.json')
    await writeFile(
      preparationPath,
      JSON.stringify({
        schema: 'h8a-independent-dev40-v2-preparation-v1',
        sourceGroupSplit: { path: 'groups.json', sha256: 'a'.repeat(64) },
        historicalPixels: { path: 'pixels.json', sha256: 'b'.repeat(64) },
      }),
    )
    const bytes = await readFile(preparationPath)
    await assert.rejects(
      verifyNativeSelectorQualHistoricalExclusions({
        offlineNamespaceRoot: resolve(root),
        sourceAuditReferences: [{ path: preparationPath, sha256: sha256(bytes) }],
        exposed: {
          sourceGroupSplit: {
            path: join(root, 'groups.json'),
            sha256: 'c'.repeat(64),
            bytes: 1,
          },
          historicalPixels: {
            path: join(root, 'pixels.json'),
            sha256: 'b'.repeat(64),
            bytes: 1,
          },
        },
      }),
      /parent-linked preparation/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
