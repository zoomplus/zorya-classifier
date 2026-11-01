import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { buildSyntheticAnnotationBundle, buildSyntheticPhaseFreeze } from './test-fixtures.js'
import { validateDevScreenSelection } from './dev-screen-sampling.js'
import {
  assembleDevFreezeFromDisk,
  verifyPersistedDevFreeze,
  writeDevFreezeExclusive,
} from './dev-freeze-assembly.js'
import { hashIdentity } from './hash-identity.js'
import { phaseFreezeSchema } from './schemas.js'
import './dev-freeze-cli.js'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

async function writeJson(
  root: string,
  path: string,
  value: unknown,
): Promise<{ path: string; sha256: string }> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), bytes)
  return { path, sha256: sha256(bytes) }
}

function protocolHash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex')
}

async function makeCompleteDiskInputs(
  root: string,
  fixtureOptions: {
    disjoint?: boolean
    wrongNamedGroupQuota?: boolean
    wrongMapFamily?: boolean
    reuseHistoricalSourceGroup?: boolean
    omitOnePhotoMask?: boolean
    duplicateFirstTwoSources?: boolean
    invalidFirstPositiveBox?: boolean
    missingPositiveMaskMetadata?: boolean
    omitNativeWorkerClosure?: boolean
  } = {},
): Promise<{
  options: {
    authorityPath: string
    authoritySha256: string
    sourceRoot: string
    outputDirectory: string
    testOnlyDisjointLineagePins?: {
      parentRegistrationSha256: string
      acceptedHistorySha256: string
    }
  }
  sourcePath: string
  fragmentReviewPath: string
  priceProofPath: string
}> {
  const artifactRoot = join(root, 'artifacts')
  const sourceRoot = join(root, 'source')
  await mkdir(artifactRoot, { recursive: true })
  await mkdir(sourceRoot, { recursive: true })
  const orderProtocolBytes = Buffer.from(
    `${JSON.stringify({
      schema: 'h8a-fresh-paired-order-protocol-v1',
      seedHex: '76303308',
      hashAlgorithm: 'SHA-256',
      hashInput: 'UTF-8 bytes joined by NUL, no trailing NUL',
      caseOrdering: {
        primary: 'ascending hash(seedHex, case-order-v1, opaqueCaseId)',
        tie: 'ascending opaqueCaseId',
        include: 'all 40 producer rows; derive pairedSchedule in same order',
      },
      armFirst: {
        firstBit:
          'integer value of final hex digit of hash(seedHex, first-arm-v1, stratum) modulo 2',
        forCase:
          'candidate first iff (zero-based rank within stratum + firstBit) modulo 2 equals zero',
        groupBy: 'stratum only, no expected presence or outcome',
      },
    })}\n`,
  )
  const orderProtocolPath = join(artifactRoot, 'registry/order-protocol.json')
  await mkdir(join(artifactRoot, 'registry'), { recursive: true })
  await writeFile(orderProtocolPath, orderProtocolBytes)
  const orderProtocolRef = {
    path: relative(artifactRoot, orderProtocolPath),
    sha256: sha256(orderProtocolBytes),
  }
  const { freeze: fixture } = buildSyntheticPhaseFreeze('h8a-fresh-paired-dev40-v1')

  const mapRows = fixture.producerCases.filter(
    (row, index) => fixture.pairedSchedule[index]!.stratum === 'map',
  )
  assert.equal(mapRows.length, 10)
  const mapIdToFamily = new Map<string, string>()
  const rosterRows = mapRows.map((_, index) => {
    const familySlug = fixtureOptions.disjoint
      ? index < 5
        ? 'xsok'
        : 'gnurobbo'
      : index < 5
        ? 'freecol'
        : 'crimson'
    const predeclaredStateId = fixtureOptions.disjoint
      ? `${familySlug}:synthetic-state-${String(index + 1).padStart(2, '0')}`
      : `synthetic-state-${String(index + 1).padStart(2, '0')}`
    const opaqueCaseId = protocolHash([
      '76303308',
      'map-id-v1',
      familySlug,
      predeclaredStateId,
    ]).slice(0, 32)
    mapIdToFamily.set(opaqueCaseId, familySlug)
    return { familySlug, predeclaredStateId, opaqueCaseId }
  })
  let mapIndex = 0
  const idReplacement = new Map<string, string>()
  for (const row of mapRows)
    idReplacement.set(row.opaqueCaseId, rosterRows[mapIndex++]!.opaqueCaseId)
  const sourcePathById = new Map<string, string>()
  await mkdir(join(artifactRoot, 'inputs'), { recursive: true })
  const producerRows = await Promise.all(
    fixture.producerCases.map(async (row, index) => {
      const opaqueCaseId = idReplacement.get(row.opaqueCaseId) ?? row.opaqueCaseId
      const pixels = Buffer.alloc(8 * 8 * 3, 60)
      pixels[0] = (fixtureOptions.duplicateFirstTwoSources && index === 1 ? 0 : index) + 1
      const png = await sharp(pixels, { raw: { width: 8, height: 8, channels: 3 } })
        .png()
        .toBuffer()
      const sourcePath = join(artifactRoot, 'inputs', `${opaqueCaseId}.png`)
      await writeFile(sourcePath, png)
      sourcePathById.set(opaqueCaseId, sourcePath)
      return {
        ...row,
        opaqueCaseId,
        sourceBytesSha256: sha256(png),
        sourceCanvasWidth: 8,
        sourceCanvasHeight: 8,
        targetTaskText: `target for ${opaqueCaseId}`,
      }
    }),
  )
  const sourcePath = sourcePathById.get(producerRows[0]!.opaqueCaseId)!
  const generatedBundle = buildSyntheticAnnotationBundle(
    'h8a-fresh-paired-dev40-v1',
    'synthetic-dev40',
    fixture.producerCases,
    fixture.pairedSchedule,
  )
  let uiRowIndex = 0
  const mapGroupIndex = new Map<string, number>()
  let photoRowIndex = 0
  const annotations = generatedBundle.cases.map((row) => {
    const opaqueCaseId = idReplacement.get(row.opaqueCaseId) ?? row.opaqueCaseId
    const family = mapIdToFamily.get(opaqueCaseId)
    if (fixtureOptions.disjoint && row.stratum === 'ui') {
      const groupIndex = uiRowIndex++
      const gnumeric = groupIndex < 5
      const positiveCount = gnumeric === (fixtureOptions.wrongNamedGroupQuota === true) ? 3 : 4
      const expectedPresence =
        groupIndex % 5 < positiveCount ? ('present' as const) : ('absent' as const)
      return {
        ...row,
        opaqueCaseId,
        sourceGroup: gnumeric ? 'gnumeric' : 'evince',
        expectedPresence,
        referenceBoxes:
          expectedPresence === 'present'
            ? row.referenceBoxes.length > 0
              ? row.referenceBoxes
              : [{ left: 1, top: 1, width: 2, height: 2 }]
            : [],
      }
    }
    if (fixtureOptions.disjoint && row.stratum === 'map') {
      const sourceFamily = family!
      const groupIndex = mapGroupIndex.get(sourceFamily) ?? 0
      mapGroupIndex.set(sourceFamily, groupIndex + 1)
      const xsok = sourceFamily === 'xsok'
      const positiveCount = xsok === (fixtureOptions.wrongNamedGroupQuota === true) ? 3 : 4
      const expectedPresence =
        groupIndex < positiveCount ? ('present' as const) : ('absent' as const)
      return {
        ...row,
        opaqueCaseId,
        sourceGroup: xsok ? 'game:xsok' : 'game:gnurobbo',
        expectedPresence,
        referenceBoxes:
          expectedPresence === 'present'
            ? row.referenceBoxes.length > 0
              ? row.referenceBoxes
              : [{ left: 1, top: 1, width: 2, height: 2 }]
            : [],
      }
    }
    if (fixtureOptions.disjoint && row.stratum === 'photo') {
      const groupIndex = ++photoRowIndex
      return {
        ...row,
        opaqueCaseId,
        sourceGroup:
          fixtureOptions.reuseHistoricalSourceGroup && groupIndex === 1
            ? 'historical-source-group-1'
            : `photo:synthetic-author-${groupIndex}`,
      }
    }
    return {
      ...row,
      opaqueCaseId,
      sourceGroup:
        family === 'freecol'
          ? 'synthetic-map-freecol'
          : family === 'crimson'
            ? 'synthetic-map-crimson'
            : row.sourceGroup,
    }
  })
  const maskRefs: { path: string; sha256: string }[] = []
  if (fixtureOptions.disjoint) {
    let positiveIndex = 0
    for (const annotation of annotations) {
      if (annotation.stratum !== 'photo' || annotation.expectedPresence !== 'present') continue
      if (fixtureOptions.omitOnePhotoMask && positiveIndex === 0) {
        positiveIndex += 1
        continue
      }
      const packed = Buffer.alloc(8)
      packed[positiveIndex % packed.length] = 1 << Math.floor(positiveIndex / packed.length)
      const digest = sha256(packed)
      const maskPath = `masks/${digest}.binary-lsb0`
      await mkdir(join(artifactRoot, 'masks'), { recursive: true })
      await writeFile(join(artifactRoot, maskPath), packed)
      annotation.referenceMasks = [{ width: 8, height: 8, packedBinarySha256: digest }]
      annotation.exactOriginalCanvasMaskRef = true
      maskRefs.push({ path: maskPath, sha256: digest })
      positiveIndex += 1
    }
    assert.equal(positiveIndex, 16)
  }
  if (fixtureOptions.invalidFirstPositiveBox) {
    const positive = annotations.find((row) => row.expectedPresence === 'present')!
    positive.referenceBoxes[0]!.left = 7
  }
  if (fixtureOptions.missingPositiveMaskMetadata) {
    const positive = annotations.find(
      (row) => row.stratum === 'photo' && row.expectedPresence === 'present',
    )!
    positive.exactOriginalCanvasMaskRef = true
  }
  const annotationById = new Map(annotations.map((row) => [row.opaqueCaseId, row]))
  const provenance: Record<string, unknown> = {}
  const controllerPathIndex: Record<string, string> = {}
  const rows = []
  const reviewReceiptBytes = Buffer.from('{"schema":"synthetic-main-review-receipt-v1"}\n')
  const reviewReceiptPath = join(artifactRoot, 'review-receipt.json')
  await writeFile(reviewReceiptPath, reviewReceiptBytes)
  const reviewReceiptSha256 = sha256(reviewReceiptBytes)
  for (const row of producerRows) {
    const annotation = annotationById.get(row.opaqueCaseId)!
    provenance[row.opaqueCaseId] = { admitted: true, sourceGroup: annotation.sourceGroup }
    controllerPathIndex[row.opaqueCaseId] = sourcePathById.get(row.opaqueCaseId)!
    rows.push({
      opaqueCaseId: row.opaqueCaseId,
      fragmentId: 'synthetic-complete-dev40',
      accepted: true as const,
      sourceSha256: row.sourceBytesSha256,
      annotationSha256: hashIdentity(annotation),
      sourceGroup: annotation.sourceGroup,
      provenanceSha256: hashIdentity(provenance[row.opaqueCaseId]),
      reviewReceiptSha256,
    })
  }
  const rawAnnotations = await writeJson(artifactRoot, 'raw/annotations.json', annotations)
  const producerRef = await writeJson(artifactRoot, 'raw/producer-rows.json', producerRows)
  const pathIndexRef = await writeJson(
    artifactRoot,
    'raw/controller-path-index.json',
    controllerPathIndex,
  )
  const provenanceRef = await writeJson(artifactRoot, 'raw/provenance.json', provenance)
  const fragmentReceipt = await writeJson(artifactRoot, 'raw/fragment-receipt.json', {
    schema: 'synthetic-fragment-v1',
    rowCount: 40,
  })
  const rosterRef = await writeJson(artifactRoot, 'registry/map-roster.json', {
    schema: 'h8a-fresh-supplemental-source-roster-v2',
    seedHex: '76303308',
    hashInput:
      'UTF-8 bytes, components separated by a single NUL byte, no trailing NUL; lower-case hexadecimal digest',
    parentProtocolSha256: orderProtocolRef.sha256,
    sourceGroupByFamily: fixtureOptions.disjoint
      ? { xsok: 'game:xsok', gnurobbo: 'game:gnurobbo' }
      : { freecol: 'synthetic-map-freecol', crimson: 'synthetic-map-crimson' },
    rows: fixtureOptions.wrongMapFamily
      ? rosterRows.map((row, index) => (index === 0 ? { ...row, familySlug: 'gnurobbo' } : row))
      : rosterRows,
  })
  const sourceGroupIds = [
    ...new Set(annotations.map((row) => row.sourceGroup.replace(/\/+$/u, ''))),
  ].sort()
  const exclusionGroups = fixtureOptions.disjoint
    ? Array.from({ length: 396 }, (_, index) => `historical-source-group-${index + 1}`).sort()
    : ['synthetic-excluded-group']
  const splitRef = await writeJson(artifactRoot, 'registry/source-group-split.json', {
    schema: 'h8a-dev-source-group-split-v1',
    devSourceGroupIds: sourceGroupIds,
    qualificationSourceGroupIds: [],
    exclusionSourceGroupIds: exclusionGroups,
    devCommitmentSha256: hashIdentity(sourceGroupIds),
    qualificationCommitmentSha256: hashIdentity([]),
    exclusionCommitmentSha256: hashIdentity(exclusionGroups),
  })
  const catalogRefs = []
  for (const [slug, model, prompt, completion] of [
    ['candidate', 'openai/gpt-6-luna', '0.0000001', '0.0000005'],
    ['control', 'openai/gpt-6-luna-decisions', '0.0000001', '0'],
  ] as const) {
    const catalog = {
      data: {
        id: model,
        endpoints: [
          {
            model_id: model,
            tag: 'openai',
            context_length: 5000,
            max_prompt_tokens: 1000,
            max_completion_tokens: 4096,
            pricing: { prompt, completion, input_cache_read: '0', input_cache_write: '0' },
          },
        ],
      },
    }
    catalogRefs.push({
      model,
      rawCatalog: await writeJson(artifactRoot, `price/${slug}-catalog.json`, catalog),
    })
  }
  const priceRef = await writeJson(artifactRoot, 'price/price-proof.json', {
    schema: 'h8a-public-price-proof-v2',
    observedUtc: '2026-11-01T00:00:00.000Z',
    maxCostUsd: 10,
    maxPhysicalCalls: 2000,
    entries: [
      {
        profileId: fixtureOptions.disjoint ? 'h8a-cpu-flat-target-v2' : 'h8a-cpu-raw-target-v1',
        model: catalogRefs[0]!.model,
        rawCatalog: catalogRefs[0]!.rawCatalog,
        inputTokenBound: 1000,
        maxOutputTokens: 4096,
        inputRateUpperUsd: 0.0000005,
        outputRateUpperUsd: 0.0000015,
        computedWorstUsd: 0.01,
        maxUsdPerPhysicalDispatch: 0.01,
      },
      {
        profileId: 'v02-final-v3-fresh-cohort-replay-v1',
        model: catalogRefs[1]!.model,
        rawCatalog: catalogRefs[1]!.rawCatalog,
        inputTokenBound: 1000,
        maxOutputTokens: 0,
        inputRateUpperUsd: 0.0000001,
        outputRateUpperUsd: 0,
        computedWorstUsd: 0.0001,
        maxUsdPerPhysicalDispatch: 0.01,
      },
    ],
  })
  const nativeRecipePath = fixtureOptions.disjoint
    ? 'benchmarks/v03/h8a-full/native-recipe-flat-target-v2.json'
    : 'benchmarks/v03/h8a-full/native-recipe.json'
  const requiredClosurePaths = [
    'package-lock.json',
    'benchmarks/v03/h8a-full/factory.ts',
    'benchmarks/v03/h8a-full/native-port.ts',
    'benchmarks/v03/h8a-full/native-recipe.json',
    ...(fixtureOptions.disjoint ? [nativeRecipePath] : []),
    'benchmarks/v03/h8a-full/native-worker.py',
    'benchmarks/v03/h8a-fresh-comparison/dev-screen-runner.ts',
    'benchmarks/v03/h8a-fresh-comparison/paired-runner.ts',
    'benchmarks/v03/h8a-fresh-comparison/profiles.ts',
    'benchmarks/v03/h8a-fresh-comparison/schemas.ts',
  ]
  const closureFiles = await Promise.all(
    requiredClosurePaths
      .filter(
        (filePath) =>
          !(
            fixtureOptions.omitNativeWorkerClosure &&
            filePath === 'benchmarks/v03/h8a-full/native-worker.py'
          ),
      )
      .map(async (filePath) => {
        const bytes = Buffer.from(`synthetic closure content: ${filePath}\n`)
        const file = join(sourceRoot, ...filePath.split('/'))
        await mkdir(join(file, '..'), { recursive: true })
        await writeFile(file, bytes)
        return { path: filePath, sha256: sha256(bytes), bytes: bytes.length }
      }),
  )
  const packageLockBytes = await readFile(join(sourceRoot, 'package-lock.json'))
  const nativeRecipeBytes = await readFile(join(sourceRoot, ...nativeRecipePath.split('/')))
  const sourceClosureRef = await writeJson(artifactRoot, 'registry/source-closure.json', {
    schema: 'h8a-producer-closure-files-v1',
    sourceCommit: 'synthetic-commit',
    files: closureFiles,
  })
  const runtimeEnvironmentRef = await writeJson(artifactRoot, 'registry/runtime-environment.json', {
    schema: 'fresh-dev-pre-dispatch-runtime-inputs-v1',
    status: 'preflight-not-a-code-or-corpus-freeze',
    freshDevInferenceRequests: 0,
    recordedUtc: '2026-11-01T00:00:00.000Z',
    h8NativeRecipeFileSha256: sha256(nativeRecipeBytes),
    node: { packageLockSha256: sha256(packageLockBytes) },
    concurrency: {
      candidateTorchIntraOp: 8,
      candidateTorchInterOp: 1,
      candidateBLASOpenMP: 1,
      mobileSamOnnxCpuThreads: 2,
      maxPending: 2,
      nativeArmsActiveAtOnce: 1,
    },
    assets: Array.from({ length: 18 }, (_, index) => ({
      family: index < 9 ? 'candidate' : 'control',
      relative: `synthetic-asset-${index}`,
      bytes: 1,
      sha256: 'a'.repeat(64),
    })),
  })
  const review = {
    schema: 'h8a-dev-reviewed-fragment-v1',
    fragmentId: 'synthetic-complete-dev40',
    producerRows: producerRef,
    annotations: rawAnnotations,
    controllerPathIndex: pathIndexRef,
    provenance: provenanceRef,
    fragmentReceipt,
    referenceMasks: maskRefs,
    reviewReceipts: [
      { path: relative(artifactRoot, reviewReceiptPath), sha256: reviewReceiptSha256 },
    ],
    rows,
  }
  const reviewPath = join(artifactRoot, 'reviews/complete-fragment.json')
  await mkdir(join(artifactRoot, 'reviews'), { recursive: true })
  const reviewBytes = Buffer.from(`${JSON.stringify(review)}\n`)
  await writeFile(reviewPath, reviewBytes)
  const fragmentRef = {
    fragmentId: review.fragmentId,
    path: relative(artifactRoot, reviewPath),
    sha256: sha256(reviewBytes),
  }
  let authority: Record<string, unknown> = {
    schema: fixtureOptions.disjoint
      ? 'h8a-disjoint-dev-freeze-preparation-v1'
      : 'h8a-dev-freeze-preparation-v1',
    freezeId: fixtureOptions.disjoint
      ? 'h8a-flat-disjoint-dev40-20261101-v1'
      : 'synthetic-complete-dev40-freeze',
    deadlineIso: '2030-01-01T00:00:00.000Z',
    trustedRoot: artifactRoot,
    orderProtocol: orderProtocolRef,
    mapRoster: rosterRef,
    sourceClosure: sourceClosureRef,
    sourceGroupSplit: splitRef,
    priceProof: priceRef,
    runtimeEnvironment: runtimeEnvironmentRef,
    fragments: [fragmentRef],
  }
  let testOnlyDisjointLineagePins:
    | { parentRegistrationSha256: string; acceptedHistorySha256: string }
    | undefined
  if (fixtureOptions.disjoint) {
    const parentBytes = Buffer.from(
      `${JSON.stringify({
        schema: 'prospective-disjoint-dev40-design-v1',
        freezeId: 'h8a-flat-disjoint-dev40-20261101-v1',
        studyId: 'flat-disjoint-replication-v1',
        baseCommit: 'c3c43084bb3ad663bb7390be7717effd33788046',
        sourceSelectionSeed: 'h8a-independent-dev40-20261101-r1',
        candidate: 'h8a-cpu-flat-target-v2',
        strata: {
          photo: [16, 4],
          ui: { gnumeric: [4, 1], evince: [3, 2] },
          map: { xsok: [4, 1], gnurobbo: [3, 2] },
        },
      })}\n`,
    )
    const parentRegistrationSha256 = sha256(parentBytes)
    const historyBytes = Buffer.from(
      `${JSON.stringify({
        schema: 'h8a-closed-development-lineage-v1',
        parentRegistrationFileSha256: parentRegistrationSha256,
        historicalBindings: {},
        priorIds: Array.from({ length: 40 }, (_, index) => `prior-case-${index + 1}`),
        priorEncodedSha256: Array.from({ length: 40 }, (_, index) =>
          sha256(Buffer.from(`prior-image-${index + 1}`)),
        ),
        allExcludedSourceGroups: exclusionGroups.slice(0, 382),
        campaignLedgerBeforeRegistration: sha256(Buffer.from('test-ledger-before-registration')),
        priorCashUsd: 0.009603065,
        priorKnownConfirmed: 14,
        priorNextReservationId: 15,
        priorLogicalAttempts: 5,
        openInFlightBefore: 0,
        previousExperimentNamespace: 'experiments/h8a-flat-dev40-v1',
        newExperimentNamespace: 'experiments/flat-disjoint-replication-v1',
      })}\n`,
    )
    testOnlyDisjointLineagePins = {
      parentRegistrationSha256,
      acceptedHistorySha256: sha256(historyBytes),
    }
    const parentRegistrationPath = 'registry/parent-registration.json'
    const acceptedHistoryPath = 'registry/accepted-history.json'
    await writeFile(join(artifactRoot, parentRegistrationPath), parentBytes)
    await writeFile(join(artifactRoot, acceptedHistoryPath), historyBytes)
    const parentRegistration = {
      path: parentRegistrationPath,
      sha256: sha256(parentBytes),
    }
    const acceptedHistory = { path: acceptedHistoryPath, sha256: sha256(historyBytes) }
    assert.equal(parentRegistration.sha256, parentRegistrationSha256)
    assert.equal(acceptedHistory.sha256, sha256(historyBytes))
    const sourceEvidence = [
      parentRegistration,
      acceptedHistory,
      orderProtocolRef,
      rosterRef,
      splitRef,
      { path: fragmentRef.path, sha256: fragmentRef.sha256 },
      await writeJson(artifactRoot, 'registry/photo-source-preregistration.json', {
        schema: 'synthetic-photo-preregistration-v1',
      }),
      await writeJson(artifactRoot, 'registry/ui-source-preregistration.json', {
        schema: 'synthetic-ui-preregistration-v1',
      }),
      await writeJson(artifactRoot, 'registry/robbo-source-amendment.json', {
        schema: 'synthetic-robbo-amendment-v1',
      }),
    ]
    const registeredSources = await writeJson(artifactRoot, 'registry/registered-sources.json', {
      schema: 'h8a-disjoint-source-registration-v1',
      parentRegistrationSha256: parentRegistration.sha256,
      orderProtocolSha256: orderProtocolRef.sha256,
      mapRosterSha256: rosterRef.sha256,
      sourceGroupSplitSha256: splitRef.sha256,
      sourceEvidence,
      rows: producerRows.map((producer) => {
        const annotation = annotationById.get(producer.opaqueCaseId)!
        return {
          opaqueCaseId: producer.opaqueCaseId,
          stratum: annotation.stratum,
          sourceGroup: annotation.sourceGroup,
          expectedPresence: annotation.expectedPresence,
          sourceSha256: producer.sourceBytesSha256,
        }
      }),
    })
    authority = {
      ...authority,
      parentRegistration: parentRegistration,
      acceptedHistory,
      registeredSources,
    }
  }
  const authorityPath = join(artifactRoot, 'registry/preparation-authority.json')
  const authorityRef = await writeJson(
    artifactRoot,
    'registry/preparation-authority.json',
    authority,
  )
  const priceProofPath = join(artifactRoot, priceRef.path)
  return {
    options: {
      authorityPath,
      authoritySha256: authorityRef.sha256,
      sourceRoot,
      outputDirectory: join(root, 'freeze-output'),
      ...(testOnlyDisjointLineagePins ? { testOnlyDisjointLineagePins } : {}),
    },
    sourcePath,
    fragmentReviewPath: reviewPath,
    priceProofPath,
  }
}

await test('offline DEV freeze assembly verifies complete inputs, stable draw, and immutable output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-dev-freeze-cli-'))
  try {
    const { options, sourcePath, fragmentReviewPath, priceProofPath } =
      await makeCompleteDiskInputs(root)
    const first = await assembleDevFreezeFromDisk(options)
    const second = await assembleDevFreezeFromDisk(options)
    assert.deepEqual(first.selection, second.selection)
    assert.deepEqual(phaseFreezeSchema.parse(first.freeze), first.freeze)
    assert.equal(first.freeze.producerCases.length, 40)
    validateDevScreenSelection(first.selection, first.freeze, first.annotations)
    assert.equal(first.selection.selectionCommitmentSha256.length, 64)
    await writeDevFreezeExclusive(options.outputDirectory, first)
    await verifyPersistedDevFreeze(options.outputDirectory, options)

    const savedFreeze = await readFile(join(options.outputDirectory, 'phase-freeze.json'))
    await assert.rejects(
      writeDevFreezeExclusive(options.outputDirectory, second),
      /already exists/u,
    )
    assert.deepEqual(
      await readFile(join(options.outputDirectory, 'phase-freeze.json')),
      savedFreeze,
    )

    const badPin = { ...options, authoritySha256: '0'.repeat(64) }
    await assert.rejects(assembleDevFreezeFromDisk(badPin), /caller-supplied pin/u)

    const authorityOriginal = await readFile(options.authorityPath)
    const priceOriginal = await readFile(priceProofPath)
    const authorityForBadPrice = JSON.parse(authorityOriginal.toString('utf8')) as {
      priceProof: { path: string; sha256: string }
    }
    const priceProof = JSON.parse(priceOriginal.toString('utf8')) as {
      entries: Array<{ inputTokenBound: number; computedWorstUsd: number }>
    }
    priceProof.entries[0]!.inputTokenBound = 999
    priceProof.entries[0]!.computedWorstUsd = 0.01
    const underboundedPrice = Buffer.from(`${JSON.stringify(priceProof)}\n`)
    await writeFile(priceProofPath, underboundedPrice)
    authorityForBadPrice.priceProof.sha256 = sha256(underboundedPrice)
    const underboundedAuthority = Buffer.from(`${JSON.stringify(authorityForBadPrice)}\n`)
    await writeFile(options.authorityPath, underboundedAuthority)
    await assert.rejects(
      assembleDevFreezeFromDisk({ ...options, authoritySha256: sha256(underboundedAuthority) }),
      /understates a raw OpenAI route token limit/u,
    )
    await writeFile(priceProofPath, priceOriginal)
    await writeFile(options.authorityPath, authorityOriginal)

    const authorityBytes = await readFile(options.authorityPath)
    const reviewBytes = await readFile(fragmentReviewPath)
    const authority = JSON.parse(authorityBytes.toString('utf8')) as {
      fragments: Array<{ fragmentId: string; path: string; sha256: string }>
    }
    const review = JSON.parse(reviewBytes.toString('utf8')) as { rows: unknown[] }
    review.rows.pop()
    const changedReviewBytes = Buffer.from(`${JSON.stringify(review)}\n`)
    await writeFile(fragmentReviewPath, changedReviewBytes)
    authority.fragments[0]!.sha256 = sha256(changedReviewBytes)
    const changedAuthorityBytes = Buffer.from(`${JSON.stringify(authority)}\n`)
    await writeFile(options.authorityPath, changedAuthorityBytes)
    await assert.rejects(
      assembleDevFreezeFromDisk({ ...options, authoritySha256: sha256(changedAuthorityBytes) }),
      /row order mismatch/u,
    )
    assert.deepEqual(
      await readFile(join(options.outputDirectory, 'phase-freeze.json')),
      savedFreeze,
    )
    await writeFile(options.authorityPath, authorityBytes)
    await writeFile(fragmentReviewPath, reviewBytes)

    const bytes = await readFile(sourcePath)
    await writeFile(sourcePath, Buffer.concat([bytes, Buffer.from([0])]))
    await assert.rejects(
      verifyPersistedDevFreeze(options.outputDirectory, options),
      /Source image bytes do not match/u,
    )
    assert.deepEqual(
      await readFile(join(options.outputDirectory, 'phase-freeze.json')),
      savedFreeze,
    )

    await writeFile(sourcePath, bytes)
    const sourceDirectory = join(root, 'artifacts', 'inputs')
    const savedSourceDirectory = `${sourceDirectory}-saved`
    await rename(sourceDirectory, savedSourceDirectory)
    await symlink(savedSourceDirectory, sourceDirectory)
    await assert.rejects(
      verifyPersistedDevFreeze(options.outputDirectory, options),
      /Symlinked or aliased/u,
    )
    await rm(sourceDirectory, { recursive: true, force: true })
    await rename(savedSourceDirectory, sourceDirectory)
    assert.deepEqual(
      await readFile(join(options.outputDirectory, 'phase-freeze.json')),
      savedFreeze,
    )

    await writeFile(sourcePath, Buffer.alloc(16 * 1024 * 1024 + 1))
    await assert.rejects(
      verifyPersistedDevFreeze(options.outputDirectory, options),
      /bounded regular file/u,
    )
    await writeFile(sourcePath, bytes)
    assert.deepEqual(
      await readFile(join(options.outputDirectory, 'phase-freeze.json')),
      savedFreeze,
    )
    assert.equal(
      computePhaseFreezeCommitmentSha256(first.freeze),
      computePhaseFreezeCommitmentSha256(second.freeze),
    )

    const duplicateFixture = await makeCompleteDiskInputs(join(root, 'duplicate-inputs'), {
      duplicateFirstTwoSources: true,
    })
    await assert.rejects(
      assembleDevFreezeFromDisk(duplicateFixture.options),
      /distinct encoded source bytes/u,
    )
    await assert.rejects(access(duplicateFixture.options.outputDirectory), { code: 'ENOENT' })

    const outsideBoxFixture = await makeCompleteDiskInputs(join(root, 'outside-box'), {
      invalidFirstPositiveBox: true,
    })
    await assert.rejects(
      assembleDevFreezeFromDisk(outsideBoxFixture.options),
      /Reference box is invalid or outside source canvas/u,
    )
    await assert.rejects(access(outsideBoxFixture.options.outputDirectory), { code: 'ENOENT' })

    const maskDeclarationFixture = await makeCompleteDiskInputs(
      join(root, 'bad-mask-declaration'),
      { missingPositiveMaskMetadata: true },
    )
    await assert.rejects(
      assembleDevFreezeFromDisk(maskDeclarationFixture.options),
      /requires reference mask metadata/u,
    )
    await assert.rejects(access(maskDeclarationFixture.options.outputDirectory), { code: 'ENOENT' })

    const incompleteClosureFixture = await makeCompleteDiskInputs(
      join(root, 'incomplete-closure'),
      { omitNativeWorkerClosure: true },
    )
    await assert.rejects(
      assembleDevFreezeFromDisk(incompleteClosureFixture.options),
      /missing a required native worker/u,
    )
    await assert.rejects(access(incompleteClosureFixture.options.outputDirectory), {
      code: 'ENOENT',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('disjoint DEV freeze pins lineage, all source rows, named group quotas, and photo masks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-disjoint-dev-freeze-'))
  try {
    const valid = await makeCompleteDiskInputs(join(root, 'valid'), { disjoint: true })
    const assembled = await assembleDevFreezeFromDisk(valid.options)
    assert.equal(assembled.freeze.freezeId, 'h8a-flat-disjoint-dev40-20261101-v1')
    assert.equal(assembled.freeze.phaseId, 'h8a-flat-paired-dev40-v1')
    assert.equal(assembled.freeze.producerCases.length, 40)
    assert.equal(
      assembled.annotations.cases.filter(
        (row) => row.stratum === 'photo' && row.exactOriginalCanvasMaskRef,
      ).length,
      16,
    )
    assert.equal(assembled.freeze.profileBindings[0]?.profileId, 'h8a-cpu-flat-target-v2')
    const productionPinsRequired = { ...valid.options }
    delete productionPinsRequired.testOnlyDisjointLineagePins
    await assert.rejects(assembleDevFreezeFromDisk(productionPinsRequired))
    await assert.rejects(
      assembleDevFreezeFromDisk({
        ...valid.options,
        testOnlyDisjointLineagePins: {
          parentRegistrationSha256: 'f'.repeat(64),
          acceptedHistorySha256: valid.options.testOnlyDisjointLineagePins!.acceptedHistorySha256,
        },
      }),
    )

    const swappedGroups = await makeCompleteDiskInputs(join(root, 'swapped-groups'), {
      disjoint: true,
      wrongNamedGroupQuota: true,
    })
    await assert.rejects(
      assembleDevFreezeFromDisk(swappedGroups.options),
      /group gnumeric does not meet its registered quota/u,
    )
    await assert.rejects(access(swappedGroups.options.outputDirectory), { code: 'ENOENT' })

    const wrongFamily = await makeCompleteDiskInputs(join(root, 'wrong-map-family'), {
      disjoint: true,
      wrongMapFamily: true,
    })
    await assert.rejects(
      assembleDevFreezeFromDisk(wrongFamily.options),
      /opaque ID that does not match its registered inputs/u,
    )
    const reusedGroup = await makeCompleteDiskInputs(join(root, 'reused-history-group'), {
      disjoint: true,
      reuseHistoricalSourceGroup: true,
    })
    await assert.rejects(
      assembleDevFreezeFromDisk(reusedGroup.options),
      /conflicts with or reuses source row/u,
    )
    const missingPhotoMask = await makeCompleteDiskInputs(join(root, 'missing-photo-mask'), {
      disjoint: true,
      omitOnePhotoMask: true,
    })
    await assert.rejects(
      assembleDevFreezeFromDisk(missingPhotoMask.options),
      /exactly sixteen positive masks/u,
    )
  } finally {
    await rm(root, { recursive: true, force: false })
  }
})
