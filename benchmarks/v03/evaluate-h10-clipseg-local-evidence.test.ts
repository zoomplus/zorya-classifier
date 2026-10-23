import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  MINIMAL_DEV_MANIFEST_SHA256,
  verifyMinimalDevManifestFile,
} from './evaluate-h10-clipseg.js'

await test('verifyMinimalDevManifestFile matches pinned minimal DEV digest', async () => {
  const errors: string[] = []
  const manifest = await verifyMinimalDevManifestFile(errors)
  assert.ok(manifest)
  assert.equal(errors.length, 0)
  assert.equal(manifest.rows.length, 12)
  assert.ok(manifest.rows.every((row) => row.source_sha256.length === 64))
  const bytes = await readFile('/root/work/zorya-classifier/.run/v03/h10/minimal-inputs.json')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), MINIMAL_DEV_MANIFEST_SHA256)
})
