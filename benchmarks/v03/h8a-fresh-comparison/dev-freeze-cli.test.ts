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
  }
  sourcePath: string
  fragmentReviewPath: string
  priceProofPath: string
}> {
  const artifactRoot = join(root, 'artifacts')
  const sourceRoot = join(root, 'source')
  await mkdir(artifactRoot, { recursive: true })
  await mkdir(sourceRoot, { recursive: true })
  const orderProtocolBytes = await readFile(
    '/root/.codex/artifacts/zorya-classifier-mcp-20261031/fresh-comparison/main-paired-order-protocol-v1.json',
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
    const familySlug = index < 5 ? 'freecol' : 'crimson'
    const predeclaredStateId = `synthetic-state-${String(index + 1).padStart(2, '0')}`
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
  const annotations = generatedBundle.cases.map((row) => {
    const opaqueCaseId = idReplacement.get(row.opaqueCaseId) ?? row.opaqueCaseId
    const family = mapIdToFamily.get(opaqueCaseId)
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
    sourceGroupByFamily: { freecol: 'synthetic-map-freecol', crimson: 'synthetic-map-crimson' },
    rows: rosterRows,
  })
  const sourceGroupIds = [
    ...new Set(annotations.map((row) => row.sourceGroup.replace(/\/+$/u, ''))),
  ].sort()
  const exclusionGroups = ['synthetic-excluded-group']
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
        profileId: 'h8a-cpu-raw-target-v1',
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
  const requiredClosurePaths = [
    'package-lock.json',
    'benchmarks/v03/h8a-full/factory.ts',
    'benchmarks/v03/h8a-full/native-port.ts',
    'benchmarks/v03/h8a-full/native-recipe.json',
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
  const nativeRecipeBytes = await readFile(
    join(sourceRoot, 'benchmarks', 'v03', 'h8a-full', 'native-recipe.json'),
  )
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
  const maskRefs: { path: string; sha256: string }[] = []
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
  const authority = {
    schema: 'h8a-dev-freeze-preparation-v1',
    freezeId: 'synthetic-complete-dev40-freeze',
    deadlineIso: '2030-01-01T00:00:00.000Z',
    trustedRoot: artifactRoot,
    orderProtocol: orderProtocolRef,
    mapRoster: rosterRef,
    sourceClosure: sourceClosureRef,
    sourceGroupSplit: splitRef,
    priceProof: priceRef,
    runtimeEnvironment: runtimeEnvironmentRef,
    fragments: [
      {
        fragmentId: review.fragmentId,
        path: relative(artifactRoot, reviewPath),
        sha256: sha256(reviewBytes),
      },
    ],
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
