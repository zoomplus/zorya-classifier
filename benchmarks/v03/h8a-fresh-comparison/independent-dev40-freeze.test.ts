import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assembleIndependentDev40V2FromDisk,
  assertSuccessorFreezeAdmission,
} from './independent-dev40-freeze.js'
import { validateIndependentDev40SourceRoster } from './dev-freeze-assembly.js'

await test('independent freeze API refuses caller-selected roots before filesystem access', async () => {
  await assert.rejects(
    assembleIndependentDev40V2FromDisk({
      authorityPath: join(tmpdir(), 'unregistered-authority.json'),
      authoritySha256: 'a'.repeat(64),
      sourceRoot: tmpdir(),
      outputDirectory: join(tmpdir(), 'unregistered-freeze'),
    }),
    { name: 'ZodError' },
  )
})

await test('a synthetic or caller-constructed freeze cannot pass successor admission', async () => {
  const ledger = {
    assertResumeAllowed() {
      assert.fail('unverified freeze reached ledger admission')
    },
  }
  await assert.rejects(
    Reflect.apply(assertSuccessorFreezeAdmission, undefined, [{ freeze: {} }, ledger]),
    /not verified by the independent DEV40 loader/u,
  )
})

await test('the reviewed 30-row photo and map dry-run cannot satisfy a DEV40 roster', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    opaqueCaseId: `offline-${String(index).padStart(2, '0')}`,
    familySlug: index < 20 ? `photo-${index}` : `map-${index}`,
    predeclaredStateId: `state-${index}`,
    stratum: index < 20 ? 'photo' : 'map',
    sourceGroup: `source-${index}`,
    expectedPresence: index % 3 === 0 ? 'absent' : 'present',
    sourceSha256: 'a'.repeat(64),
    targetTaskSha256: 'b'.repeat(64),
  }))
  assert.throws(
    () =>
      validateIndependentDev40SourceRoster({
        schema: 'h8a-independent-dev40-source-roster-v1',
        studyId: 'ui-state-dev40-v1',
        rows,
      }),
    /Array must contain exactly 40 element\(s\)/u,
  )
})
