import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  nativeSelectorQualCompletedRunMatches,
  parseNativeSelectorQualCliArgs,
  runNativeSelectorQualCli,
} from './native-selector-qual-cli.js'
import { verifyNativeSelectorQualSourceClosure } from './dev-replay-cli.js'
import { buildOfflineAdmission } from './native-selector-qual-offline-fixtures.js'
import { PROFILE_CONTROL_ID, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID } from './constants.js'
import { hashIdentity } from './hash-identity.js'

function offlineHooks(
  namespaceRoot: string,
  fixture: Awaited<ReturnType<typeof buildOfflineAdmission>>,
  events: string[],
  faults: { dispose?: boolean; cleanup?: boolean } = {},
) {
  return {
    offlineTestOnly: true as const,
    namespaceRoot,
    protocolPath: fixture.protocolPath,
    admission: fixture.admission,
    async createRuntime() {
      events.push('runtime-created')
      assert.ok(
        JSON.parse(await readFile(join(namespaceRoot, 'admission', 'registration.json'), 'utf8')),
      )
      const makePort = (
        profileId: typeof PROFILE_CONTROL_ID | typeof PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
      ) => ({
        async execute(input: { opaqueCaseId: string }) {
          return {
            outputRow: {
              schema: 'h8a-fresh-output-row-v1' as const,
              opaqueCaseId: input.opaqueCaseId,
              profileId,
              executionValidity: 'valid' as const,
              caseState: 'not_found' as const,
              box: null,
              cutoutPresent: false,
              maskPackedSha256: null,
              logicalReceiptIds: [1],
              physicalReceiptIds: [],
            },
            logicalReceipts: [
              {
                logicalId: 1,
                opaqueCaseId: input.opaqueCaseId,
                profileId,
                requestSha256: hashIdentity({ opaqueCaseId: input.opaqueCaseId, profileId }),
                physicalIds: [],
                outcome: 'resolved' as const,
              },
            ],
            physicalReceipts: [],
          }
        },
      })
      return {
        candidatePort: makePort(PROFILE_NATIVE_SELECTOR_CANDIDATE_ID),
        controlPort: makePort(PROFILE_CONTROL_ID),
        artifacts: {
          masksBySha256: new Map(),
          cutoutsBySha256: new Map(),
          cutoutsByProfileAndCase: new Map(),
        },
        fetchJournal: [],
        async dispose() {
          events.push('runtime-disposed')
          if (faults.dispose) throw new Error('offline runtime dispose failure')
        },
      }
    },
    ...(faults.cleanup
      ? {
          async removeLaunchRoot(_path: string) {
            events.push('launch-cleanup-failed')
            throw new Error('offline launch cleanup failure')
          },
        }
      : {}),
  }
}

await test('QUAL CLI requires an explicit command and exact protocol pin', () => {
  const sha256 = 'a'.repeat(64)
  assert.deepEqual(
    parseNativeSelectorQualCliArgs([
      'register',
      '--protocol',
      '/offline/protocol.json',
      '--protocol-sha256',
      sha256,
    ]),
    {
      command: 'register',
      protocolPath: '/offline/protocol.json',
      protocolSha256: sha256,
      allowPaid: false,
    },
  )
  assert.throws(() =>
    parseNativeSelectorQualCliArgs([
      'run',
      '--protocol',
      '/offline/protocol.json',
      '--protocol-sha256',
      sha256,
    ]),
  )
  assert.equal(
    parseNativeSelectorQualCliArgs([
      'run',
      '--protocol',
      '/offline/protocol.json',
      '--protocol-sha256',
      sha256,
      '--allow-paid',
    ]).allowPaid,
    true,
  )
  assert.throws(() =>
    parseNativeSelectorQualCliArgs([
      'register',
      '--protocol',
      '/offline/protocol.json',
      '--protocol-sha256',
      'bad',
    ]),
  )
  assert.throws(() =>
    parseNativeSelectorQualCliArgs([
      'closeout',
      '--protocol',
      '/offline/protocol.json',
      '--protocol-sha256',
      sha256,
      '--allow-paid',
    ]),
  )
})

await test('QUAL source closure rejects a changed producer commit before checkout or provider access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-selector-qual-closure-test-'))
  const path = join(root, 'closure.json')
  const bytes = Buffer.from(
    JSON.stringify({
      schema: 'h8a-producer-closure-files-v1',
      sourceCommit: 'f'.repeat(40),
      files: [],
    }),
  )
  await writeFile(path, bytes, { flag: 'wx' })
  try {
    await assert.rejects(
      verifyNativeSelectorQualSourceClosure({
        closurePath: path,
        closureSha256: createHash('sha256').update(bytes).digest('hex'),
        expectedSourceCommit: 'e'.repeat(40),
        repositoryRoot: process.cwd(),
      }),
      /differs from its selected DEV parent/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('QUAL run rejects a foreign protocol path before provider credential or runtime setup', async () => {
  await assert.rejects(
    runNativeSelectorQualCli(
      [
        'run',
        '--protocol',
        '/offline/protocol.json',
        '--protocol-sha256',
        'a'.repeat(64),
        '--allow-paid',
      ],
      process.cwd(),
    ),
    /closed namespace path/u,
  )
})

await test('QUAL readonly closeout accepts only a result recorded after disposal and complete cleanup', () => {
  const result = {
    schema: 'h8a-native-selector-qual120-result-v1',
    protocolSha256: 'a'.repeat(64),
    candidateCloseoutSha256: 'b'.repeat(64),
    controlCloseoutSha256: 'c'.repeat(64),
    gate: { executionValid: true, pairedCoverageComplete: true, qualityPass: true },
    runtimeDisposed: true,
    cleanupComplete: true,
  }
  const expected = {
    completedRun: result,
    runFailure: null,
    protocolSha256: result.protocolSha256,
    candidateCloseoutSha256: result.candidateCloseoutSha256,
    controlCloseoutSha256: result.controlCloseoutSha256,
    gate: result.gate,
  }
  assert.equal(nativeSelectorQualCompletedRunMatches(expected), true)
  assert.equal(
    nativeSelectorQualCompletedRunMatches({
      ...expected,
      completedRun: { ...result, cleanupComplete: false },
    }),
    false,
  )
  assert.equal(
    nativeSelectorQualCompletedRunMatches({
      ...expected,
      completedRun: { ...result, runtimeDisposed: false },
    }),
    false,
  )
  assert.equal(
    nativeSelectorQualCompletedRunMatches({
      ...expected,
      runFailure: { schema: 'h8a-native-selector-qual120-run-failure-v1', cleanupComplete: false },
    }),
    false,
  )
})

await test('offline QUAL CLI runs the shared register, run, and closeout path with temp admission', async () => {
  const namespaceRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-cli-e2e-'))
  const events: string[] = []
  try {
    const fixture = await buildOfflineAdmission(namespaceRoot)
    const args = (command: 'register' | 'run' | 'closeout') => [
      command,
      '--protocol',
      fixture.protocolPath,
      '--protocol-sha256',
      fixture.admission.protocolSha256,
      ...(command === 'run' ? ['--allow-paid'] : []),
    ]
    const hooks = offlineHooks(namespaceRoot, fixture, events)
    await runNativeSelectorQualCli(args('register'), process.cwd(), hooks)
    events.push('registered')
    await runNativeSelectorQualCli(args('run'), process.cwd(), hooks)
    events.push('run-complete')
    await runNativeSelectorQualCli(args('closeout'), process.cwd(), hooks)
    events.push('closeout-complete')
    assert.equal(events.filter((event) => event === 'runtime-disposed').length, 1)
    assert.deepEqual(events, [
      'registered',
      'runtime-created',
      'runtime-disposed',
      'run-complete',
      'closeout-complete',
    ])
    const ledger = JSON.parse(
      await readFile(join(namespaceRoot, 'campaign-ledger.json'), 'utf8'),
    ) as {
      logicalAttemptCount: number
      phasePhysicalCalls: number
    }
    assert.equal(ledger.logicalAttemptCount, 340)
    assert.equal(ledger.phasePhysicalCalls, 0)
    const review = JSON.parse(
      await readFile(
        join(namespaceRoot, 'execution', 'qualification-closeout-review.json'),
        'utf8',
      ),
    ) as { executionValidity: string; runtimeDisposed: boolean }
    assert.equal(review.executionValidity, 'valid')
    assert.equal(review.runtimeDisposed, true)
  } finally {
    await rm(namespaceRoot, { recursive: true, force: true })
  }
})

await test('offline QUAL CLI records disposal and launch cleanup failures as incomplete', async () => {
  for (const fault of ['dispose', 'cleanup'] as const) {
    const namespaceRoot = await mkdtemp(join(tmpdir(), `native-selector-qual-cli-${fault}-`))
    const events: string[] = []
    try {
      const fixture = await buildOfflineAdmission(namespaceRoot)
      const args = (command: 'register' | 'run' | 'closeout') => [
        command,
        '--protocol',
        fixture.protocolPath,
        '--protocol-sha256',
        fixture.admission.protocolSha256,
        ...(command === 'run' ? ['--allow-paid'] : []),
      ]
      const hooks = offlineHooks(namespaceRoot, fixture, events, { [fault]: true })
      await runNativeSelectorQualCli(args('register'), process.cwd(), hooks)
      await assert.rejects(
        runNativeSelectorQualCli(args('run'), process.cwd(), hooks),
        new RegExp(
          `offline ${fault === 'dispose' ? 'runtime dispose' : 'launch cleanup'} failure`,
          'u',
        ),
      )
      await runNativeSelectorQualCli(args('closeout'), process.cwd(), hooks)
      const runFailure = JSON.parse(
        await readFile(join(namespaceRoot, 'execution', 'run-failure.json'), 'utf8'),
      ) as { runtimeDisposed: boolean; cleanupComplete: boolean }
      assert.equal(runFailure.runtimeDisposed, fault === 'cleanup')
      assert.equal(runFailure.cleanupComplete, fault === 'dispose')
      const review = JSON.parse(
        await readFile(
          join(namespaceRoot, 'execution', 'qualification-closeout-review.json'),
          'utf8',
        ),
      ) as { executionValidity: string; runtimeDisposed: boolean }
      assert.equal(review.executionValidity, 'incomplete')
      assert.equal(review.runtimeDisposed, false)
      await assert.rejects(
        readFile(join(namespaceRoot, 'execution', 'qualification-result.json')),
        { code: 'ENOENT' },
      )
    } finally {
      await rm(namespaceRoot, { recursive: true, force: true })
    }
  }
})

await test('offline QUAL CLI rejects missing registration, orphaned launch, and held lock before runtime', async () => {
  for (const scenario of ['missing-registration', 'orphaned-launch', 'held-lock'] as const) {
    const namespaceRoot = await mkdtemp(join(tmpdir(), `native-selector-qual-cli-${scenario}-`))
    const events: string[] = []
    try {
      const fixture = await buildOfflineAdmission(namespaceRoot)
      const hooks = offlineHooks(namespaceRoot, fixture, events)
      const runArgs = [
        'run',
        '--protocol',
        fixture.protocolPath,
        '--protocol-sha256',
        fixture.admission.protocolSha256,
        '--allow-paid',
      ]
      if (scenario !== 'missing-registration')
        await runNativeSelectorQualCli(
          [
            'register',
            '--protocol',
            fixture.protocolPath,
            '--protocol-sha256',
            fixture.admission.protocolSha256,
          ],
          process.cwd(),
          hooks,
        )
      if (scenario === 'orphaned-launch') {
        await mkdir(join(namespaceRoot, 'execution'), { recursive: true })
        await writeFile(
          join(namespaceRoot, 'execution', 'qualification-launch-intent.json'),
          '{"orphan":true}',
          { flag: 'wx' },
        )
      } else if (scenario === 'held-lock') {
        await mkdir(join(namespaceRoot, 'execution'), { recursive: true })
        await writeFile(join(namespaceRoot, 'execution', '.qual-runner.lock'), '{}', { flag: 'wx' })
      }
      await assert.rejects(
        runNativeSelectorQualCli(runArgs, process.cwd(), hooks),
        scenario === 'missing-registration'
          ? { code: 'ENOENT' }
          : scenario === 'orphaned-launch'
            ? /immutable/u
            : /lock acquisition (?:failed|timed out)/u,
      )
      assert.equal(events.includes('runtime-created'), false)
      assert.equal(events.includes('runtime-disposed'), false)
    } finally {
      await rm(namespaceRoot, { recursive: true, force: true })
    }
  }
})

await test('offline QUAL CLI refuses a temp namespace different from its privately admitted root', async () => {
  const admissionRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-cli-authority-'))
  const redirectedRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-cli-redirect-'))
  const events: string[] = []
  try {
    const fixture = await buildOfflineAdmission(admissionRoot)
    const hooks = offlineHooks(redirectedRoot, fixture, events)
    await assert.rejects(
      runNativeSelectorQualCli(
        [
          'register',
          '--protocol',
          fixture.protocolPath,
          '--protocol-sha256',
          fixture.admission.protocolSha256,
        ],
        process.cwd(),
        hooks,
      ),
      /verified admission in a temp namespace/u,
    )
    assert.equal(events.includes('runtime-created'), false)
    await assert.rejects(readFile(join(redirectedRoot, 'admission', 'registration.json')), {
      code: 'ENOENT',
    })
  } finally {
    await rm(admissionRoot, { recursive: true, force: true })
    await rm(redirectedRoot, { recursive: true, force: true })
  }
})
