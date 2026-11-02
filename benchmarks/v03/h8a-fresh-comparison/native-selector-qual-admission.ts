import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { z } from 'zod'
import {
  PHASE_NATIVE_SELECTOR_DEV40_ID,
  PROFILE_CONTROL_ID,
  PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
} from './constants.js'
import {
  evaluatorPrivateAnnotationBundleSchema,
  immutableCloseoutSchema,
  phaseFreezeSchema,
} from './schemas.js'
import type { PhaseFreeze, EvaluatorPrivateAnnotationBundle, ImmutableCloseout } from './schemas.js'
import {
  validateImmutableCloseouts,
  evaluateDev40Gate,
  joinCloseoutsWithPrivateAnnotations,
} from './evaluator.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { buildCaseArtifactIdentity, devScreenReportSchema } from './dev-screen-runner.js'
import { buildDevScreenSelection } from './dev-screen-sampling.js'
import {
  validateNativeSelectorDev40LedgerForQual,
  validateNativeSelectorCorrectedDev40LedgerForQual,
} from './dev-replay-ledger.js'
import {
  nativeSelectorReplayProtocolSchema,
  nativeSelectorCorrectedReplayProtocolSchema,
} from './dev-replay-admission.js'
import {
  NATIVE_SELECTOR_PRICE_PROOF,
  NATIVE_SELECTOR_ROOT,
  NATIVE_SELECTOR_STUDY_ID,
  NATIVE_SELECTOR_CORRECTED_ROOT,
  NATIVE_SELECTOR_CORRECTED_STUDY_ID,
} from './dev-replay-study-policy.js'
import { readPinnedReplayFile, isWithinDirectory, parseReplayJson } from './dev-replay-files.js'
import { hashIdentity } from './hash-identity.js'
import { sha256PackedBytes, unpackBinaryLsb0V1 } from './packed-binary-lsb0.js'
import {
  NATIVE_SELECTOR_QUAL_ROOT,
  NATIVE_SELECTOR_QUAL_STUDY_ID,
  NATIVE_SELECTOR_QUAL_DEADLINE_ISO,
  nativeSelectorQualProtocolSchema,
  nativeSelectorQualExposedExclusionsSchema,
  validateNativeSelectorQualMetadata,
  nativeSelectorQualAnnotationProvenancePolicySchema,
} from './native-selector-qual-protocol.js'
import type { VerifiedNativeSelectorQualProtocol } from './native-selector-qual-protocol.js'
import { validateNativeSelectorSourceOracleProvenance } from './native-selector-qual-oracle-provenance.js'
import { verifyNativeSelectorQualHistoricalExclusions } from './native-selector-qual-historical-exclusions.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const offlineNativeSelectorParentProtocolSchema = nativeSelectorReplayProtocolSchema.extend({
  parentAudit: z.record(z.unknown()),
  sourceAudit: z.object({ path: z.string().min(1), sha256: digest }).strict(),
  runtimeProof: z.object({ path: z.string().min(1), sha256: digest }).strict(),
  runtimeEnvironment: z.object({ path: z.string().min(1), sha256: digest }).strict(),
})
const offlineNativeSelectorCorrectedParentProtocolSchema =
  nativeSelectorCorrectedReplayProtocolSchema.extend({
    parentAudit: z.record(z.unknown()),
    sourceAudit: z.object({ path: z.string().min(1), sha256: digest }).strict(),
    runtimeProof: z.object({ path: z.string().min(1), sha256: digest }).strict(),
    runtimeEnvironment: z.object({ path: z.string().min(1), sha256: digest }).strict(),
  })
const trustedArtifactRoot = resolve('/root/.codex/artifacts')
const parentSourceUnionPath = resolve(
  '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/execution-v2/source-union-audit-v1.json',
)
const parentSourceUnionSha256 =
  'b8875d28e6dfd87bb24c5eb2d1ca9664d466f22ed3854f2f1d284526b3d47146' as const
const perceptualHashModulePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../fresh-dev/imaging.py',
)
const perceptualHashValidationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../fresh-dev/validation.py',
)
const reviewSchema = z
  .object({
    schema: z.literal('h8a-dev-screen-review-v1'),
    screenReportSha256: digest,
    reviewProtocol: z.literal('no-apparent-collapse-main-review-v1'),
    reviewerId: z.literal('main-orchestrator'),
    judgement: z.enum(['advance', 'stop']),
    reason: z.string().min(1).max(1000),
    reviewSha256: digest,
  })
  .strict()
const parentAuditSchema = z
  .object({
    schema: z.enum([
      'h8a-native-selector-replay-dev40-closeout-v1',
      'h8a-native-selector-corrected-replay-dev40-closeout-v1',
    ]),
    studyId: z.enum([NATIVE_SELECTOR_STUDY_ID, NATIVE_SELECTOR_CORRECTED_STUDY_ID]),
    freezeId: z.string().min(1),
    protocolSha256: digest,
    candidateCloseoutSha256: digest,
    controlCloseoutSha256: digest,
    dev40Gate: z
      .object({
        executionValid: z.boolean(),
        pairedCoverageComplete: z.boolean(),
        qualityPass: z.boolean(),
      })
      .passthrough(),
    allStageReviewsAdvance: z.boolean(),
    terminalStop: z.unknown().nullable(),
    qualEligible: z.boolean(),
  })
  .passthrough()

export interface VerifiedNativeSelectorQualAdmission extends VerifiedNativeSelectorQualProtocol {
  sourceBytes: ReadonlyMap<string, Uint8Array>
  referenceMaskBytes: ReadonlyMap<string, Uint8Array>
  parentLedgerVersion: number
  parentPhysicalDispatchCount: number
  parentLogicalAttemptCount: number
  parentKnownCostUsd: number
  parentUnknownReserveUsd: number
  parentNextPhysicalId: number
  parentNextReservationId: number
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function assertCanonicalDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new RangeError('Qualification namespace is not a canonical directory')
}

async function pinnedRef(
  ref: { path: string; sha256: string; bytes: number },
  root: string,
): Promise<Buffer> {
  const path = resolve(ref.path)
  if (!isWithinDirectory(root, path))
    throw new RangeError('Pinned qualification reference escapes its namespace')
  const bytes = await readPinnedReplayFile(path, ref.sha256, 32 * 1024 * 1024)
  if (bytes.byteLength !== ref.bytes)
    throw new RangeError('Pinned qualification reference byte count mismatch')
  return bytes
}

async function pinnedArtifactRef(ref: {
  path: string
  sha256: string
  bytes: number
}): Promise<Buffer> {
  const path = resolve(ref.path)
  if (!isWithinDirectory(trustedArtifactRoot, path))
    throw new RangeError('Pinned external evidence is outside the trusted artifact root')
  const bytes = await readPinnedReplayFile(path, ref.sha256, 32 * 1024 * 1024)
  if (bytes.byteLength !== ref.bytes)
    throw new RangeError('Pinned external evidence byte count mismatch')
  return bytes
}

async function pinnedParentRef(
  ref: { path: string; sha256: string; bytes: number },
  root: string,
): Promise<Buffer> {
  const path = resolve(ref.path)
  return isWithinDirectory(root, path) ? pinnedRef(ref, root) : pinnedArtifactRef(ref)
}

function parseJson(bytes: Uint8Array): unknown {
  return parseReplayJson(bytes)
}

async function verifyPerceptualHashFromPinnedPython(
  jpegBytes: Uint8Array,
  pythonExecutable: string,
): Promise<{ perceptualHash: string; pillowRgbSha256: string }> {
  if (jpegBytes.byteLength > 5 * 1024 * 1024)
    throw new RangeError('QUAL source exceeds the pinned JPEG byte cap')
  const ownedJpegBytes = Buffer.from(jpegBytes)
  const script = [
    'import hashlib,sys',
    'sys.path.insert(0, __import__("os").path.dirname(sys.argv[1]))',
    'import imaging',
    'jpeg=sys.stdin.buffer.read()',
    'rgb,width,height=imaging.decode_jpeg_rgb_normalized(jpeg)',
    'value=imaging.perceptual_hash64_from_rgb(rgb,width,height)',
    'sys.stdout.write("%016x %s\\n" % (value,hashlib.sha256(rgb).hexdigest()))',
  ].join(';')
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(pythonExecutable, ['-c', script, perceptualHashModulePath], {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let outputBytes = 0
    let timedOut = false
    let overflow = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 15_000)
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > 160) {
        overflow = true
        child.kill('SIGKILL')
      } else chunks.push(Buffer.from(chunk))
    })
    child.stdin.on('error', () => undefined)
    child.once('error', () => {
      clearTimeout(timer)
      rejectResult(new RangeError('Pinned pHash worker could not start'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (timedOut || overflow || code !== 0) {
        rejectResult(new RangeError('Pinned pHash worker did not complete successfully'))
        return
      }
      const match = /^([a-f0-9]{16}) ([a-f0-9]{64})\n$/u.exec(
        Buffer.concat(chunks).toString('utf8'),
      )
      if (!match) {
        rejectResult(new RangeError('Pinned pHash worker returned an invalid closed result'))
        return
      }
      resolveResult({ perceptualHash: match[1]!, pillowRgbSha256: match[2]! })
    })
    child.stdin.end(ownedJpegBytes)
  })
}

async function readAllRefs<T extends { path: string; sha256: string; bytes: number }>(
  refs: readonly T[],
  root: string,
): Promise<Buffer[]> {
  const result: Buffer[] = []
  for (const ref of refs) result.push(await pinnedRef(ref, root))
  return result
}

function validateParentReports(
  reportBytes: readonly Buffer[],
  reviewBytes: readonly Buffer[],
  protocolSha256: string,
  freeze: PhaseFreeze,
  selection: ReturnType<typeof buildDevScreenSelection>,
  candidateCloseout: ImmutableCloseout,
  controlCloseout: ImmutableCloseout,
  evaluationRows: ReturnType<typeof joinCloseoutsWithPrivateAnnotations>,
): void {
  const expectedStages = [
    { stage: 'dev8', pairs: 8 },
    { stage: 'dev12', pairs: 12 },
    { stage: 'dev40', pairs: 40 },
  ] as const
  const producerById = new Map(freeze.producerCases.map((row) => [row.opaqueCaseId, row]))
  const evaluationById = new Map(evaluationRows.map((row) => [row.opaqueCaseId, row]))
  const candidateLogicals = new Map(
    candidateCloseout.logicalReceipts.map((row) => [row.logicalId, row]),
  )
  const controlLogicals = new Map(
    controlCloseout.logicalReceipts.map((row) => [row.logicalId, row]),
  )
  for (let index = 0; index < expectedStages.length; index++) {
    const expected = expectedStages[index]!
    const reportRaw = z.record(z.unknown()).parse(parseJson(reportBytes[index]!))
    const reviewRaw = z.record(z.unknown()).parse(parseJson(reviewBytes[index]!))
    const report = devScreenReportSchema.parse(reportRaw)
    const review = reviewSchema.parse(reviewRaw)
    const reportBody = Object.fromEntries(
      Object.entries(reportRaw).filter(([key]) => key !== 'reportSha256'),
    )
    const reviewBody = Object.fromEntries(
      Object.entries(reviewRaw).filter(([key]) => key !== 'reviewSha256'),
    )
    if (
      report.screen !== expected.stage ||
      report.completedPairs !== expected.pairs ||
      report.expectedPairs !== expected.pairs ||
      report.freezeCommitmentSha256 !== computePhaseFreezeCommitmentSha256(freeze) ||
      report.selectionCommitmentSha256 !== selection.selectionCommitmentSha256 ||
      report.seed !== selection.seed ||
      report.hardBlockers.length !== 0 ||
      report.outputs.length !== expected.pairs ||
      new Set(report.outputs.map((row) => row.opaqueCaseId)).size !== expected.pairs ||
      report.outputs.some(
        (row) => !selectionCaseSet(selection, expected.stage).has(row.opaqueCaseId),
      ) ||
      report.outputs.some((row) => {
        const producer = producerById.get(row.opaqueCaseId)
        const evaluated = evaluationById.get(row.opaqueCaseId)
        return (
          !producer ||
          !evaluated ||
          row.candidateIdentitySha256 !==
            hashIdentity(
              buildCaseArtifactIdentity(
                freeze,
                selection,
                producer,
                PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
              ),
            ) ||
          row.controlIdentitySha256 !==
            hashIdentity(
              buildCaseArtifactIdentity(freeze, selection, producer, PROFILE_CONTROL_ID),
            ) ||
          row.candidateCaseState !== evaluated.candidate.caseState ||
          row.controlCaseState !== evaluated.control.caseState ||
          row.candidatePositiveSuccess !== evaluated.candidatePositiveSuccess ||
          row.controlPositiveSuccess !== evaluated.controlPositiveSuccess ||
          row.candidateNegativeFalse !== evaluated.candidateNegativeFalse ||
          row.controlNegativeFalse !== evaluated.controlNegativeFalse
        )
      }) ||
      report.candidateNegativeFalseOutputs !==
        report.outputs.filter((row) => row.candidateNegativeFalse).length ||
      !reportAggregatesMatchCloseouts(
        report,
        candidateCloseout,
        controlCloseout,
        candidateLogicals,
        controlLogicals,
      ) ||
      report.reportSha256 !== hashIdentity(reportBody) ||
      review.judgement !== 'advance' ||
      review.screenReportSha256 !== report.reportSha256 ||
      review.reviewSha256 !== hashIdentity(reviewBody) ||
      protocolSha256.length !== 64
    )
      throw new RangeError(
        `Native-selector DEV ${expected.stage} review is not an advancing complete report`,
      )
  }
}

function reportAggregatesMatchCloseouts(
  report: z.infer<typeof devScreenReportSchema>,
  candidate: ImmutableCloseout,
  control: ImmutableCloseout,
  candidateLogicals: ReadonlyMap<number, ImmutableCloseout['logicalReceipts'][number]>,
  controlLogicals: ReadonlyMap<number, ImmutableCloseout['logicalReceipts'][number]>,
): boolean {
  const ids = new Set(report.outputs.map((row) => row.opaqueCaseId))
  const aggregate = (
    closeout: ImmutableCloseout,
    logicals: ReadonlyMap<number, ImmutableCloseout['logicalReceipts'][number]>,
  ) => {
    const caseIds = new Set(
      [...logicals.values()].filter((row) => ids.has(row.opaqueCaseId)).map((row) => row.logicalId),
    )
    const physical = closeout.physicalReceipts.filter((row) => caseIds.has(row.logicalId))
    return {
      knownCostUsd: physical.reduce(
        (sum, row) => sum + (row.chargeState === 'known' ? (row.costUsd ?? 0) : 0),
        0,
      ),
      unknownReservedUsd: physical.filter((row) => row.chargeState === 'unknown').length * 0.12,
      confirmedPhysicalCalls: physical.filter((row) => row.dispatchState === 'confirmed').length,
      logicalAttempts: [...logicals.values()].filter((row) => ids.has(row.opaqueCaseId)).length,
    }
  }
  const candidateSummary = aggregate(candidate, candidateLogicals)
  const controlSummary = aggregate(control, controlLogicals)
  const close = (left: number, right: number): boolean => Math.abs(left - right) <= 1e-9
  return (
    close(report.candidate.knownCostUsd, candidateSummary.knownCostUsd) &&
    close(report.control.knownCostUsd, controlSummary.knownCostUsd) &&
    close(report.candidate.unknownReservedUsd, candidateSummary.unknownReservedUsd) &&
    close(report.control.unknownReservedUsd, controlSummary.unknownReservedUsd) &&
    report.candidate.confirmedPhysicalCalls === candidateSummary.confirmedPhysicalCalls &&
    report.control.confirmedPhysicalCalls === controlSummary.confirmedPhysicalCalls &&
    report.candidate.logicalAttempts === candidateSummary.logicalAttempts &&
    report.control.logicalAttempts === controlSummary.logicalAttempts &&
    close(report.knownCostUsd, candidateSummary.knownCostUsd + controlSummary.knownCostUsd) &&
    close(
      report.unknownReservedUsd,
      candidateSummary.unknownReservedUsd + controlSummary.unknownReservedUsd,
    )
  )
}

function selectionCaseSet(
  selection: ReturnType<typeof buildDevScreenSelection>,
  stage: 'dev8' | 'dev12' | 'dev40',
): ReadonlySet<string> {
  return new Set(
    stage === 'dev8'
      ? selection.dev8CaseIds
      : stage === 'dev12'
        ? selection.dev12CaseIds
        : selection.cells.flatMap((cell) => cell.seededPermutationCaseIds),
  )
}

function validateParentLedgerCloseoutAccounting(input: {
  freeze: PhaseFreeze
  parentState: ReturnType<typeof validateNativeSelectorDev40LedgerForQual>
  candidate: ImmutableCloseout
  control: ImmutableCloseout
}): void {
  const caseCounts = new Map<string, number>()
  const globalPhysicalIds: number[] = []
  let knownCostUsd = 0
  let unknownReserveUsd = 0
  let confirmedCalls = 0
  for (const closeout of [input.candidate, input.control]) {
    const logicalById = new Map(closeout.logicalReceipts.map((row) => [row.logicalId, row]))
    for (const receipt of closeout.physicalReceipts) {
      if (receipt.dispatchState === 'prefetch_cancelled') {
        if (receipt.physicalId !== null || receipt.chargeState !== 'reserved_prefetch_cancelled')
          throw new RangeError('Parent DEV closeout has an invalid prefetch-cancelled receipt')
        continue
      }
      if (receipt.dispatchState !== 'confirmed' || !receipt.settled || receipt.physicalId === null)
        throw new RangeError('Parent DEV closeout has uncertain or unsettled physical work')
      const logical = logicalById.get(receipt.logicalId)
      if (!logical || logical.profileId !== closeout.profileId)
        throw new RangeError('Parent DEV physical receipt has no matching arm logical receipt')
      globalPhysicalIds.push(receipt.physicalId)
      const key = `${closeout.profileId}\0${logical.opaqueCaseId}`
      caseCounts.set(key, (caseCounts.get(key) ?? 0) + 1)
      confirmedCalls++
      if (receipt.chargeState === 'known') {
        if (receipt.costUsd === null || !Number.isFinite(receipt.costUsd) || receipt.costUsd < 0)
          throw new RangeError('Parent DEV known-charge receipt has no valid cost')
        knownCostUsd += receipt.costUsd
      } else if (receipt.chargeState === 'unknown') {
        if (receipt.costUsd !== null)
          throw new RangeError('Parent DEV unknown-charge receipt contains a known cost')
        unknownReserveUsd += 0.12
      } else throw new RangeError('Parent DEV dispatched receipt has an invalid charge state')
    }
  }
  const expectedLogicalAttempts = input.freeze.producerCases.flatMap((row) => [
    `${PROFILE_NATIVE_SELECTOR_CANDIDATE_ID}\0${row.opaqueCaseId}`,
    `${PROFILE_CONTROL_ID}\0${row.opaqueCaseId}`,
  ])
  const actualLogicalAttempts = input.parentState.logicalAttempts.map(
    (row) => `${row.profileId}\0${row.opaqueCaseId}`,
  )
  if (
    new Set(globalPhysicalIds).size !== globalPhysicalIds.length ||
    confirmedCalls !== input.parentState.dev40PhysicalCalls ||
    !sameNumbers(
      [...globalPhysicalIds].sort((left, right) => left - right),
      Array.from(
        { length: input.parentState.dev40PhysicalCalls },
        (_, index) =>
          input.parentState.physicalDispatchCount -
          input.parentState.dev40PhysicalCalls +
          index +
          1,
      ),
    ) ||
    !sameStrings([...actualLogicalAttempts].sort(), [...expectedLogicalAttempts].sort()) ||
    Math.abs(knownCostUsd - input.parentState.dev40KnownCostUsd) > 1e-9 ||
    Math.abs(unknownReserveUsd - input.parentState.dev40UnknownReserveUsd) > 1e-9 ||
    !sameCaseCounts(
      [...caseCounts].map(([key, physicalCalls]) => ({ key, physicalCalls })),
      input.parentState.caseCounts,
    )
  )
    throw new RangeError(
      'Parent DEV ledger dispatches or case attempts do not reconcile to both closeouts',
    )
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameCaseCounts(
  actual: readonly { key: string; physicalCalls: number }[],
  expected: readonly { profileId: string; opaqueCaseId: string; physicalCalls: number }[],
): boolean {
  const normalizedActual = actual
    .map((row) => ({ ...row }))
    .sort((left, right) => left.key.localeCompare(right.key))
  const normalizedExpected = expected
    .map((row) => ({
      key: `${row.profileId}\0${row.opaqueCaseId}`,
      physicalCalls: row.physicalCalls,
    }))
    .sort((left, right) => left.key.localeCompare(right.key))
  return (
    normalizedActual.length === normalizedExpected.length &&
    normalizedActual.every(
      (row, index) =>
        row.key === normalizedExpected[index]!.key &&
        row.physicalCalls === normalizedExpected[index]!.physicalCalls,
    )
  )
}

export async function readNativeSelectorQualParentGraph(
  graph: VerifiedNativeSelectorQualProtocol['protocol']['parentDev'],
  options: { offlineTestOnly?: true; namespaceRoot?: string } = {},
): Promise<{
  studyId: typeof NATIVE_SELECTOR_STUDY_ID | typeof NATIVE_SELECTOR_CORRECTED_STUDY_ID
  freeze: PhaseFreeze
  annotations: EvaluatorPrivateAnnotationBundle
  parentState: ReturnType<typeof validateNativeSelectorDev40LedgerForQual>
  sourceAuditRows: Array<{
    opaqueCaseId: string
    sourceBytesSha256: string
    sharpRuntimeDecodedRgbSha256: string
    pillowCanonicalRgbSha256: string
    sourcePath: string
  }>
  sourceUnionRows: Array<{
    opaqueCaseId: string
    encodedSha256: string
    sharpRuntimeDecodedRgbSha256: string
    decodedRgbSha256: string
    perceptualHash64: string
  }>
  producerSourceCommit: string
  producerClosureFiles: Array<{ path: string; sha256: string; bytes: number }>
  sourceAuditReferences: Array<{ path: string; sha256: string }>
  runtimeProofRef: { path: string; sha256: string }
  runtimeEnvironmentRef: { path: string; sha256: string }
}> {
  const offlineTestOnly = options.offlineTestOnly === true
  const selectedProductionStudyId = offlineTestOnly
    ? undefined
    : assertNativeSelectorQualParentRoot(graph.root)
  const root = resolve(graph.root)
  if (offlineTestOnly) {
    const namespaceRoot = resolve(options.namespaceRoot ?? '')
    const canonicalTempRoot = resolve(await realpath(tmpdir()))
    const relativeTemp = relative(canonicalTempRoot, namespaceRoot)
    if (
      !relativeTemp ||
      relativeTemp === '..' ||
      relativeTemp.startsWith(`..${sep}`) ||
      namespaceRoot === canonicalTempRoot ||
      (await realpath(namespaceRoot)) !== namespaceRoot ||
      !isWithinDirectory(namespaceRoot, root)
    )
      throw new RangeError('Offline parent graph requires a disposable nested namespace')
  }
  await assertCanonicalDirectory(root)
  const refs = [
    graph.protocol,
    graph.freeze,
    graph.annotations,
    graph.sourceAudit,
    graph.producerClosure,
    graph.candidateCloseout,
    graph.controlCloseout,
    graph.dev40Closeout,
    graph.ledger,
    graph.registration,
    ...graph.stageReports,
    ...graph.stageReviews,
  ]
  const bytes: Buffer[] = []
  for (const ref of refs)
    bytes.push(offlineTestOnly ? await pinnedRef(ref, root) : await pinnedParentRef(ref, root))
  const [
    protocolBytes,
    freezeBytes,
    annotationsBytes,
    sourceAuditBytes,
    closureBytes,
    candidateBytes,
    controlBytes,
    closeoutBytes,
    ledgerBytes,
    registrationBytes,
    ...reportAndReviewBytes
  ] = bytes
  if (
    !protocolBytes ||
    !freezeBytes ||
    !annotationsBytes ||
    !sourceAuditBytes ||
    !closureBytes ||
    !candidateBytes ||
    !controlBytes ||
    !closeoutBytes ||
    !ledgerBytes ||
    !registrationBytes
  )
    throw new RangeError('Native-selector parent graph is incomplete')
  const protocolValue: unknown = parseJson(protocolBytes)
  const parentStudyId =
    typeof protocolValue === 'object' && protocolValue !== null
      ? Reflect.get(protocolValue, 'studyId')
      : undefined
  if (
    parentStudyId !== NATIVE_SELECTOR_STUDY_ID &&
    parentStudyId !== NATIVE_SELECTOR_CORRECTED_STUDY_ID
  )
    throw new RangeError('QUAL parent protocol is outside the closed V5 study set')
  if (!offlineTestOnly && parentStudyId !== selectedProductionStudyId)
    throw new RangeError('QUAL parent root and registered study identity disagree')
  const nativeParentProtocol =
    parentStudyId === NATIVE_SELECTOR_CORRECTED_STUDY_ID
      ? (offlineTestOnly
          ? offlineNativeSelectorCorrectedParentProtocolSchema
          : nativeSelectorCorrectedReplayProtocolSchema
        ).parse(protocolValue)
      : (offlineTestOnly
          ? offlineNativeSelectorParentProtocolSchema
          : nativeSelectorReplayProtocolSchema
        ).parse(protocolValue)
  if (
    nativeParentProtocol.freeze.path !== graph.freeze.path ||
    nativeParentProtocol.freeze.sha256 !== graph.freeze.sha256 ||
    nativeParentProtocol.annotations.path !== graph.annotations.path ||
    nativeParentProtocol.annotations.sha256 !== graph.annotations.sha256 ||
    nativeParentProtocol.sourceAudit.path !== graph.sourceAudit.path ||
    nativeParentProtocol.sourceAudit.sha256 !== graph.sourceAudit.sha256 ||
    nativeParentProtocol.producerClosure.path !== graph.producerClosure.path ||
    nativeParentProtocol.producerClosure.sha256 !== graph.producerClosure.sha256
  )
    throw new RangeError('QUAL parent graph pins differ from the selected DEV protocol')
  const freeze = phaseFreezeSchema.parse(parseJson(freezeBytes))
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(parseJson(annotationsBytes))
  const selectionPath = resolve(nativeParentProtocol.selection.path)
  if (offlineTestOnly && !isWithinDirectory(root, selectionPath))
    throw new RangeError('Offline DEV selection pin escapes its disposable parent graph')
  const selectionBytes = await readPinnedReplayFile(
    selectionPath,
    nativeParentProtocol.selection.sha256,
    4 * 1024 * 1024,
  )
  const selection = buildDevScreenSelection(freeze, annotations)
  if (JSON.stringify(parseJson(selectionBytes)) !== JSON.stringify(selection))
    throw new RangeError(
      'Parent DEV selection bytes differ from the deterministic frozen selection',
    )
  const candidate = immutableCloseoutSchema.parse(parseJson(candidateBytes))
  const control = immutableCloseoutSchema.parse(parseJson(controlBytes))
  const closeout = parentAuditSchema.parse(parseJson(closeoutBytes))
  const ledger = parseJson(ledgerBytes)
  const registration = parseJson(registrationBytes)
  if (
    freeze.phaseId !== PHASE_NATIVE_SELECTOR_DEV40_ID ||
    freeze.producerCases.length !== 40 ||
    candidate.outputRows.length !== 40 ||
    control.outputRows.length !== 40 ||
    closeout.studyId !== parentStudyId ||
    closeout.schema !==
      (parentStudyId === NATIVE_SELECTOR_CORRECTED_STUDY_ID
        ? 'h8a-native-selector-corrected-replay-dev40-closeout-v1'
        : 'h8a-native-selector-replay-dev40-closeout-v1') ||
    closeout.freezeId !== freeze.freezeId ||
    closeout.protocolSha256 !== graph.protocol.sha256 ||
    closeout.candidateCloseoutSha256 !== candidate.closeoutSha256 ||
    closeout.controlCloseoutSha256 !== control.closeoutSha256 ||
    closeout.terminalStop !== null ||
    !closeout.allStageReviewsAdvance ||
    !closeout.qualEligible
  )
    throw new RangeError('Native-selector DEV40 parent is not completely eligible for QUAL')
  validateImmutableCloseouts({ freeze, candidateCloseout: candidate, controlCloseout: control })
  const ledgerExpected = {
    protocolSha256: graph.protocol.sha256,
    caseIds: freeze.producerCases.map((row) => row.opaqueCaseId),
  }
  const linked =
    parentStudyId === NATIVE_SELECTOR_CORRECTED_STUDY_ID
      ? validateNativeSelectorCorrectedDev40LedgerForQual(ledger, registration, ledgerExpected)
      : validateNativeSelectorDev40LedgerForQual(ledger, registration, ledgerExpected)
  if (
    linked.maxPhysicalCalls !== 2_000 ||
    linked.physicalDispatchCount + 1_200 > linked.maxPhysicalCalls
  )
    throw new RangeError('Native-selector parent ledger cannot safely admit QUAL120')
  validateParentLedgerCloseoutAccounting({
    freeze,
    parentState: linked,
    candidate,
    control,
  })
  const sourceAudit = z
    .object({
      schema: z.literal('h8a-replay-original-input-byte-audit-v1'),
      sourceCases: z.literal(40),
      references: z.array(z.object({ path: z.string().min(1), sha256: digest }).strict()).min(1),
      rows: z
        .array(
          z
            .object({
              opaqueCaseId: z.string().min(1),
              sourceBytesSha256: digest,
              encodedBytes: z.number().int().positive(),
              sourceCanvasWidth: z.number().int().positive(),
              sourceCanvasHeight: z.number().int().positive(),
              sharpRuntimeDecodedRgbSha256: digest,
              pillowCanonicalRgbSha256: digest,
              sourcePath: z.string().min(1),
            })
            .passthrough(),
        )
        .length(40),
    })
    .passthrough()
    .parse(parseJson(sourceAuditBytes))
  if (new Set(sourceAudit.rows.map((row) => row.opaqueCaseId)).size !== 40)
    throw new RangeError('Parent DEV source audit has duplicate cases')
  const freezeById = new Map(freeze.producerCases.map((row) => [row.opaqueCaseId, row]))
  const sourceRefsById = new Map(nativeParentProtocol.sourceBytes.map((row) => [row.caseId, row]))
  if (
    sourceRefsById.size !== 40 ||
    sourceAudit.rows.some((row) => {
      const producer = freezeById.get(row.opaqueCaseId)
      const sourceRef = sourceRefsById.get(row.opaqueCaseId)
      return (
        !producer ||
        !sourceRef ||
        producer.sourceBytesSha256 !== row.sourceBytesSha256 ||
        producer.sourceCanvasWidth !== row.sourceCanvasWidth ||
        producer.sourceCanvasHeight !== row.sourceCanvasHeight ||
        sourceRef.sha256 !== row.sourceBytesSha256 ||
        sourceRef.bytes !== row.encodedBytes ||
        resolve(sourceRef.path) !== resolve(row.sourcePath)
      )
    }) ||
    [...freezeById.keys()].some(
      (caseId) => !sourceAudit.rows.some((row) => row.opaqueCaseId === caseId),
    )
  )
    throw new RangeError('Parent DEV raw source audit does not match its frozen 40-case cohort')
  for (const sourceRef of nativeParentProtocol.sourceBytes) {
    const refPath = resolve(sourceRef.path)
    if (offlineTestOnly && !isWithinDirectory(root, refPath))
      throw new RangeError('Offline DEV source escapes its disposable parent graph')
    const sourceBytes = offlineTestOnly
      ? await pinnedRef(sourceRef, root)
      : await pinnedParentRef(sourceRef, root)
    if (sourceBytes.byteLength !== sourceRef.bytes)
      throw new RangeError('Parent DEV source byte count differs from its pinned file')
  }
  const sourceUnionRef = offlineTestOnly
    ? sourceAudit.references.find((ref) => isWithinDirectory(root, resolve(ref.path)))
    : sourceAudit.references.find((ref) => resolve(ref.path) === parentSourceUnionPath)
  if (!sourceUnionRef || (!offlineTestOnly && sourceUnionRef.sha256 !== parentSourceUnionSha256))
    throw new RangeError('Parent DEV pHash source-union audit is not the pinned canonical input')
  const sourceUnionBytes = offlineTestOnly
    ? await readPinnedReplayFile(sourceUnionRef.path, sourceUnionRef.sha256, 16 * 1024 * 1024)
    : await readPinnedReplayFile(parentSourceUnionPath, parentSourceUnionSha256, 16 * 1024 * 1024)
  const sourceUnion = z
    .object({
      schema: z.literal('h8a-ui-state-dev40-source-union-audit-v1'),
      algorithm: z.literal('benchmarks/v03/fresh-dev/imaging.py:perceptual_hash64_from_rgb'),
      sha256Implementation: z.literal(
        'ea06f305375ced9341d07ef5afcdc615f0b93afc340939a2bc2c654bd97495f1',
      ),
      decodedRgbContract: z.literal(
        'pillow-rgb-canonical-identity-and-sharp-srgb-runtime-decoder-v1',
      ),
      nearestHammingContract: z.literal(
        'minimum diagnostic distance to all 348 historical and other 39 study source pHashes; reject at <=4 only for photo/map',
      ),
      rows: z
        .array(
          z
            .object({
              opaqueCaseId: z.string().min(1),
              encodedSha256: digest,
              sharpRuntimeDecodedRgbSha256: digest,
              decodedRgbSha256: digest,
              perceptualHash64: z.string().regex(/^[a-f0-9]{16}$/u),
            })
            .passthrough(),
        )
        .length(40),
    })
    .passthrough()
    .parse(parseJson(sourceUnionBytes))
  const auditById = new Map(sourceAudit.rows.map((row) => [row.opaqueCaseId, row]))
  if (
    new Set(sourceUnion.rows.map((row) => row.opaqueCaseId)).size !== 40 ||
    sourceUnion.rows.some((row) => !freezeById.has(row.opaqueCaseId)) ||
    [...freezeById.keys()].some(
      (caseId) => !sourceUnion.rows.some((row) => row.opaqueCaseId === caseId),
    ) ||
    sourceUnion.rows.some((row) => {
      const audit = auditById.get(row.opaqueCaseId)
      return (
        !audit ||
        audit.sourceBytesSha256 !== row.encodedSha256 ||
        audit.sharpRuntimeDecodedRgbSha256 !== row.sharpRuntimeDecodedRgbSha256 ||
        audit.pillowCanonicalRgbSha256 !== row.decodedRgbSha256
      )
    })
  )
    throw new RangeError(
      'Parent DEV pHash source-union fingerprints differ from the pinned raw/RGB audit',
    )
  const closure = z
    .object({
      schema: z.literal('h8a-producer-closure-files-v1'),
      sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
      files: z.array(
        z
          .object({
            path: z.string().min(1),
            sha256: digest,
            bytes: z.number().int().nonnegative(),
          })
          .strict(),
      ),
    })
    .strict()
    .parse(parseJson(closureBytes))
  if (freeze.producerClosureSha256 !== graph.producerClosure.sha256)
    throw new RangeError(
      'Native-selector parent producer closure is not bound to its frozen source',
    )
  const parentMaskBytes = new Map<string, Uint8Array>()
  for (const ref of nativeParentProtocol.referenceMasks) {
    const refPath = resolve(ref.path)
    if (offlineTestOnly && !isWithinDirectory(root, refPath))
      throw new RangeError('Offline parent DEV mask escapes its disposable graph')
    const bytes = await readPinnedReplayFile(refPath, ref.sha256, 8 * 1024 * 1024)
    if (sha256PackedBytes(bytes) !== ref.packedBinarySha256)
      throw new RangeError('Native-selector DEV mask does not match its pinned packed hash')
    parentMaskBytes.set(ref.packedBinarySha256, Uint8Array.from(bytes))
  }
  for (const closeoutValue of [candidate, control]) {
    for (const row of closeoutValue.outputRows) {
      if (!row.maskPackedSha256 || parentMaskBytes.has(row.maskPackedSha256)) continue
      const path = join(
        root,
        'execution',
        'case-blobs',
        row.maskPackedSha256.slice(0, 2),
        row.maskPackedSha256,
      )
      if (offlineTestOnly && !isWithinDirectory(root, path))
        throw new RangeError('Offline parent DEV prediction mask escapes its graph')
      const bytes = await readPinnedReplayFile(path, row.maskPackedSha256, 32 * 1024 * 1024)
      if (sha256PackedBytes(bytes) !== row.maskPackedSha256)
        throw new RangeError('Native-selector DEV prediction mask bytes do not match the closeout')
      parentMaskBytes.set(row.maskPackedSha256, Uint8Array.from(bytes))
    }
  }
  const evaluationRows = joinCloseoutsWithPrivateAnnotations({
    freeze,
    candidateCloseout: candidate,
    controlCloseout: control,
    annotations,
    packedMasksBySha256: parentMaskBytes,
  })
  const evaluation = evaluateDev40Gate(evaluationRows, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID)
  if (
    !evaluation.qualityPass ||
    !evaluation.executionValid ||
    !evaluation.pairedCoverageComplete ||
    hashIdentity(closeout.dev40Gate) !== hashIdentity(evaluation)
  )
    throw new RangeError('Native-selector DEV40 source gate is not QUAL eligible')
  validateParentReports(
    reportAndReviewBytes.slice(0, 3),
    reportAndReviewBytes.slice(3),
    graph.protocol.sha256,
    freeze,
    selection,
    candidate,
    control,
    evaluationRows,
  )
  return {
    studyId: parentStudyId,
    freeze,
    annotations,
    parentState: linked,
    sourceAuditRows: sourceAudit.rows,
    sourceUnionRows: sourceUnion.rows,
    producerSourceCommit: closure.sourceCommit,
    producerClosureFiles: closure.files,
    sourceAuditReferences: sourceAudit.references,
    runtimeProofRef: nativeParentProtocol.runtimeProof,
    runtimeEnvironmentRef: nativeParentProtocol.runtimeEnvironment,
  }
}

/** Keep the QUAL lineage edge closed to the selected V5 DEV40 namespace. */
export function assertNativeSelectorQualParentRoot(
  parentRoot: string,
): typeof NATIVE_SELECTOR_STUDY_ID | typeof NATIVE_SELECTOR_CORRECTED_STUDY_ID {
  if (resolve(parentRoot) === resolve(NATIVE_SELECTOR_ROOT)) return NATIVE_SELECTOR_STUDY_ID
  if (resolve(parentRoot) === resolve(NATIVE_SELECTOR_CORRECTED_ROOT))
    return NATIVE_SELECTOR_CORRECTED_STUDY_ID
  throw new RangeError('QUAL parent must use a closed native-selector DEV40 namespace')
}

/** QUAL inherits execution limits and task policy from the selected DEV freeze. */
export function assertNativeSelectorQualExecutionPolicyInheritance(
  devFreezeValue: unknown,
  qualFreezeValue: unknown,
): void {
  const dev = phaseFreezeSchema.parse(devFreezeValue)
  const qual = phaseFreezeSchema.parse(qualFreezeValue)
  const hasBalancedSchedule = (freeze: typeof dev): boolean =>
    (['photo', 'ui', 'map'] as const).every((stratum) => {
      const scheduled = freeze.pairedSchedule.filter((row) => row.stratum === stratum)
      const candidateFirst = scheduled.filter((row) => row.candidateArmFirst).length
      return Math.abs(candidateFirst - (scheduled.length - candidateFirst)) <= 1
    })
  if (
    dev.deadlineIso !== qual.deadlineIso ||
    JSON.stringify(dev.nativeLimits) !== JSON.stringify(qual.nativeLimits) ||
    JSON.stringify(dev.timeoutRetryPolicy) !== JSON.stringify(qual.timeoutRetryPolicy) ||
    JSON.stringify(dev.executionPolicy ?? null) !== JSON.stringify(qual.executionPolicy ?? null) ||
    dev.timeoutRetryPolicy.absoluteCaseTimeoutSeconds !== 240 ||
    dev.timeoutRetryPolicy.sharedAbsoluteTimeoutMs !== 240_000 ||
    !hasBalancedSchedule(dev) ||
    !hasBalancedSchedule(qual)
  )
    throw new RangeError('QUAL execution policy differs from the selected DEV freeze')
}

/** Exercise the production parent-graph validator only within a disposable offline fixture root. */
export async function verifyNativeSelectorQualParentGraphForOfflineTest(input: {
  offlineTestOnly: true
  namespaceRoot: string
  graph: VerifiedNativeSelectorQualProtocol['protocol']['parentDev']
}): Promise<Awaited<ReturnType<typeof readNativeSelectorQualParentGraph>>> {
  return readNativeSelectorQualParentGraph(input.graph, {
    offlineTestOnly: true,
    namespaceRoot: input.namespaceRoot,
  })
}

export async function verifyNativeSelectorQualParentExclusions(input: {
  parent: Pick<
    Awaited<ReturnType<typeof readNativeSelectorQualParentGraph>>,
    'studyId' | 'sourceAuditReferences' | 'annotations'
  >
  exposedExclusionsValue: unknown
  offlineNamespaceRoot?: string
}): Promise<Awaited<ReturnType<typeof verifyNativeSelectorQualHistoricalExclusions>> | undefined> {
  const exposed = nativeSelectorQualExposedExclusionsSchema.parse(input.exposedExclusionsValue)
  if (input.parent.studyId === NATIVE_SELECTOR_CORRECTED_STUDY_ID) {
    if (!exposed.historical)
      throw new RangeError('Corrected-parent QUAL requires both pinned historical exclusion files')
    return verifyNativeSelectorQualHistoricalExclusions({
      sourceAuditReferences: input.parent.sourceAuditReferences,
      exposed: exposed.historical,
      expectedDevSourceGroups: input.parent.annotations.cases.map((row) => row.sourceGroup),
      ...(input.offlineNamespaceRoot ? { offlineNamespaceRoot: input.offlineNamespaceRoot } : {}),
    })
  }
  if (exposed.historical)
    throw new RangeError('Historical exclusion mode is reserved for the corrected DEV parent')
  return undefined
}

/** Bind the exclusion audit's DEV group representation to the selected parent cohort. */
export function assertNativeSelectorQualDevGroupCoverage(input: {
  parentGroups: readonly string[]
  auditGroups: readonly string[]
  historicalDevGroups?: readonly string[]
}): void {
  const normalize = (value: string): string => value.replace(/\/+$/u, '')
  if (input.historicalDevGroups) {
    const parentSet = [...new Set(input.parentGroups.map(normalize))].sort()
    const normalizedAudit = input.auditGroups.map(normalize)
    const auditSet = [...new Set(normalizedAudit)].sort()
    const historySet = [...new Set(input.historicalDevGroups.map(normalize))].sort()
    if (
      auditSet.length !== input.auditGroups.length ||
      parentSet.length !== auditSet.length ||
      parentSet.length !== historySet.length ||
      parentSet.some((group, index) => group !== auditSet[index] || group !== historySet[index])
    )
      throw new RangeError('QUAL DEV source-group audit differs from the selected parent history')
    return
  }
  const parent = [...input.parentGroups].sort()
  const audit = [...input.auditGroups].sort()
  if (parent.length !== audit.length || parent.some((group, index) => group !== audit[index]))
    throw new RangeError('QUAL DEV source-group audit differs from the selected parent')
}

export async function verifyNativeSelectorQualAdmission(input: {
  protocolPath: string
  protocolSha256: string
  action: 'register' | 'run' | 'closeout'
  now?: () => number
}): Promise<VerifiedNativeSelectorQualAdmission> {
  if (!isAbsolute(input.protocolPath) || !digest.safeParse(input.protocolSha256).success)
    throw new RangeError('QUAL protocol pin is invalid')
  const root = resolve(NATIVE_SELECTOR_QUAL_ROOT)
  const expectedPath = join(root, 'protocol-inputs', 'protocol.json')
  if (resolve(input.protocolPath) !== expectedPath)
    throw new RangeError('QUAL protocol must use its closed namespace path')
  await assertCanonicalDirectory(root)
  const protocolBytes = await readPinnedReplayFile(
    expectedPath,
    input.protocolSha256,
    8 * 1024 * 1024,
  )
  const protocolValue = parseJson(protocolBytes)
  const protocol = nativeSelectorQualProtocolSchema.parse(protocolValue)
  if (protocol.studyId !== NATIVE_SELECTOR_QUAL_STUDY_ID)
    throw new RangeError('QUAL protocol study mismatch')
  const readClock = input.now ?? Date.now
  const admissionStart = readClock()
  if (
    input.action !== 'closeout' &&
    admissionStart >= Date.parse(NATIVE_SELECTOR_QUAL_DEADLINE_ISO)
  )
    throw new RangeError('QUAL admission deadline has passed')
  const parent = await readNativeSelectorQualParentGraph(protocol.parentDev)
  const [
    freezeBytes,
    annotationsBytes,
    sourceManifestBytes,
    maskManifestBytes,
    exclusionBytes,
    exposedExclusionsBytes,
    acquisitionBytes,
    rightsBytes,
    annotationPolicyBytes,
  ] = await readAllRefs(
    [
      protocol.freeze,
      protocol.annotations,
      protocol.sourceManifest,
      protocol.referenceMaskManifest,
      protocol.exclusionAudit,
      protocol.exposedExclusions,
      protocol.acquisitionPolicy,
      protocol.rightsPolicy,
      protocol.annotationProvenancePolicy,
    ],
    root,
  )
  const closureBytes = await pinnedParentRef(protocol.producerClosure, protocol.parentDev.root)
  const runtimeProofBytes = await pinnedArtifactRef(protocol.runtimeProof)
  const runtimeEnvironmentBytes = await pinnedArtifactRef(protocol.runtimeEnvironment)
  const assetsBytes = await pinnedArtifactRef(protocol.nativeAssetsProof)
  if (resolve(protocol.priceProof.path) !== resolve(NATIVE_SELECTOR_PRICE_PROOF.path))
    throw new RangeError('QUAL price proof path differs from the pinned canonical price proof')
  const priceBytes = await pinnedArtifactRef(protocol.priceProof)
  const historicalExclusionSets = await verifyNativeSelectorQualParentExclusions({
    parent,
    exposedExclusionsValue: parseJson(exposedExclusionsBytes!),
  })
  const metadata = validateNativeSelectorQualMetadata({
    protocolSha256: input.protocolSha256,
    protocolBytes,
    freezeValue: parseJson(freezeBytes!),
    annotationsValue: parseJson(annotationsBytes!),
    sourceManifestValue: parseJson(sourceManifestBytes!),
    maskManifestValue: parseJson(maskManifestBytes!),
    exclusionAuditValue: parseJson(exclusionBytes!),
    exposedExclusionsValue: parseJson(exposedExclusionsBytes!),
    acquisitionPolicyValue: parseJson(acquisitionBytes!),
    rightsPolicyValue: parseJson(rightsBytes!),
    annotationProvenancePolicyValue: parseJson(annotationPolicyBytes!),
    ...(historicalExclusionSets ? { historicalExclusionSets } : {}),
  })
  const annotationProvenancePolicy = nativeSelectorQualAnnotationProvenancePolicySchema.parse(
    parseJson(annotationPolicyBytes!),
  )
  await validateNativeSelectorSourceOracleProvenance({
    freeze: metadata.freeze,
    annotations: metadata.annotations,
    sourceRows: metadata.sourceManifest.sources.map((source) => ({
      caseId: source.caseId,
      sha256: source.sha256,
      sourceGroup: source.sourceGroup,
    })),
    provenanceRows: annotationProvenancePolicy.annotations,
    artifactRoot: trustedArtifactRoot,
    readPinned: readPinnedReplayFile,
  })
  assertNativeSelectorQualExecutionPolicyInheritance(parent.freeze, metadata.freeze)
  if (
    metadata.protocol.producerClosure.sha256 !== metadata.protocol.policy.producerClosureSha256 ||
    metadata.protocol.priceProof.sha256 !== metadata.protocol.policy.priceProofSha256 ||
    sha256(priceBytes!) !== metadata.protocol.priceProof.sha256
  )
    throw new RangeError('QUAL price proof or producer closure raw-byte pin mismatch')
  if (
    metadata.protocol.runtimeProof.path !== parent.runtimeProofRef.path ||
    metadata.protocol.runtimeProof.sha256 !== parent.runtimeProofRef.sha256 ||
    metadata.protocol.runtimeEnvironment.path !== parent.runtimeEnvironmentRef.path ||
    metadata.protocol.runtimeEnvironment.sha256 !== parent.runtimeEnvironmentRef.sha256
  )
    throw new RangeError('QUAL runtime proof differs from the selected DEV parent')
  const runtimeProof = z
    .object({
      schema: z.literal('h8a-dev-ready-runtime-files-v1'),
      pythonExecutable: z.string().min(1),
      pythonSha256: digest,
      candidateAndControlAssets: z
        .array(
          z
            .object({ path: z.string().min(1), bytes: z.number().int().positive(), sha256: digest })
            .strict(),
        )
        .min(1),
    })
    .passthrough()
    .parse(parseJson(runtimeProofBytes!))
  const runtimeEnvironment = z
    .object({
      python: z
        .object({
          version: z.literal('3.12.3'),
          executableSha256: digest,
          requiredNativeVersions: z.object({ Pillow: z.literal('12.3.0') }).passthrough(),
        })
        .passthrough(),
    })
    .passthrough()
    .parse(parseJson(runtimeEnvironmentBytes!))
  if (runtimeProof.pythonSha256 !== runtimeEnvironment.python.executableSha256)
    throw new RangeError('QUAL pinned Python runtime does not match its environment proof')
  await readPinnedReplayFile(
    runtimeProof.pythonExecutable,
    runtimeProof.pythonSha256,
    64 * 1024 * 1024,
  )
  const nativeAssetsProof = z
    .object({
      schema: z.literal('h8a-native-selector-runtime-assets-proof-v1'),
      runtimeProofSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      assets: z
        .array(
          z
            .object({ path: z.string().min(1), bytes: z.number().int().positive(), sha256: digest })
            .strict(),
        )
        .min(1),
    })
    .strict()
    .parse(parseJson(assetsBytes!))
  const expectedAssets = [...runtimeProof.candidateAndControlAssets].sort((a, b) =>
    a.path.localeCompare(b.path),
  )
  const provedAssets = [...nativeAssetsProof.assets].sort((a, b) => a.path.localeCompare(b.path))
  if (
    nativeAssetsProof.runtimeProofSha256 !== metadata.protocol.runtimeProof.sha256 ||
    JSON.stringify(provedAssets) !== JSON.stringify(expectedAssets)
  )
    throw new RangeError('QUAL native asset proof differs from the selected DEV runtime proof')
  const pHashFiles = [
    { path: 'benchmarks/v03/fresh-dev/imaging.py', absolute: perceptualHashModulePath },
    { path: 'benchmarks/v03/fresh-dev/validation.py', absolute: perceptualHashValidationPath },
  ] as const
  for (const expectedFile of pHashFiles) {
    const closureFile = parent.producerClosureFiles.find((file) => file.path === expectedFile.path)
    if (!closureFile)
      throw new RangeError('Selected DEV producer closure omits the pinned pHash implementation')
    const bytes = await readPinnedReplayFile(
      expectedFile.absolute,
      closureFile.sha256,
      2 * 1024 * 1024,
    )
    if (bytes.byteLength !== closureFile.bytes)
      throw new RangeError('Pinned pHash source closure byte count mismatch')
  }
  const closure = z
    .object({
      schema: z.literal('h8a-producer-closure-files-v1'),
      sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
      files: z
        .array(
          z
            .object({
              path: z.string().min(1),
              sha256: digest,
              bytes: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict()
    .parse(parseJson(closureBytes!))
  if (closure.sourceCommit !== metadata.protocol.policy.producerSourceCommit)
    throw new RangeError('QUAL producer closure source commit differs from selected DEV')
  const parentResult = parent
  if (
    metadata.protocol.policy.producerClosureSha256 !== parentResult.freeze.producerClosureSha256 ||
    metadata.protocol.producerClosure.sha256 !== parentResult.freeze.producerClosureSha256 ||
    metadata.protocol.policy.recipeIdentitySha256 !==
      parentResult.freeze.profileBindings[0]?.recipeIdentitySha256 ||
    metadata.protocol.policy.controlRecipeIdentitySha256 !==
      parentResult.freeze.profileBindings[1]?.recipeIdentitySha256 ||
    metadata.protocol.policy.producerSourceCommit !== parentResult.producerSourceCommit ||
    metadata.protocol.parentDev.sourceAudit.sha256 !== protocol.parentDev.sourceAudit.sha256 ||
    metadata.exclusionAudit.parentDevSourceAuditSha256 !==
      metadata.protocol.parentDev.sourceAudit.sha256
  )
    throw new RangeError('QUAL recipe/source closure changed after DEV selection')
  const sourceGroups = metadata.annotations.cases.map((row) => row.sourceGroup)
  const parentGroups = parentResult.annotations.cases.map((row) => row.sourceGroup)
  const sorted = (values: readonly string[]) => [...values].sort().join('\0')
  const devEncoded = parentResult.sourceAuditRows.map((row) => row.sourceBytesSha256)
  const devRgb = parentResult.sourceAuditRows.flatMap((row) => [
    row.sharpRuntimeDecodedRgbSha256,
    row.pillowCanonicalRgbSha256,
  ])
  const devPerceptual = parentResult.sourceUnionRows.map((row) => row.perceptualHash64)
  if (
    sorted(metadata.exclusionAudit.devCaseIds) !==
      sorted(parentResult.freeze.producerCases.map((row) => row.opaqueCaseId)) ||
    sorted(metadata.exclusionAudit.devEncodedHashes) !== sorted(devEncoded) ||
    sorted(metadata.exclusionAudit.devRgbHashes) !== sorted(devRgb) ||
    sorted(metadata.exclusionAudit.devPerceptualHashes) !== sorted(devPerceptual) ||
    sorted(metadata.exclusionAudit.qualSourceGroups) !== sorted(sourceGroups) ||
    metadata.sourceManifest.sources.some((source) => {
      const annotation = metadata.annotations.cases.find(
        (row) => row.opaqueCaseId === source.caseId,
      )
      return (
        !annotation ||
        annotation.sourceGroup !== source.sourceGroup ||
        parentResult.sourceAuditRows.some(
          (row) =>
            row.sourceBytesSha256 === source.sha256 ||
            row.sharpRuntimeDecodedRgbSha256 === source.rgbPixelsSha256 ||
            row.pillowCanonicalRgbSha256 === source.rgbPixelsSha256,
        ) ||
        (annotation?.stratum !== 'ui' &&
          parentResult.sourceUnionRows.some((row) => {
            const left = BigInt(`0x${row.perceptualHash64}`)
            const right = BigInt(`0x${source.perceptualHash}`)
            let bits = left ^ right
            let distance = 0
            while (bits !== 0n) {
              distance += Number(bits & 1n)
              bits >>= 1n
            }
            return distance <= 4
          }))
      )
    })
  )
    throw new RangeError(
      'QUAL encoded, RGB, perceptual-hash, or source-group exclusions disagree with pinned DEV evidence',
    )
  assertNativeSelectorQualDevGroupCoverage({
    parentGroups,
    auditGroups: metadata.exclusionAudit.devSourceGroups,
    ...(historicalExclusionSets
      ? { historicalDevGroups: historicalExclusionSets.devSourceGroups }
      : {}),
  })
  const sourceBytes = new Map<string, Uint8Array>()
  for (const source of metadata.sourceManifest.sources) {
    const ref = { path: source.path, sha256: source.sha256, bytes: source.bytes }
    const bytes = await pinnedRef(ref, root)
    const decoded = await sharp(bytes)
      .rotate()
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true })
    const pHash = await verifyPerceptualHashFromPinnedPython(bytes, runtimeProof.pythonExecutable)
    const producer = metadata.freeze.producerCases.find((row) => row.opaqueCaseId === source.caseId)
    if (
      !producer ||
      sha256(bytes) !== producer.sourceBytesSha256 ||
      decoded.info.width !== producer.sourceCanvasWidth ||
      decoded.info.height !== producer.sourceCanvasHeight ||
      sha256(decoded.data) !== source.rgbPixelsSha256 ||
      pHash.pillowRgbSha256 !== source.pillowCanonicalRgbSha256 ||
      pHash.perceptualHash !== source.perceptualHash
    )
      throw new RangeError('QUAL source bytes or decoded RGB differ from their frozen commitments')
    sourceBytes.set(source.caseId, Uint8Array.from(bytes))
  }
  const referenceMaskBytes = new Map<string, Uint8Array>()
  for (const mask of metadata.maskManifest.masks) {
    const bytes = await pinnedRef(mask, root)
    if (sha256PackedBytes(bytes) !== mask.packedBinarySha256)
      throw new RangeError('QUAL mask bytes do not match the packed-mask commitment')
    const producer = metadata.freeze.producerCases.find((row) => row.opaqueCaseId === mask.caseId)
    if (
      !producer ||
      mask.width !== producer.sourceCanvasWidth ||
      mask.height !== producer.sourceCanvasHeight
    )
      throw new RangeError('QUAL mask canvas differs from its source image')
    unpackBinaryLsb0V1(mask.width, mask.height, bytes)
    referenceMaskBytes.set(mask.packedBinarySha256, Uint8Array.from(bytes))
  }
  const devGroupSet = new Set(parent.annotations.cases.map((row) => row.sourceGroup))
  const qualGroupSet = new Set(metadata.annotations.cases.map((row) => row.sourceGroup))
  if ([...qualGroupSet].some((group) => devGroupSet.has(group)))
    throw new RangeError('QUAL source-group overlap with selected DEV parent')
  if (input.action !== 'closeout' && readClock() >= Date.parse(NATIVE_SELECTOR_QUAL_DEADLINE_ISO))
    throw new RangeError('QUAL execution deadline has passed')
  const admission: VerifiedNativeSelectorQualAdmission = {
    ...metadata,
    sourceBytes,
    referenceMaskBytes,
    parentLedgerVersion: parent.parentState.ledgerVersion,
    parentPhysicalDispatchCount: parent.parentState.physicalDispatchCount,
    parentLogicalAttemptCount: parent.parentState.logicalAttemptCount,
    parentKnownCostUsd: parent.parentState.knownCostUsd,
    parentUnknownReserveUsd: parent.parentState.unknownReserveUsd,
    parentNextPhysicalId: parent.parentState.nextPhysicalId,
    parentNextReservationId: parent.parentState.nextReservationId,
  }
  const frozenAdmission = Object.freeze(admission)
  verifiedQualAdmissions.set(
    frozenAdmission,
    Object.freeze({
      authority: 'production',
      namespaceRoot: root,
      authorityIdentitySha256: admissionIdentitySha256(frozenAdmission),
      protocolSha256: input.protocolSha256,
      caseIds: Object.freeze(admission.freeze.producerCases.map((row) => row.opaqueCaseId)),
      parentLedgerVersion: admission.parentLedgerVersion,
      parentPhysicalDispatchCount: admission.parentPhysicalDispatchCount,
      parentLogicalAttemptCount: admission.parentLogicalAttemptCount,
      parentKnownCostUsd: admission.parentKnownCostUsd,
      parentUnknownReserveUsd: admission.parentUnknownReserveUsd,
      parentNextPhysicalId: admission.parentNextPhysicalId,
      parentNextReservationId: admission.parentNextReservationId,
    }),
  )
  return frozenAdmission
}

interface NativeSelectorQualAdmissionSnapshot {
  authority: 'production' | 'offlineTestOnly'
  namespaceRoot: string
  authorityIdentitySha256: string
  protocolSha256: string
  caseIds: readonly string[]
  parentLedgerVersion: number
  parentPhysicalDispatchCount: number
  parentLogicalAttemptCount: number
  parentKnownCostUsd: number
  parentUnknownReserveUsd: number
  parentNextPhysicalId: number
  parentNextReservationId: number
}
const verifiedQualAdmissions = new WeakMap<object, NativeSelectorQualAdmissionSnapshot>()
export function isVerifiedNativeSelectorQualAdmission(
  value: unknown,
): value is VerifiedNativeSelectorQualAdmission {
  return typeof value === 'object' && value !== null && verifiedQualAdmissions.has(value)
}
export function nativeSelectorQualAdmissionSnapshot(
  value: unknown,
): NativeSelectorQualAdmissionSnapshot {
  if (!isVerifiedNativeSelectorQualAdmission(value))
    throw new RangeError('QUAL admission is not verified')
  const snapshot = verifiedQualAdmissions.get(value)
  if (!snapshot) throw new RangeError('QUAL admission is not verified')
  if (admissionIdentitySha256(value) !== snapshot.authorityIdentitySha256)
    throw new RangeError('QUAL verified admission changed after source validation')
  return snapshot
}

function admissionIdentitySha256(admission: VerifiedNativeSelectorQualAdmission): string {
  return hashIdentity({
    protocol: admission.protocol,
    protocolSha256: admission.protocolSha256,
    selectionCommitmentSha256: admission.selectionCommitmentSha256,
    freeze: phaseFreezeSchema.parse(admission.freeze),
    annotations: evaluatorPrivateAnnotationBundleSchema.parse(admission.annotations),
    sourceManifest: admission.sourceManifest,
    maskManifest: admission.maskManifest,
    exclusionAudit: admission.exclusionAudit,
    exposedExclusions: admission.exposedExclusions,
    sourceBytes: [...admission.sourceBytes]
      .map(([caseId, bytes]) => [caseId, sha256(bytes)] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    referenceMaskBytes: [...admission.referenceMaskBytes]
      .map(([digest, bytes]) => [digest, sha256(bytes)] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    parentLedgerVersion: admission.parentLedgerVersion,
    parentPhysicalDispatchCount: admission.parentPhysicalDispatchCount,
    parentLogicalAttemptCount: admission.parentLogicalAttemptCount,
    parentKnownCostUsd: admission.parentKnownCostUsd,
    parentUnknownReserveUsd: admission.parentUnknownReserveUsd,
    parentNextPhysicalId: admission.parentNextPhysicalId,
    parentNextReservationId: admission.parentNextReservationId,
  })
}

/** Creates a verified admission only from schema-checked fixtures in an owned temporary namespace. */
export async function createNativeSelectorQualOfflineTestAdmission(input: {
  offlineTestOnly: true
  namespaceRoot: string
  protocolBytes: Uint8Array
  protocolSha256: string
  offlineTestDeadlineIso: string
  offlineTestNow: number
  freezeValue: unknown
  annotationsValue: unknown
  sourceManifestValue: unknown
  maskManifestValue: unknown
  exclusionAuditValue: unknown
  exposedExclusionsValue: unknown
  acquisitionPolicyValue: unknown
  rightsPolicyValue: unknown
  annotationProvenancePolicyValue: unknown
  parentFreezePolicyValue: unknown
  sourceBytes: ReadonlyMap<string, Uint8Array>
  referenceMaskBytes: ReadonlyMap<string, Uint8Array>
  parent: Omit<
    NativeSelectorQualAdmissionSnapshot,
    'authority' | 'namespaceRoot' | 'authorityIdentitySha256' | 'protocolSha256' | 'caseIds'
  >
}): Promise<VerifiedNativeSelectorQualAdmission> {
  const namespaceRoot = resolve(input.namespaceRoot)
  const tempRoot = resolve(tmpdir())
  const protocolBytes = Buffer.from(input.protocolBytes)
  const sourceEntries = [...input.sourceBytes].map(
    ([id, bytes]) => [id, Uint8Array.from(bytes)] as const,
  )
  const maskEntries = [...input.referenceMaskBytes].map(
    ([sha, bytes]) => [sha, Uint8Array.from(bytes)] as const,
  )
  const parent = Object.freeze({ ...input.parent })
  if (
    input.offlineTestOnly !== true ||
    !isWithinDirectory(tempRoot, namespaceRoot) ||
    namespaceRoot === tempRoot
  )
    throw new RangeError(
      'Offline QUAL admissions require a disposable namespace below the temporary root',
    )
  const metadata = validateNativeSelectorQualMetadata({
    protocolSha256: input.protocolSha256,
    protocolBytes,
    offlineTestOnly: true,
    offlineTestDeadlineIso: input.offlineTestDeadlineIso,
    offlineTestNow: input.offlineTestNow,
    freezeValue: input.freezeValue,
    annotationsValue: input.annotationsValue,
    sourceManifestValue: input.sourceManifestValue,
    maskManifestValue: input.maskManifestValue,
    exclusionAuditValue: input.exclusionAuditValue,
    exposedExclusionsValue: input.exposedExclusionsValue,
    acquisitionPolicyValue: input.acquisitionPolicyValue,
    rightsPolicyValue: input.rightsPolicyValue,
    annotationProvenancePolicyValue: input.annotationProvenancePolicyValue,
  })
  assertNativeSelectorQualExecutionPolicyInheritance(input.parentFreezePolicyValue, metadata.freeze)
  if (
    sourceEntries.length !== metadata.sourceManifest.sources.length ||
    maskEntries.length !==
      new Set(metadata.maskManifest.masks.map((row) => row.packedBinarySha256)).size ||
    parent.parentPhysicalDispatchCount + 1_200 > 2_000 ||
    parent.parentPhysicalDispatchCount < 0 ||
    parent.parentLogicalAttemptCount < 0 ||
    parent.parentLedgerVersion < 0 ||
    !Number.isFinite(parent.parentKnownCostUsd) ||
    !Number.isFinite(parent.parentUnknownReserveUsd) ||
    parent.parentKnownCostUsd < 0 ||
    parent.parentUnknownReserveUsd < 0 ||
    parent.parentNextPhysicalId !== parent.parentPhysicalDispatchCount + 1 ||
    parent.parentNextReservationId < 1
  )
    throw new RangeError(
      'Offline QUAL test parent counters or byte maps exceed the closed phase bounds',
    )
  const sourceBytes = new Map(sourceEntries)
  const referenceMaskBytes = new Map(maskEntries)
  await assertCanonicalDirectory(namespaceRoot)
  const localRefs = [
    metadata.protocol.freeze,
    metadata.protocol.annotations,
    metadata.protocol.sourceManifest,
    metadata.protocol.referenceMaskManifest,
    metadata.protocol.exclusionAudit,
    metadata.protocol.exposedExclusions,
    metadata.protocol.acquisitionPolicy,
    metadata.protocol.rightsPolicy,
    metadata.protocol.annotationProvenancePolicy,
  ]
  const localValues = [
    metadata.freeze,
    metadata.annotations,
    metadata.sourceManifest,
    metadata.maskManifest,
    metadata.exclusionAudit,
    metadata.exposedExclusions,
    input.acquisitionPolicyValue,
    input.rightsPolicyValue,
    input.annotationProvenancePolicyValue,
  ]
  for (let index = 0; index < localRefs.length; index++) {
    const ref = localRefs[index]!
    const path = resolve(ref.path)
    if (!isWithinDirectory(namespaceRoot, path))
      throw new RangeError('Offline QUAL metadata pin escapes its disposable namespace')
    const bytes = await readPinnedReplayFile(path, ref.sha256, 8 * 1024 * 1024)
    if (
      bytes.byteLength !== ref.bytes ||
      !bytes.equals(Buffer.from(JSON.stringify(localValues[index])))
    )
      throw new RangeError('Offline QUAL metadata bytes differ from their raw pinned fixture')
  }
  if (!isWithinDirectory(namespaceRoot, resolve(metadata.protocol.parentDev.root)))
    throw new RangeError('Offline QUAL fixture must keep the selected DEV40 parent graph local')
  for (const source of metadata.sourceManifest.sources) {
    const bytes = sourceBytes.get(source.caseId)
    const producer = metadata.freeze.producerCases.find((row) => row.opaqueCaseId === source.caseId)
    if (
      !bytes ||
      sha256(bytes) !== source.sha256 ||
      !producer ||
      producer.sourceBytesSha256 !== source.sha256 ||
      resolve(source.path) !== join(namespaceRoot, 'sources', `${source.sha256}.jpg`)
    )
      throw new RangeError('Offline QUAL source bytes differ from their closed test manifest')
    const diskBytes = await readPinnedReplayFile(source.path, source.sha256, 8 * 1024 * 1024)
    if (!diskBytes.equals(bytes))
      throw new RangeError('Offline QUAL source file differs from its owned bytes')
  }
  for (const mask of metadata.maskManifest.masks) {
    const bytes = referenceMaskBytes.get(mask.packedBinarySha256)
    if (
      !bytes ||
      sha256(bytes) !== mask.sha256 ||
      sha256PackedBytes(bytes) !== mask.packedBinarySha256 ||
      resolve(mask.path) !== join(namespaceRoot, 'masks', `${mask.packedBinarySha256}.bin`)
    )
      throw new RangeError('Offline QUAL masks differ from their closed test manifest')
    const diskBytes = await readPinnedReplayFile(mask.path, mask.sha256, 8 * 1024 * 1024)
    if (!diskBytes.equals(bytes))
      throw new RangeError('Offline QUAL mask file differs from its owned bytes')
  }
  const admission: VerifiedNativeSelectorQualAdmission = {
    ...metadata,
    sourceBytes,
    referenceMaskBytes,
    parentLedgerVersion: parent.parentLedgerVersion,
    parentPhysicalDispatchCount: parent.parentPhysicalDispatchCount,
    parentLogicalAttemptCount: parent.parentLogicalAttemptCount,
    parentKnownCostUsd: parent.parentKnownCostUsd,
    parentUnknownReserveUsd: parent.parentUnknownReserveUsd,
    parentNextPhysicalId: parent.parentNextPhysicalId,
    parentNextReservationId: parent.parentNextReservationId,
  }
  const frozenAdmission = Object.freeze(admission)
  verifiedQualAdmissions.set(
    frozenAdmission,
    Object.freeze({
      authority: 'offlineTestOnly',
      namespaceRoot,
      authorityIdentitySha256: admissionIdentitySha256(frozenAdmission),
      protocolSha256: metadata.protocolSha256,
      caseIds: Object.freeze(metadata.freeze.producerCases.map((row) => row.opaqueCaseId)),
      ...parent,
    }),
  )
  return frozenAdmission
}
