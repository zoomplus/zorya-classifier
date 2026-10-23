import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { currentRuntimeSourcePaths } from './fixtures/current-runtime-sources.js'
import { dirname, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertVerifiedBoxHeldoutFreeze,
  boxHeldoutCandidatePolicy,
  boxHeldoutNoImagePolicy,
  boxHeldoutMethodSelectionSha256,
  boxHeldoutProfileIds,
  buildBoxHeldoutPlans,
  verifyBoxHeldoutFreezeBytes,
} from '../benchmarks/v02/categorical-box-heldout-plan.js'
import { parseCategoricalBoxHeldoutArgs } from '../benchmarks/v02/run-categorical-box-heldout.js'
import { parseBoxCategoricalEvaluationFreeze } from '../benchmarks/v02/evaluate-categorical-box-heldout.js'
import { hashCanonical } from '../benchmarks/v02/protocol.js'
import { freshProducerTask } from '../benchmarks/v02/fresh-corpus.js'
import type { FreshCase } from '../benchmarks/v02/fresh-corpus.js'
import { freshTextPolicyForPhase } from '../benchmarks/v02/fresh-text-runner.js'
import { promptVariants } from '../benchmarks/v02/promptvariants.js'
import { textTransportVariants } from '../benchmarks/v02/transportvariants.js'
import {
  categoricalBoxHeldoutProducerSourceManifest,
  categoricalBoxHeldoutProducerSourceSha256,
} from '../benchmarks/v02/categorical-presence-fresh-runner.js'
import { freshTextBoxHeldoutProducerSourceManifest } from '../benchmarks/v02/fresh-text-runner.js'
import { boxHeldoutImportSpecifiers } from '../benchmarks/v02/categorical-box-heldout-source.js'
import { normalizeBoxCategoricalHeldoutOutput } from '../benchmarks/v02/evaluate-categorical-box-heldout.js'
import { normalizeBoxNoImageControlOutput } from '../benchmarks/v02/evaluate-box-no-image-heldout.js'
import { z } from 'zod'

const boxHeldoutHistoricalSourceReviewSchema = z.object({
  sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
})

const hash = (digit: string) => digit.repeat(64)
const freezeFixture = {
  schema: 'categorical-box-heldout-run-freeze-v1',
  phase: 'heldout',
  profileId: boxHeldoutProfileIds.candidate,
  selectionVersion: 'box-confirmation-dev-method-selection-v1',
  methodSelectionSha256: boxHeldoutMethodSelectionSha256,
  targetPolicy: 'target-plus-neutral-instruction-v1',
  manifests: [
    { group: 'photo', cases: 40, sha256: hash('a') },
    { group: 'ui', cases: 20, sha256: hash('b') },
    { group: 'map', cases: 20, sha256: hash('c') },
  ],
  producerSourceSha256: hash('d'),
  noImageProducerSourceSha256: hash('e'),
  candidateBudget: {
    maxPhysicalCalls: 600,
    maxCostUsd: 10,
    unknownCostReserveUsd: 0.05,
    maxPhysicalCallsPerCase: 6,
    maxInFlightCases: 2,
    timeoutMs: 120_000,
    nativeMaxActive: 1,
    nativeMaxWaiting: 2,
    nativeThreads: 2,
    boxTolerancePx: 8,
    maxExtentPasses: 3,
    retries: 0,
    fallback: false,
  },
  noImageBudget: {
    maxPhysicalCalls: 300,
    maxCostUsd: 5,
    unknownCostReserveUsd: 0.05,
    maxPhysicalCallsPerCase: 6,
    maxInFlightCases: 1,
    timeoutMs: 120_000,
    boxTolerancePx: 8,
    maxExtentPasses: 3,
    retries: 0,
    fallback: false,
    classifyMaxOutputTokens: 1024,
    locateMaxOutputTokens: 4096,
    imagePartsRemoved: true,
    imageEncoder: null,
    objectProposals: null,
    segmentation: false,
    ocr: false,
  },
}

function syntheticCases(counts: readonly [number, number, number]): FreshCase[] {
  const groups = ['photo', 'ui', 'map'] as const
  return groups.flatMap((group, groupIndex) =>
    Array.from({ length: counts[groupIndex]! }, (_, index) => {
      const caseId = `${group}-synthetic-${index}`
      return {
        caseId,
        image: {
          path: `${group}/${index}.png`,
          sha256: hashCanonical(['synthetic-image', caseId]),
          width: 640,
          height: 480,
        },
        locate: { target: `synthetic ${group} object ${index}` },
        classify: { options: ['present', 'absent'] },
      }
    }),
  )
}

function syntheticStages(cases: readonly FreshCase[], profileId?: string) {
  return cases.map((item) => ({
    caseId: item.caseId,
    imageSha256: item.image.sha256,
    ...(profileId ? { profileId } : {}),
    classify: {
      status: 'failed',
      durationMs: 0,
      ...(profileId ? { calls: 0 } : { physicalCalls: 0, logicalCalls: 0 }),
      requestHashes: [] as string[],
      errorCode: 'INVALID_INPUT',
    },
    locate: {
      status: 'unknown',
      reason: 'extent-uncertain',
      durationMs: 0,
      ...(profileId ? { calls: 0 } : { physicalCalls: 0, logicalCalls: 0 }),
      requestHashes: [] as string[],
    },
    ...(!profileId
      ? { extract: { status: 'unknown', reason: 'extent-uncertain', durationMs: 0 } }
      : {}),
  }))
}

function pin(value: unknown) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

await test('box heldout freeze has its own strict selection and two distinct profile identities', async () => {
  const frozen = pin(freezeFixture)
  const verified = verifyBoxHeldoutFreezeBytes(frozen.bytes, frozen.sha256)
  assertVerifiedBoxHeldoutFreeze(verified)
  const plans = buildBoxHeldoutPlans(verified)
  assert.equal(
    plans.candidate.profileId,
    'native-luna-box-confirmation-sam-target-plus-neutral-heldout-v1',
  )
  assert.equal(plans.noImage.profileId, 'deepseek-flash-no-image-photo-box-confirmation-heldout-v1')
  assert.equal(plans.candidate.methodSelectionSha256, boxHeldoutMethodSelectionSha256)
  assert.equal(Object.isFrozen(plans.candidate.manifests), true)
  assert.throws(() => {
    ;(verified.manifests[0] as { group: string }).group = 'changed'
  }, TypeError)
  assert.throws(() => assertVerifiedBoxHeldoutFreeze({ ...verified }), /externally pinned freeze/u)
  assert.throws(() => parseBoxCategoricalEvaluationFreeze({ ...freezeFixture, extra: true }))
})

await test('box heldout freeze rejects legacy selection/profile identities and reordered strata', async () => {
  const legacy = { ...freezeFixture, methodSelectionSha256: hash('f') }
  const legacyPin = pin(legacy)
  assert.throws(() => verifyBoxHeldoutFreezeBytes(legacyPin.bytes, legacyPin.sha256))
  const wrongProfile = {
    ...freezeFixture,
    profileId: 'native-luna-categorical-presence-sam-heldout-target-plus-neutral-v1',
  }
  const profilePin = pin(wrongProfile)
  assert.throws(() => verifyBoxHeldoutFreezeBytes(profilePin.bytes, profilePin.sha256))
  const wrongOrder = {
    ...freezeFixture,
    manifests: [freezeFixture.manifests[1], freezeFixture.manifests[0], freezeFixture.manifests[2]],
  }
  const orderPin = pin(wrongOrder)
  assert.throws(() => verifyBoxHeldoutFreezeBytes(orderPin.bytes, orderPin.sha256))
})

await test('new independent evaluators reject legacy profile artifacts instead of relabeling them', async () => {
  const legacyCandidate = {
    profileId: 'native-luna-categorical-presence-sam-heldout-target-plus-neutral-v1',
  }
  assert.throws(
    () =>
      normalizeBoxCategoricalHeldoutOutput({}, legacyCandidate, [], [], {
        summarySha256: hash('a'),
        runManifestSha256: hash('b'),
        freezeSha256: hash('c'),
        freeze: freezeFixture,
      }),
    /profileId/u,
  )
  assert.throws(
    () =>
      normalizeBoxNoImageControlOutput(
        {},
        { profileId: 'deepseek-flash-no-image-photo-heldout-v1' },
        [],
        {
          expectedProducerSourceSha256: hash('d'),
          expectedCandidateSourceSha256: hash('e'),
          freeze: freezeFixture,
          expectedPromptSha256: hash('a'),
          summarySha256: hash('b'),
          runManifestSha256: hash('c'),
          freezeSha256: hash('f'),
        },
      ),
    /profileId/u,
  )
})

await test('both new evaluators normalize explicit synthetic fixtures and retain emitted policy', async () => {
  const candidateCases = syntheticCases([40, 20, 20])
  const reviewPath = fileURLToPath(
    new URL('../docs/evidence/v02/box-heldout-source-review-20261020-v1.json', import.meta.url),
  )
  const review = boxHeldoutHistoricalSourceReviewSchema.parse(
    JSON.parse(await readFile(reviewPath, 'utf8')),
  )
  const sourceHashes: Record<string, string> = {}
  for (const path of Object.keys(review.sourceHashes)) {
    sourceHashes[path] = createHash('sha256').update(`synthetic-source:${path}`).digest('hex')
  }
  assert.equal(Object.keys(sourceHashes).length, 82)
  assert.equal(Object.keys(sourceHashes).filter((path) => path.startsWith('src/')).length, 53)
  const sourceSha256 = hashCanonical(
    Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)),
  )
  const frozenFixture = {
    ...freezeFixture,
    producerSourceSha256: sourceSha256,
    noImageProducerSourceSha256: sourceSha256,
  }
  const verified = verifyBoxHeldoutFreezeBytes(
    Buffer.from(`${JSON.stringify(frozenFixture)}\n`),
    createHash('sha256')
      .update(`${JSON.stringify(frozenFixture)}\n`)
      .digest('hex'),
  )
  const plans = buildBoxHeldoutPlans(verified)
  const sourcePins = frozenFixture.manifests
  const candidateManifest = {
    schemaVersion: 1,
    runId: 'synthetic-box-candidate',
    profileId: plans.candidate.profileId,
    phase: 'heldout',
    purpose: plans.candidate.purpose,
    startedAt: '2026-10-20T00:00:00.000Z',
    variantSha256: hash('f'),
    producerSourceSha256: sourceSha256,
    sourceBeforeSha256: sourceSha256,
    methodSelectionSha256: boxHeldoutMethodSelectionSha256,
    heldoutInputManifests: sourcePins,
    sourceHashes,
    manifests: sourcePins.map(({ sha256, cases }) => ({ sha256, cases })),
    plannedCaseIds: candidateCases.map((item) => item.caseId),
    plannedCases: candidateCases.map((item) => ({
      caseId: item.caseId,
      imageSha256: item.image.sha256,
      imageDimensions: { width: item.image.width, height: item.image.height },
    })),
    route: {
      id: 'openai-gpt-6-luna-decisions-openai-v1',
      ...plans.candidate.route,
    },
    mobileSam: {
      method: 'mobile-sam-nine-point-proposals-v1',
      executionProvider: 'cpu',
      encoder: {
        bytes: 28_157_093,
        sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
      },
      decoder: {
        bytes: 16_496_559,
        sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
      },
    },
    policy: boxHeldoutCandidatePolicy,
    targetPolicy: 'target-plus-neutral-instruction-v1',
    classification: {
      questionSource: 'freshProducerTask.question',
      instructionSuffix: 'Use only the supplied image. Choose exactly one closed label.',
      classes: [
        { id: 'present', description: 'The target in the question is visible in this image.' },
        { id: 'absent', description: 'The target in the question is not visible in this image.' },
      ],
    },
    taskManifest: candidateCases.map((item) => ({
      caseId: item.caseId,
      task: freshProducerTask(item),
    })),
    modelBoundary: {
      evaluatorTruthRead: false,
      groundTruthInProducer: false,
      retries: 0,
      fallback: false,
    },
  }
  const candidateRows = syntheticStages(candidateCases)
  const candidateSummary = {
    runId: candidateManifest.runId,
    profileId: candidateManifest.profileId,
    phase: 'heldout',
    purpose: candidateManifest.purpose,
    targetPolicy: candidateManifest.targetPolicy,
    variantSha256: candidateManifest.variantSha256,
    producerSourceSha256: sourceSha256,
    sourceBeforeSha256: sourceSha256,
    methodSelectionSha256: boxHeldoutMethodSelectionSha256,
    heldoutInputManifests: sourcePins,
    sourceAfterSha256: sourceSha256,
    sourceUnchanged: true,
    status: 'complete',
    plannedCaseIds: candidateManifest.plannedCaseIds,
    completedCaseIds: candidateManifest.plannedCaseIds,
    missingCaseIds: [],
    results: candidateRows,
    aggregate: {
      admittedPhysicalCalls: 0,
      knownCostUsd: 0,
      unknownCostCalls: 0,
      inFlightCalls: 0,
      accountedExposureUsd: 0,
      maxPhysicalCalls: 600,
      maxCostUsd: 10,
    },
    latencyEnvironment: boxHeldoutCandidatePolicy.latencyEnvironment,
    latencyRankingEligible: false,
    initializationError: null,
    shutdownError: null,
    settleError: null,
    disposeError: null,
    physicalReceipts: [],
  }
  const normalizedCandidate = normalizeBoxCategoricalHeldoutOutput(
    candidateSummary,
    candidateManifest,
    candidateCases,
    sourcePins.map(({ sha256, cases }) => ({ sha256, cases })),
    {
      summarySha256: hash('1'),
      runManifestSha256: hash('2'),
      freezeSha256: hash('3'),
      freeze: frozenFixture,
    },
  )
  assert.equal(normalizedCandidate.profileId, boxHeldoutProfileIds.candidate)
  assert.deepEqual(normalizedCandidate.rawProposalProvenance.policy, boxHeldoutCandidatePolicy)
  assert.equal(normalizedCandidate.results.length, 80)

  const photoCases = candidateCases.slice(0, 40)
  const noImagePlan = plans.noImage
  const noImagePrompt = promptVariants['grammar-plus-examples']
  const noImageTransport = textTransportVariants['none-json-schema']
  const noImageRoute = {
    id: 'together-deepseek-flash-text-v1',
    model: 'deepseek/deepseek-v4.1-flash',
    provider: 'together',
    providerName: 'Together',
    apiEndpoint: '/api/v1/chat/completions',
    allowFallbacks: false,
  }
  const noImagePolicy = freshTextPolicyForPhase('heldout')
  const photoPin = { sha256: sourcePins[0]!.sha256, cases: 40 }
  const plannedPhotoCases = photoCases.map((item) => ({
    caseId: item.caseId,
    imageSha256: item.image.sha256,
    imageDimensions: { width: item.image.width, height: item.image.height },
  }))
  const noImagePromptSha = hashCanonical(noImagePrompt)
  const noImageTransportSha = hashCanonical(noImageTransport)
  const noImageManifest = {
    schemaVersion: 1,
    runId: 'synthetic-box-noimage',
    profileId: noImagePlan.profileId,
    phase: 'heldout',
    purpose: noImagePlan.purpose,
    targetPolicy: noImagePlan.targetPolicy,
    methodSelectionSha256: boxHeldoutMethodSelectionSha256,
    variantSha256: hash('4'),
    producerSourceSha256: sourceSha256,
    sourceBeforeSha256: sourceSha256,
    startedAt: '2026-10-20T00:00:00.000Z',
    stages: 'classify-and-locate',
    sourceHashes,
    heldoutProducerSourceSha256: sourceSha256,
    producerSourceRole: 'producer-only',
    manifests: [photoPin],
    plannedCaseIds: photoCases.map((item) => item.caseId),
    plannedCases: plannedPhotoCases,
    route: noImageRoute,
    policy: noImagePolicy,
    prompt: noImagePrompt,
    promptSha256: noImagePromptSha,
    transport: noImageTransport,
    transportSha256: noImageTransportSha,
    routePolicy: {
      responseFormat: 'json-schema',
      reasoningEffort: 'none',
      promptVariant: 'grammar-plus-examples',
      transportVariant: 'none-json-schema',
      imagePartsRemoved: true,
      textEncoder: null,
      objectProposals: null,
      segmentation: false,
      ocr: false,
    },
    modelBoundary: {
      evaluatorTruthRead: false,
      retries: 0,
      fallback: false,
      imagePartsRemoved: true,
      textEncoder: null,
      segmentation: false,
      ocr: false,
    },
    imagePartAudit: {
      method: 'inspect-every-serialized-provider-request-before-fetch-v1',
      expectedImageParts: 0,
      expectedEncodedImageState: false,
      rawBodiesPersisted: false,
    },
  }
  const noImageRows = syntheticStages(photoCases, noImagePlan.profileId)
  const noImageSummary = {
    runId: noImageManifest.runId,
    profileId: noImageManifest.profileId,
    phase: 'heldout',
    purpose: noImageManifest.purpose,
    targetPolicy: noImageManifest.targetPolicy,
    methodSelectionSha256: boxHeldoutMethodSelectionSha256,
    variantSha256: noImageManifest.variantSha256,
    producerSourceSha256: sourceSha256,
    sourceBeforeSha256: sourceSha256,
    sourceAfterSha256: sourceSha256,
    sourceUnchanged: true,
    status: 'complete',
    plannedCaseIds: noImageManifest.plannedCaseIds,
    completedCaseIds: noImageManifest.plannedCaseIds,
    missingCaseIds: [],
    failure: null,
    results: noImageRows,
    aggregate: {
      admittedPhysicalCalls: 0,
      knownCostUsd: 0,
      unknownCostCalls: 0,
      inFlightCalls: 0,
      accountedExposureUsd: 0,
      maxPhysicalCalls: 300,
      maxCostUsd: 5,
    },
    policy: noImagePolicy,
    latencyEnvironment: noImagePolicy.latencyEnvironment,
    latencyRankingEligible: false,
    physicalReceipts: [],
    imagePartAudit: {
      fetchesChecked: 0,
      fetchAttempts: 0,
      zeroImagePartsConfirmed: 0,
      zeroImageDerivedStateConfirmed: 0,
      imagePartViolations: 0,
      unverifiableBodies: 0,
      complete: true,
    },
  }
  const normalizedNoImage = normalizeBoxNoImageControlOutput(
    noImageSummary,
    noImageManifest,
    photoCases,
    {
      expectedProducerSourceSha256: sourceSha256,
      expectedCandidateSourceSha256: sourceSha256,
      expectedPromptSha256: noImagePromptSha,
      summarySha256: hash('5'),
      runManifestSha256: hash('6'),
      freezeSha256: hash('7'),
      freeze: frozenFixture,
    },
  )
  assert.equal(normalizedNoImage.profileId, boxHeldoutProfileIds.noImage)
  assert.deepEqual(normalizedNoImage.policy, boxHeldoutNoImagePolicy)
  assert.equal(normalizedNoImage.imagePartAudit.zeroImagePartsConfirmed, 0)
  assert.equal(normalizedNoImage.results.length, 40)
})

await test('new heldout CLI requires explicit paid mode and the new named profile', async () => {
  const base = [
    '--profile',
    'candidate',
    '--freeze',
    '/evidence/freeze.json',
    '--freeze-sha256',
    hash('a'),
    '--image-root',
    '/corpus/images',
    '--photo-inputs',
    '/corpus/photo.json',
    '--ui-inputs',
    '/corpus/ui.json',
    '--map-inputs',
    '/corpus/map.json',
    '--out',
    '/runs',
  ]
  assert.throws(() => parseCategoricalBoxHeldoutArgs(base), /explicit allow-paid/u)
  const parsed = parseCategoricalBoxHeldoutArgs(['--allow-paid', ...base])
  assert.equal(parsed.profile, 'candidate')
  assert.equal(parsed.freezePath, resolve('/evidence/freeze.json'))
  assert.throws(
    () =>
      parseCategoricalBoxHeldoutArgs([
        '--allow-paid',
        ...base.map((value, index) => (index === 1 ? 'legacy-candidate' : value)),
      ]),
    /Select exactly one box HELDOUT profile/u,
  )
})

await test('new source closures include the dedicated plan, CLI, and its transitive local imports', async () => {
  const candidate = await categoricalBoxHeldoutProducerSourceManifest()
  const noImage = await freshTextBoxHeldoutProducerSourceManifest()
  const runtimePaths = await currentRuntimeSourcePaths()
  assert.deepEqual(
    Object.keys(candidate)
      .filter((path) => path.startsWith('src/'))
      .sort(),
    runtimePaths,
  )
  assert.deepEqual(
    Object.keys(noImage)
      .filter((path) => path.startsWith('src/'))
      .sort(),
    runtimePaths,
  )
  assert.equal(Object.keys(candidate).length, runtimePaths.length + 32)
  assert.equal(Object.keys(noImage).length, runtimePaths.length + 32)
  assert.ok(Object.hasOwn(candidate, 'src/processes/extract-from-region.ts'))
  for (const sources of [candidate, noImage]) {
    assert.ok(Object.hasOwn(sources, './categorical-box-heldout-plan.ts'))
    assert.ok(Object.hasOwn(sources, './categorical-box-heldout-source.ts'))
    assert.ok(Object.hasOwn(sources, './run-categorical-box-heldout.ts'))
    assert.ok(Object.hasOwn(sources, './categorical-presence-fresh-pair.md'))
    assert.ok(Object.hasOwn(sources, '../../package.json'))
    assert.ok(Object.hasOwn(sources, '../../package-lock.json'))
    assert.ok(Object.hasOwn(sources, '../experiments/text-representation.ts'))
    assert.ok(Object.hasOwn(sources, '../experiments/boundary-view.ts'))
    assert.ok(Object.hasOwn(sources, '../experiments/create-research-classifier.ts'))
  }
  assert.deepEqual(Object.keys(candidate).sort(), Object.keys(noImage).sort())
  assert.equal(
    await categoricalBoxHeldoutProducerSourceSha256(),
    hashCanonical(Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b))),
  )

  const benchmarkRoot = fileURLToPath(new URL('../benchmarks/v02/', import.meta.url))
  const projectRoot = resolve(benchmarkRoot, '../..')
  const queue = [resolve(benchmarkRoot, 'run-categorical-box-heldout.ts')]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const current = queue.pop()
    if (!current || visited.has(current)) continue
    visited.add(current)
    const source = await readFile(current, 'utf8')
    for (const specifier of boxHeldoutImportSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue
      const base = resolve(dirname(current), specifier)
      const localPath = base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : `${base}.ts`
      const projectPath = relative(projectRoot, localPath)
      const label = projectPath.startsWith(`src${sep}`)
        ? projectPath.split(sep).join('/')
        : relative(benchmarkRoot, localPath).split(sep).join('/')
      const sourceLabel = label.startsWith('../') || label.startsWith('src/') ? label : `./${label}`
      assert.ok(Object.hasOwn(candidate, sourceLabel), `missing transitive import ${sourceLabel}`)
      if (!projectPath.startsWith(`src${sep}`)) queue.push(localPath)
    }
  }
})
