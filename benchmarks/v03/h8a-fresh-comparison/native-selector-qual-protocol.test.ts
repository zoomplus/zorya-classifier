import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  NATIVE_SELECTOR_QUAL_FREEZE_ID,
  NATIVE_SELECTOR_QUAL_STUDY_ID,
  hashQualProtocolFileBytes,
  assertNativeSelectorQualExclusionAuditCoverage,
  nativeSelectorQualProtocolSchema,
  nativeSelectorQualSourceManifestSchema,
} from './native-selector-qual-protocol.js'

const digest = 'a'.repeat(64)

await test('QUAL protocol identity hashes exact raw JSON bytes', () => {
  const raw = Buffer.from('{\n  "b": 2,\n  "a": 1\n}\n')
  assert.equal(hashQualProtocolFileBytes(raw), createHash('sha256').update(raw).digest('hex'))
  assert.notEqual(
    hashQualProtocolFileBytes(raw),
    hashQualProtocolFileBytes(Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))))),
  )
})

await test('QUAL protocol rejects an open namespace or unpinned fields', () => {
  assert.equal(nativeSelectorQualProtocolSchema.safeParse({}).success, false)
  assert.equal(
    nativeSelectorQualProtocolSchema.safeParse({
      schema: 'h8a-native-selector-qual120-protocol-v1',
      studyId: NATIVE_SELECTOR_QUAL_STUDY_ID,
      freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
      phaseId: 'h8a-native-selector-paired-qual120-v1',
      extraField: 'not closed',
    }).success,
    false,
  )
})

await test('QUAL source manifest requires source-aligned 64-bit pHash values', () => {
  const sources = Array.from({ length: 120 }, (_, index) => ({
    caseId: `qual-${index}`,
    path: `/offline/${index}.jpg`,
    sha256: digest,
    rgbPixelsSha256: 'b'.repeat(64),
    pillowCanonicalRgbSha256: 'c'.repeat(64),
    bytes: 100 + index,
    perceptualHash: '0123456789abcdef',
    sourceGroup: `group-${index}`,
    rightsCommitmentSha256: 'd'.repeat(64),
    annotationProvenanceSha256: 'e'.repeat(64),
  }))
  const manifest = nativeSelectorQualSourceManifestSchema.parse({
    schema: 'h8a-native-selector-qual120-source-manifest-v1',
    freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
    sources,
  })
  assert.equal(manifest.sources.length, 120)
  assert.equal(
    nativeSelectorQualSourceManifestSchema.safeParse({
      schema: 'h8a-native-selector-qual120-source-manifest-v1',
      freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
      sources: sources.map((source, index) =>
        index === 0 ? { ...source, perceptualHash: 'not-a-phash' } : source,
      ),
    }).success,
    false,
  )
})

await test('historical QUAL exclusions merge as deduplicated sets without fabricating Sharp history', () => {
  const explicitSources = [
    {
      caseId: 'explicit-a',
      sourceBytesSha256: 'a'.repeat(64),
      sharpRuntimeDecodedRgbSha256: 'b'.repeat(64),
      pillowCanonicalRgbSha256: 'c'.repeat(64),
      perceptualHash: '1111111111111111',
      sourceGroup: 'historic-group/',
    },
    {
      caseId: 'explicit-b',
      sourceBytesSha256: 'd'.repeat(64),
      sharpRuntimeDecodedRgbSha256: 'e'.repeat(64),
      pillowCanonicalRgbSha256: 'f'.repeat(64),
      perceptualHash: '2222222222222222',
      sourceGroup: 'historic-group',
    },
  ]
  const historical = {
    devSourceGroups: ['dev-group'],
    sourceGroups: ['historic-group', 'prior-group'],
    encodedHashes: ['a'.repeat(64), 'g'.repeat(64)],
    pillowRgbHashes: ['f'.repeat(64), 'h'.repeat(64)],
    perceptualHashes: ['1111111111111111', '3333333333333333'],
  }
  const audit = {
    devSourceGroups: ['dev-group'],
    excludedEncodedHashes: ['a'.repeat(64), 'd'.repeat(64), 'g'.repeat(64)],
    excludedRgbHashes: [
      'b'.repeat(64),
      'c'.repeat(64),
      'e'.repeat(64),
      'f'.repeat(64),
      'h'.repeat(64),
    ],
    excludedPerceptualHashes: ['1111111111111111', '2222222222222222', '3333333333333333'],
    excludedSourceGroups: ['historic-group', 'prior-group'],
  }
  assert.doesNotThrow(() =>
    assertNativeSelectorQualExclusionAuditCoverage({ audit, explicitSources, historical }),
  )
  assert.throws(
    () =>
      assertNativeSelectorQualExclusionAuditCoverage({
        audit: { ...audit, excludedSourceGroups: ['historic-group'] },
        explicitSources,
        historical,
      }),
    /pinned source manifest/u,
  )
  assert.throws(
    () =>
      assertNativeSelectorQualExclusionAuditCoverage({
        audit: {
          ...audit,
          excludedPerceptualHashes: [...audit.excludedPerceptualHashes, '1111111111111111'],
        },
        explicitSources,
        historical,
      }),
    /pinned source manifest/u,
  )
})

await test('legacy explicit-only exclusion rows retain multiset comparison behavior', () => {
  const source = {
    caseId: 'legacy-explicit',
    sourceBytesSha256: 'a'.repeat(64),
    sharpRuntimeDecodedRgbSha256: 'b'.repeat(64),
    pillowCanonicalRgbSha256: 'c'.repeat(64),
    perceptualHash: '1111111111111111',
    sourceGroup: 'same-group',
  }
  const audit = {
    devSourceGroups: [],
    excludedEncodedHashes: [source.sourceBytesSha256, source.sourceBytesSha256],
    excludedRgbHashes: [
      source.sharpRuntimeDecodedRgbSha256,
      source.pillowCanonicalRgbSha256,
      source.sharpRuntimeDecodedRgbSha256,
      source.pillowCanonicalRgbSha256,
    ],
    excludedPerceptualHashes: [source.perceptualHash, source.perceptualHash],
    excludedSourceGroups: [source.sourceGroup, source.sourceGroup],
  }
  assert.doesNotThrow(() =>
    assertNativeSelectorQualExclusionAuditCoverage({
      audit,
      explicitSources: [source, source],
    }),
  )
  assert.throws(
    () =>
      assertNativeSelectorQualExclusionAuditCoverage({
        audit: { ...audit, excludedSourceGroups: [source.sourceGroup] },
        explicitSources: [source, source],
      }),
    /pinned source manifest/u,
  )

  const trailingSlashSource = { ...source, sourceGroup: 'legacy/' }
  const trailingSlashAudit = { ...audit, excludedSourceGroups: ['legacy/', 'legacy/'] }
  assert.doesNotThrow(() =>
    assertNativeSelectorQualExclusionAuditCoverage({
      audit: trailingSlashAudit,
      explicitSources: [trailingSlashSource, trailingSlashSource],
    }),
  )
  assert.throws(
    () =>
      assertNativeSelectorQualExclusionAuditCoverage({
        audit: { ...trailingSlashAudit, excludedSourceGroups: ['legacy', 'legacy'] },
        explicitSources: [trailingSlashSource, trailingSlashSource],
      }),
    /pinned source manifest/u,
  )
})
