import { constants as fsConstants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { createPhaseDeadlineScope } from './phase-deadline.js'
import {
  UI_STATE_DEV40_EXECUTION_V2_DEADLINE_ISO,
  UI_STATE_DEV40_EXECUTION_V2_ID,
  UI_STATE_DEV40_FREEZE_ID,
  UI_STATE_DEV40_PARENT_REGISTRATION_SHA256,
  UI_STATE_DEV40_PARENT_LEDGER_SHA256,
  UI_STATE_DEV40_ROOT,
  UI_STATE_DEV40_STUDY_ID,
  UI_STATE_DEV40_ZERO_QUERY_PROTOCOL_PATH,
  UI_STATE_DEV40_ZERO_QUERY_PROTOCOL_SHA256,
} from './ui-state-dev40-policy.js'

const ARTIFACT_ROOT = '/root/.codex/artifacts'
const DIGEST = z.string().regex(/^[a-f0-9]{64}$/u)
const refSchema = z.object({ path: z.string().min(1), sha256: DIGEST }).strict()
const counterSchema = z
  .object({
    inheritedLogicalAttempts: z.literal(32),
    inheritedPhysicalDispatches: z.literal(100),
    inheritedKnownCostUsd: z.literal(0.059908515),
    inheritedUnknownReserveUsd: z.literal(0.12),
    newLogicalCaseAttempts: z.literal(0),
    newPhysicalCalls: z.literal(0),
    newKnownCostUsd: z.literal(0),
    newUnknownReserveUsd: z.literal(0),
    dev40KnownCostUsd: z.literal(0),
    dev40UnknownReserveUsd: z.literal(0),
    dev40ConfirmedPhysicalCalls: z.literal(0),
    dev40UncertainPhysicalCalls: z.literal(0),
    inFlightReservations: z.literal(0),
    nativeSourceCasesExecuted: z.literal(0),
  })
  .strict()
const oldExecutionSchema = z
  .object({
    audit: refSchema,
    registration: refSchema,
    terminalStop: refSchema,
    campaignLedger: refSchema,
    launchIntent: refSchema,
    candidateCloseout: refSchema,
    controlCloseout: refSchema,
    studyCloseout: refSchema,
    studyBinding: refSchema,
    counters: counterSchema,
    closeout: z
      .object({
        candidateRows: z.literal(40),
        controlRows: z.literal(40),
        allRowsUnstarted: z.literal(true),
        logicalReceipts: z.literal(0),
        physicalReceipts: z.literal(0),
        qualificationResult: z.null(),
        qual120Eligible: z.literal(false),
      })
      .strict(),
    terminalErrorCode: z.literal('RangeError'),
    terminalScreen: z.literal('dev8'),
  })
  .strict()
const protocolSchema = z
  .object({
    schema: z.literal('h8a-zero-query-execution-v2-protocol-v1'),
    executionId: z.literal(UI_STATE_DEV40_EXECUTION_V2_ID),
    studyId: z.literal(UI_STATE_DEV40_STUDY_ID),
    freezeId: z.literal(UI_STATE_DEV40_FREEZE_ID),
    parentRegistrationSha256: z.literal(UI_STATE_DEV40_PARENT_REGISTRATION_SHA256),
    canonicalDeadlineIso: z.literal(UI_STATE_DEV40_EXECUTION_V2_DEADLINE_ISO),
    priorAuthority: z
      .object({
        path: z.literal(
          'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/independent-dev40-v2-preparation.json',
        ),
        sha256: DIGEST,
        sourceClosure: refSchema,
        sourceRoster: refSchema,
        sourceGroupSplit: refSchema,
        sourceUnionAudit: refSchema,
        registeredSources: refSchema,
        sourceStateProof: refSchema,
      })
      .strict(),
    priorFreeze: z
      .object({
        path: z.literal(
          'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/freeze-v2/phase-freeze.json',
        ),
        sha256: DIGEST,
        commitmentSha256: DIGEST,
        deadlineIso: z.literal('2026-11-02T12:11:51.738058Z'),
        cohortCommitmentSha256: DIGEST,
        sourceBytesManifestSha256: DIGEST,
        producerClosureSha256: DIGEST,
        recipeIdentities: z
          .array(
            z
              .object({
                profileId: z.string().min(1),
                recipeIdentitySha256: DIGEST,
                requestPolicyIdentitySha256: DIGEST,
              })
              .strict(),
          )
          .length(2),
      })
      .strict(),
    priorExecution: oldExecutionSchema,
    constraints: z
      .object({
        sameSourceClaims: z.literal(true),
        deadlineMayNotBeExtended: z.literal(true),
        paidRetries: z.literal(0),
        globalPhysicalCallLimit: z.literal(2000),
        dev40PhysicalCallLimit: z.literal(400),
        candidateCallsPerCase: z.literal(4),
        controlCallsPerCase: z.literal(6),
        candidateMaxUsdPerDispatch: z.literal(0.55),
        controlMaxUsdPerDispatch: z.literal(0.12),
      })
      .strict(),
  })
  .strict()
const priorAuditSchema = z
  .object({
    study: z.literal(UI_STATE_DEV40_STUDY_ID),
    execution: z.literal('original-first-attempt-terminal'),
    newLogicalCaseAttempts: z.literal(0),
    newPhysicalCalls: z.literal(0),
    nativeSourceCasesExecuted: z.literal(0),
    newKnownCostUsd: z.literal(0),
    newUnknownReserveUsd: z.literal(0),
    files: z.record(z.string(), DIGEST),
    note: z.string().min(1),
  })
  .passthrough()
const priorLedgerSchema = z
  .object({
    logicalAttemptCount: z.literal(32),
    physicalDispatchCount: z.literal(100),
    knownCostUsd: z.literal(0.059908515),
    unknownReserveUsd: z.literal(0.12),
    dev40KnownCostUsd: z.literal(0),
    dev40UnknownReserveUsd: z.literal(0),
    dev40ConfirmedPhysicalCalls: z.literal(0),
    dev40UncertainPhysicalCalls: z.literal(0),
    logicalAttempts: z.array(z.unknown()).length(0),
    inFlightReservations: z.array(z.unknown()).length(0),
    uncertainPhysicalDispatchCount: z.literal(0),
  })
  .passthrough()
const priorRegistrationSchema = z
  .object({
    schema: z.literal('h8a-ui-state-dev40-successor-registration-v1'),
    studyId: z.literal(UI_STATE_DEV40_STUDY_ID),
    parentRegistrationSha256: z.literal(UI_STATE_DEV40_PARENT_REGISTRATION_SHA256),
    parentLedgerSha256: DIGEST,
    publicCostProofSha256: DIGEST,
    canonicalStudyRoot: z.literal(UI_STATE_DEV40_ROOT),
    canonicalParentRoot: z.string().min(1),
    canonicalSuccessorRoot: z.string().min(1),
    globalPhysicalCallLimit: z.literal(2000),
    dev40PhysicalCallLimit: z.literal(400),
    candidateMaxCallsPerCase: z.literal(4),
    controlMaxCallsPerCase: z.literal(6),
    paidRetries: z.literal(0),
    inherited: z
      .object({
        physicalDispatchCount: z.literal(100),
        logicalAttemptCount: z.literal(32),
        knownCostUsd: z.literal(0.059908515),
        unknownReserveUsd: z.literal(0.12),
      })
      .passthrough(),
  })
  .passthrough()
const terminalSnapshotSchema = z
  .object({
    physicalDispatchCount: z.literal(100),
    logicalAttemptCount: z.literal(32),
    knownCostUsd: z.literal(0.059908515),
    unknownReserveUsd: z.literal(0.12),
    inFlightReservations: z.array(z.unknown()).length(0),
    resumeBlocked: z.literal(false),
  })
  .passthrough()
const priorTerminalSchema = z
  .object({
    schema: z.literal('h8a-independent-dev40-terminal-stop-v1'),
    screen: z.literal('dev8'),
    reportSha256: z.null(),
    ledgerSnapshot: terminalSnapshotSchema,
    errorCode: z.literal('RangeError'),
    terminalSha256: DIGEST,
  })
  .passthrough()
const closeoutRowSchema = z
  .object({
    caseState: z.literal('unstarted'),
    logicalReceiptIds: z.array(z.string()).length(0),
    physicalReceiptIds: z.array(z.string()).length(0),
  })
  .passthrough()
const armCloseoutSchema = z
  .object({
    outputRows: z.array(closeoutRowSchema).length(40),
  })
  .passthrough()
const studyCloseoutSchema = z
  .object({
    candidateRows: z.literal(40),
    controlRows: z.literal(40),
    pairedCoverageComplete: z.literal(false),
    missingPredictionRows: z.literal(80),
    qual120Eligible: z.literal(false),
    qualificationResult: z.null(),
  })
  .passthrough()
const priorAuthoritySchema = z
  .object({
    schema: z.literal('h8a-independent-dev40-v2-preparation-v1'),
    studyId: z.literal(UI_STATE_DEV40_STUDY_ID),
    freezeId: z.literal(UI_STATE_DEV40_FREEZE_ID),
    deadlineIso: z.literal('2026-11-02T12:11:51.738058Z'),
    parentRegistrationSha256: z.literal(UI_STATE_DEV40_PARENT_REGISTRATION_SHA256),
    sourcePolicyId: z.literal('native-visible-ui-state-v1'),
    sourceClosure: refSchema,
    sourceRoster: refSchema,
    sourceGroupSplit: refSchema,
    sourceUnionAudit: refSchema,
    registeredSources: refSchema,
    sourceStateProof: refSchema,
  })
  .passthrough()
const priorFreezeSchema = z
  .object({
    freezeId: z.literal(UI_STATE_DEV40_FREEZE_ID),
    phaseId: z.literal('h8a-flat-paired-dev40-v1'),
    phaseCounts: z.object({ totalCases: z.literal(40) }).passthrough(),
    deadlineIso: z.literal('2026-11-02T12:11:51.738058Z'),
    cohortCommitmentSha256: DIGEST,
    producerClosureSha256: DIGEST,
    sourceBytesManifestSha256: DIGEST,
    profileBindings: z
      .array(
        z
          .object({
            profileId: z.string().min(1),
            recipeIdentitySha256: DIGEST,
            requestPolicyIdentitySha256: DIGEST,
          })
          .passthrough(),
      )
      .length(2),
  })
  .passthrough()

type ZeroQueryExecutionV2Protocol = z.infer<typeof protocolSchema>

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function artifactPath(path: string): string {
  const absolute = resolve(ARTIFACT_ROOT, path)
  const rel = relative(ARTIFACT_ROOT, absolute)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new RangeError('Zero-query predecessor evidence path escapes the artifact root')
  return absolute
}

async function readPinned(path: string, expectedSha256: string): Promise<Buffer> {
  const absolute = artifactPath(path)
  const beforePath = await lstat(absolute)
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size > 16 * 1024 * 1024)
    throw new RangeError('Zero-query predecessor evidence is not a bounded regular file')
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const afterPath = await lstat(absolute)
    if (
      sha256(bytes) !== expectedSha256 ||
      BigInt(bytes.length) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(afterPath.dev) !== after.dev ||
      BigInt(afterPath.ino) !== after.ino ||
      (await realpath(absolute)) !== absolute
    )
      throw new RangeError('Zero-query predecessor evidence changed during verification')
    return bytes
  } finally {
    await handle.close()
  }
}

function parseJson(bytes: Uint8Array): unknown {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
  return value
}

function protocolRefs(protocol: ZeroQueryExecutionV2Protocol): Array<[string, string]> {
  const prior = protocol.priorExecution
  return [
    [protocol.priorAuthority.path, protocol.priorAuthority.sha256],
    [protocol.priorFreeze.path, protocol.priorFreeze.sha256],
    [prior.audit.path, prior.audit.sha256],
    [prior.registration.path, prior.registration.sha256],
    [prior.terminalStop.path, prior.terminalStop.sha256],
    [prior.campaignLedger.path, prior.campaignLedger.sha256],
    [prior.launchIntent.path, prior.launchIntent.sha256],
    [prior.candidateCloseout.path, prior.candidateCloseout.sha256],
    [prior.controlCloseout.path, prior.controlCloseout.sha256],
    [prior.studyCloseout.path, prior.studyCloseout.sha256],
    [prior.studyBinding.path, prior.studyBinding.sha256],
    ...Object.values(protocol.priorAuthority)
      .filter((value): value is z.infer<typeof refSchema> => typeof value === 'object')
      .map((ref) => [ref.path, ref.sha256] as [string, string]),
  ]
}

function assertProtocolBinding(protocol: ZeroQueryExecutionV2Protocol): void {
  const expectedRefs: Array<[string, string]> = [
    [
      'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/independent-dev40-v2-preparation.json',
      '3f37626cb763f32f264c90fe61f6c5487691f344143787e63311bb570d2d6c28',
    ],
    [
      'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/freeze-v2/phase-freeze.json',
      '9046fc15a9fc0a13a1d499bad7fa59147f78febaefd2755fde192c9d7030f02b',
    ],
    [
      'zorya-classifier-mcp-20261101/ui-state-dev40-v1/main/zero-query-first-execution-audit.json',
      '8c32ec2266e59d3fa81212c5236cbd1cb7713e3d70d045daca41d6e4ab302ad5',
    ],
    [
      'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-campaign-v1/registration.json',
      'ef6a800145e7f8bf87be499726eee6180119845e66321ceef6d024c4e12b6650',
    ],
    [
      'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-campaign-v1/terminal-stop.json',
      '80bce9ddeecfae1ff7b88d0ac4f66f14db9e61a7b4d9625753cf78b564079b11',
    ],
    [
      'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-campaign-v1/campaign-ledger.json',
      '1bb4600fa99280501251eed53d7ec00581b2fce7160ddeda314ea3e8757e0782',
    ],
    [
      'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-campaign-v1/launch-intents/dev8-launch.json',
      'f5ba83becd4bc5286a2ceaab2a01125f7a4a4c0d815f70d598436fa1e6dda1b6',
    ],
    [
      'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-campaign-v1/closeouts/dev40-candidate-closeout.json',
      '99d87afc37cb03cbaf6c310cffc7b47a2c22c2fc6f343badb897dcaacaac9601',
    ],
    [
      'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-campaign-v1/closeouts/dev40-control-closeout.json',
      '9f1102d347b61a2f4d7a25af10751049178851951d41758fc337ab6daec6e20b',
    ],
    [
      'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-campaign-v1/closeouts/successor-study-closeout.json',
      '4a7ca14ab2e7190043f09b4505f177a37bd8fe27db7ec6219f1b6632e43f7a76',
    ],
    [
      'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-study-binding.json',
      '9a5b7d3f0c591ade4bc7d9f83b28072ae42619889713f2a84e98314f4e28e9c7',
    ],
  ]
  const actualRefs = protocolRefs(protocol)
  if (
    protocol.canonicalDeadlineIso !== UI_STATE_DEV40_EXECUTION_V2_DEADLINE_ISO ||
    Date.parse(protocol.canonicalDeadlineIso) !== Date.parse(protocol.priorFreeze.deadlineIso) ||
    new Date(Date.parse(protocol.priorFreeze.deadlineIso)).toISOString() !==
      '2026-11-02T12:11:51.738Z' ||
    protocol.priorExecution.counters.inheritedLogicalAttempts !== 32 ||
    protocol.priorExecution.counters.inheritedPhysicalDispatches !== 100 ||
    expectedRefs.some(
      ([path, digest]) => !actualRefs.some((actual) => actual[0] === path && actual[1] === digest),
    )
  )
    throw new RangeError('Zero-query protocol changes prior execution identity or deadline')
}

export function validateZeroQueryExecutionV2Protocol(value: unknown): ZeroQueryExecutionV2Protocol {
  const protocol = protocolSchema.parse(value)
  assertProtocolBinding(protocol)
  return protocol
}

async function verifyPriorFiles(protocol: ZeroQueryExecutionV2Protocol): Promise<void> {
  const loaded = new Map<string, Buffer>()
  for (const [path, digest] of protocolRefs(protocol)) {
    const bytes = await readPinned(path, digest)
    if (path.endsWith('.json')) loaded.set(path, bytes)
  }
  const prior = protocol.priorExecution
  const json = (path: string) => {
    const bytes = loaded.get(path)
    if (!bytes) throw new RangeError('Pinned predecessor JSON evidence is missing')
    return parseJson(bytes)
  }
  const audit = priorAuditSchema.parse(json(prior.audit.path))
  const priorAuthority = priorAuthoritySchema.parse(json(protocol.priorAuthority.path))
  const priorFreeze = priorFreezeSchema.parse(json(protocol.priorFreeze.path))
  const priorFreezeBytes = loaded.get(protocol.priorFreeze.path)
  if (!priorFreezeBytes) throw new RangeError('Pinned predecessor freeze bytes are missing')
  priorLedgerSchema.parse(json(prior.campaignLedger.path))
  const registration = priorRegistrationSchema.parse(json(prior.registration.path))
  const terminal = priorTerminalSchema.parse(json(prior.terminalStop.path))
  const candidate = armCloseoutSchema.parse(json(prior.candidateCloseout.path))
  const control = armCloseoutSchema.parse(json(prior.controlCloseout.path))
  const study = studyCloseoutSchema.parse(json(prior.studyCloseout.path))
  const auditFiles = audit.files
  const sourceRefsMatch = (
    actual: z.infer<typeof refSchema>,
    expected: z.infer<typeof refSchema>,
  ) => actual.path === expected.path && actual.sha256 === expected.sha256
  const refFiles: Record<string, string> = {
    [prior.campaignLedger.path.replace(/^zorya-classifier-mcp-20261101\/ui-state-dev40-v1\//u, '')]:
      prior.campaignLedger.sha256,
    [prior.registration.path.replace(/^zorya-classifier-mcp-20261101\/ui-state-dev40-v1\//u, '')]:
      prior.registration.sha256,
    [prior.terminalStop.path.replace(/^zorya-classifier-mcp-20261101\/ui-state-dev40-v1\//u, '')]:
      prior.terminalStop.sha256,
    [prior.launchIntent.path.replace(/^zorya-classifier-mcp-20261101\/ui-state-dev40-v1\//u, '')]:
      prior.launchIntent.sha256,
    [prior.candidateCloseout.path.replace(
      /^zorya-classifier-mcp-20261101\/ui-state-dev40-v1\//u,
      '',
    )]: prior.candidateCloseout.sha256,
    [prior.controlCloseout.path.replace(
      /^zorya-classifier-mcp-20261101\/ui-state-dev40-v1\//u,
      '',
    )]: prior.controlCloseout.sha256,
    [prior.studyCloseout.path.replace(/^zorya-classifier-mcp-20261101\/ui-state-dev40-v1\//u, '')]:
      prior.studyCloseout.sha256,
  }
  if (
    audit.study !== protocol.studyId ||
    audit.newLogicalCaseAttempts !== 0 ||
    audit.newPhysicalCalls !== 0 ||
    audit.nativeSourceCasesExecuted !== 0 ||
    audit.newKnownCostUsd !== 0 ||
    audit.newUnknownReserveUsd !== 0 ||
    Object.entries(refFiles).some(([path, digest]) => auditFiles[path] !== digest) ||
    priorAuthority.deadlineIso !== protocol.priorFreeze.deadlineIso ||
    !sourceRefsMatch(priorAuthority.sourceClosure, protocol.priorAuthority.sourceClosure) ||
    !sourceRefsMatch(priorAuthority.sourceRoster, protocol.priorAuthority.sourceRoster) ||
    !sourceRefsMatch(priorAuthority.sourceGroupSplit, protocol.priorAuthority.sourceGroupSplit) ||
    !sourceRefsMatch(priorAuthority.sourceUnionAudit, protocol.priorAuthority.sourceUnionAudit) ||
    !sourceRefsMatch(priorAuthority.registeredSources, protocol.priorAuthority.registeredSources) ||
    !sourceRefsMatch(priorAuthority.sourceStateProof, protocol.priorAuthority.sourceStateProof) ||
    sha256(Buffer.from(JSON.stringify(parseJson(priorFreezeBytes)), 'utf8')) !==
      protocol.priorFreeze.commitmentSha256 ||
    priorFreeze.cohortCommitmentSha256 !== protocol.priorFreeze.cohortCommitmentSha256 ||
    priorFreeze.producerClosureSha256 !== protocol.priorFreeze.producerClosureSha256 ||
    priorFreeze.sourceBytesManifestSha256 !== protocol.priorFreeze.sourceBytesManifestSha256 ||
    JSON.stringify(
      priorFreeze.profileBindings.map(
        ({ profileId, recipeIdentitySha256, requestPolicyIdentitySha256 }) => ({
          profileId,
          recipeIdentitySha256,
          requestPolicyIdentitySha256,
        }),
      ),
    ) !== JSON.stringify(protocol.priorFreeze.recipeIdentities) ||
    terminal.errorCode !== 'RangeError' ||
    terminal.ledgerSnapshot.physicalDispatchCount !== 100 ||
    terminal.ledgerSnapshot.logicalAttemptCount !== 32 ||
    registration.studyId !== protocol.studyId ||
    registration.parentRegistrationSha256 !== UI_STATE_DEV40_PARENT_REGISTRATION_SHA256 ||
    registration.parentLedgerSha256 !== UI_STATE_DEV40_PARENT_LEDGER_SHA256 ||
    candidate.outputRows.some((row) => row.caseState !== 'unstarted') ||
    control.outputRows.some((row) => row.caseState !== 'unstarted') ||
    study.qualificationResult !== null ||
    study.qual120Eligible !== false
  )
    throw new RangeError('Prior execution does not prove a zero-query terminal stop')
}

export async function verifyZeroQueryExecutionV2Preconditions(): Promise<ZeroQueryExecutionV2Protocol> {
  const bytes = await readPinned(
    UI_STATE_DEV40_ZERO_QUERY_PROTOCOL_PATH,
    UI_STATE_DEV40_ZERO_QUERY_PROTOCOL_SHA256,
  )
  const protocol = validateZeroQueryExecutionV2Protocol(parseJson(bytes))
  await verifyPriorFiles(protocol)
  return protocol
}

export function assertExecutionV2DeadlineScope(deadlineIso: string): void {
  if (deadlineIso !== UI_STATE_DEV40_EXECUTION_V2_DEADLINE_ISO)
    throw new RangeError('Execution-v2 deadline differs from its zero-query protocol')
  const scope = createPhaseDeadlineScope(deadlineIso)
  try {
    scope.assertOpen()
  } finally {
    scope.dispose()
  }
}
