import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  NATIVE_SELECTOR_QUAL_FREEZE_ID,
  NATIVE_SELECTOR_QUAL_STUDY_ID,
  hashQualProtocolFileBytes,
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
