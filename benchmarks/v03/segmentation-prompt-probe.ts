import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InferenceSession, Tensor } from 'onnxruntime-node'

type Rect = { left: number; top: number; width: number; height: number }
type CaseInput = {
  caseId: string
  image: { path: string; sha256: string; width: number; height: number }
  locate: { target: string }
}
type SeedResult = {
  caseId: string
  extraction: { seed?: { region?: Rect }; status?: string }
}
type ProbeCase = CaseInput & { seed: Rect }
type ProfileId = 'point-seed' | 'seed-plus-box'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const moduleAnchor = '/root/work/zorya-classifier/node_modules/package.json'
const requireFromInstalledWorkspace = createRequire(moduleAnchor)
const sharp = requireFromInstalledWorkspace('sharp') as typeof import('sharp')
const ort = requireFromInstalledWorkspace('onnxruntime-node') as typeof import('onnxruntime-node')

export const probePaths = {
  imageRoot:
    '/root/work/zorya-classifier-worktrees/v02/independent-oracle-proof/.run/oracle-proof/combined-corpus-v1/imageRoot',
  inputManifest:
    '/root/work/zorya-classifier-worktrees/v02/independent-oracle-proof/.run/oracle-proof/combined-corpus-v1/photo-inputs.json',
  truthManifest:
    '/root/work/zorya-classifier-worktrees/v02/independent-oracle-proof/.run/oracle-proof/combined-corpus-v1/photoTruth.json',
  v3Summary:
    '/root/work/zorya-classifier-worktrees/v02/region-dev-v3/.run/v02/region-seeded-heldout-v3-candidate/v02-region-seeded-heldout-2026-10-21T040905835Z-a0c8de8b/summary.json',
  encoder:
    '/root/work/zorya-worktrees/locator-segmentation-model/.run/segmentation-model/models/mobile_sam_image_encoder.onnx',
  decoder:
    '/root/work/zorya-worktrees/locator-segmentation-model/.run/segmentation-model/models/sam_mask_decoder_multi.onnx',
  output: resolve(repoRoot, '.run/v03/segmentation-prompt-probe-v1'),
}

export const selectedCaseIds = [
  'photo-heldout-present-01',
  'photo-heldout-present-02',
  'photo-heldout-present-04',
  'photo-heldout-present-16',
  'photo-heldout-present-18',
] as const

export const expansionFactor = 3
export const expectedEncoder = {
  bytes: 28_157_093,
  sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
} as const
export const expectedDecoder = {
  bytes: 16_496_559,
  sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
} as const

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function inside(rect: Rect, x: number, y: number): boolean {
  return x >= rect.left && y >= rect.top && x < rect.left + rect.width && y < rect.top + rect.height
}

export function seedCenteredBox(seed: Rect, imageWidth: number, imageHeight: number): Rect {
  const centerX = seed.left + seed.width / 2
  const centerY = seed.top + seed.height / 2
  const requestedWidth = seed.width * expansionFactor
  const requestedHeight = seed.height * expansionFactor
  const left = Math.max(0, Math.floor(centerX - requestedWidth / 2))
  const top = Math.max(0, Math.floor(centerY - requestedHeight / 2))
  const right = Math.min(imageWidth, left + requestedWidth)
  const bottom = Math.min(imageHeight, top + requestedHeight)
  assert(right > left && bottom > top, 'Derived seed box is empty')
  assert(
    left <= seed.left &&
      top <= seed.top &&
      right >= seed.left + seed.width &&
      bottom >= seed.top + seed.height,
    'Clipped seed box failed to contain its seed cell',
  )
  return { left, top, width: right - left, height: bottom - top }
}

export function promptTensors(
  profile: ProfileId,
  seed: Rect,
  width: number,
  height: number,
): { coordinates: Float32Array; labels: Float32Array; box: Rect | null } {
  const centerX = seed.left + (seed.width - 1) / 2
  const centerY = seed.top + (seed.height - 1) / 2
  const coordinates: number[] = [centerX, centerY]
  const labels = [1]
  let box: Rect | null = null
  if (profile === 'point-seed') {
    // Match the existing prompt encoder exactly, including SAM's -1 padding point.
    coordinates.push(centerX, centerY)
    labels.push(-1)
  } else {
    box = seedCenteredBox(seed, width, height)
    coordinates.push(box.left, box.top, box.left + box.width, box.top + box.height)
    labels.push(2, 3)
  }
  return { coordinates: Float32Array.from(coordinates), labels: Float32Array.from(labels), box }
}

export function masksFromLogits(input: {
  rgba: Uint8Array
  logits: Float32Array
  scores: Float32Array
  width: number
  height: number
  roi: Rect
  seed: Rect
}): { masks: Uint8Array[]; hits: boolean[]; scores: number[]; nativeIndex: number | null } {
  const pixels = input.width * input.height
  assert(input.rgba.length === pixels * 4, 'RGBA dimensions are invalid')
  assert(input.logits.length === pixels * 4, 'Expected four full-resolution decoder masks')
  assert(input.scores.length === 4, 'Expected four decoder quality diagnostics')
  const masks: Uint8Array[] = []
  const hits: boolean[] = []
  const scores: number[] = []
  let nativeIndex: number | null = null
  for (let candidate = 0; candidate < 4; candidate++) {
    const mask = new Uint8Array(pixels)
    let hit = false
    const score = input.scores[candidate]
    assert(score !== undefined && Number.isFinite(score), 'Non-finite decoder diagnostic')
    for (let index = 0; index < pixels; index++) {
      const logit = input.logits[candidate * pixels + index]
      assert(logit !== undefined && Number.isFinite(logit), 'Non-finite mask logit')
      if (logit <= 0 || input.rgba[index * 4 + 3] === 0) continue
      const x = index % input.width
      const y = Math.floor(index / input.width)
      if (!inside(input.roi, x, y)) continue
      mask[index] = 1
      if (inside(input.seed, x, y)) hit = true
    }
    masks.push(mask)
    hits.push(hit)
    scores.push(score)
    if (
      hit &&
      (nativeIndex === null ||
        score > scores[nativeIndex] ||
        (score === scores[nativeIndex] && candidate < nativeIndex))
    )
      nativeIndex = candidate
  }
  return { masks, hits, scores, nativeIndex }
}

async function loadPlan() {
  const [inputBytes, summaryBytes, encoder, decoder, sourceBytes] = await Promise.all([
    readFile(probePaths.inputManifest),
    readFile(probePaths.v3Summary),
    readFile(probePaths.encoder),
    readFile(probePaths.decoder),
    readFile(fileURLToPath(import.meta.url)),
  ])
  assert(
    sha256(inputBytes) === 'ce0d7af70cace50fbee83d3cc21cc83fa4c213759f49758ba53397509660906c',
    'Input manifest changed',
  )
  assert(
    sha256(summaryBytes) === 'f1f99c77057a47a350e80c98ebdde91f74d161fbcabbd0b5917a6113b32e4a1d',
    'v3 summary changed',
  )
  assert(
    sha256(encoder) === expectedEncoder.sha256 && encoder.length === expectedEncoder.bytes,
    'Encoder pin mismatch',
  )
  assert(
    sha256(decoder) === expectedDecoder.sha256 && decoder.length === expectedDecoder.bytes,
    'Decoder pin mismatch',
  )
  const items = JSON.parse(inputBytes.toString('utf8')) as CaseInput[]
  const summary = JSON.parse(summaryBytes.toString('utf8')) as { results: SeedResult[] }
  const inputById = new Map(items.map((item) => [item.caseId, item]))
  const resultById = new Map(summary.results.map((item) => [item.caseId, item]))
  const cases: Array<ProbeCase & { frozenPrompts: Record<ProfileId, unknown> }> = []
  const images: Array<{ caseId: string; sha256: string; width: number; height: number }> = []
  for (const caseId of selectedCaseIds) {
    const input = inputById.get(caseId)
    const result = resultById.get(caseId)
    const seed = result?.extraction.seed?.region
    assert(input && seed, `Missing frozen input or actual v3 seed: ${caseId}`)
    assert(input.image.width > 0 && input.image.height > 0, `Invalid raster dimensions: ${caseId}`)
    const imageBytes = await readFile(resolve(probePaths.imageRoot, input.image.path))
    assert(sha256(imageBytes) === input.image.sha256, `Source image changed: ${caseId}`)
    images.push({
      caseId,
      sha256: input.image.sha256,
      width: input.image.width,
      height: input.image.height,
    })
    const pointPrompt = promptTensors('point-seed', seed, input.image.width, input.image.height)
    const boxPrompt = promptTensors('seed-plus-box', seed, input.image.width, input.image.height)
    cases.push({
      ...input,
      seed,
      frozenPrompts: {
        'point-seed': {
          sourceCoordinates: [...pointPrompt.coordinates],
          labels: [...pointPrompt.labels],
          box: null,
        },
        'seed-plus-box': {
          sourceCoordinates: [...boxPrompt.coordinates],
          labels: [...boxPrompt.labels],
          box: boxPrompt.box,
        },
      },
    })
  }
  return {
    scriptSha256: sha256(sourceBytes),
    manifests: {
      photoInputsSha256: sha256(inputBytes),
      v3SummarySha256: sha256(summaryBytes),
    },
    assets: {
      encoder: { bytes: encoder.length, sha256: sha256(encoder) },
      decoder: { bytes: decoder.length, sha256: sha256(decoder) },
    },
    execution: {
      runtime: process.version,
      platform: process.platform,
      executionProvider: 'cpu',
      intraOpNumThreads: 2,
      interOpNumThreads: 1,
      maxActiveImages: 1,
      maxCases: 5,
      decoderCalls: 10,
    },
    profiles: ['point-seed', 'seed-plus-box'],
    expansionFactor,
    selectedCaseIds,
    cases,
    images,
  }
}

async function prepare(): Promise<void> {
  const plan = await loadPlan()
  const path = resolve(probePaths.output, 'freeze.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(
    `${JSON.stringify({ status: 'frozen', path, scriptSha256: plan.scriptSha256, cases: plan.selectedCaseIds })}\n`,
  )
}

type FrozenPlan = Awaited<ReturnType<typeof loadPlan>>

async function sourceRaster(input: ProbeCase): Promise<{
  rgba: Buffer
  width: number
  height: number
}> {
  const bytes = await readFile(resolve(probePaths.imageRoot, input.image.path))
  assert(sha256(bytes) === input.image.sha256, `Source image changed after freeze: ${input.caseId}`)
  const pipeline = sharp(bytes, { limitInputPixels: 1_048_576, failOn: 'error' })
  try {
    const decoded = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    assert(
      decoded.info.width === input.image.width && decoded.info.height === input.image.height,
      `Image dimensions changed: ${input.caseId}`,
    )
    assert(decoded.info.channels === 4, `Expected RGBA source: ${input.caseId}`)
    return { rgba: decoded.data, width: decoded.info.width, height: decoded.info.height }
  } finally {
    pipeline.destroy()
    bytes.fill(0)
  }
}

async function verifyFreeze(): Promise<FrozenPlan> {
  const path = resolve(probePaths.output, 'freeze.json')
  const frozenBytes = await readFile(path)
  const frozen = JSON.parse(frozenBytes.toString('utf8')) as FrozenPlan
  const current = await loadPlan()
  assert(
    JSON.stringify(current) === JSON.stringify(frozen),
    'Inputs, source, assets or execution plan changed after freeze',
  )
  return frozen
}

async function run(): Promise<void> {
  const frozen = await verifyFreeze()
  const sessions = await Promise.all([
    ort.InferenceSession.create(probePaths.encoder, {
      executionProviders: ['cpu'],
      intraOpNumThreads: 2,
      interOpNumThreads: 1,
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
    }),
    ort.InferenceSession.create(probePaths.decoder, {
      executionProviders: ['cpu'],
      intraOpNumThreads: 2,
      interOpNumThreads: 1,
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
    }),
  ])
  const [encoder, decoder] = sessions
  const summary = {
    schema: 'v03-segmentation-prompt-probe-v1',
    freezeSha256: sha256(await readFile(resolve(probePaths.output, 'freeze.json'))),
    status: 'complete',
    physicalProviderHttpCalls: 0,
    nativeEncoderRuns: 5,
    nativeDecoderRuns: 10,
    cases: [] as unknown[],
  }
  try {
    for (const input of frozen.cases) {
      const raster = await sourceRaster(input)
      try {
        const caseReport = {
          caseId: input.caseId,
          imageSha256: input.image.sha256,
          dimensions: { width: input.image.width, height: input.image.height },
          seed: input.seed,
          profiles: [] as unknown[],
        }
        const encodedBytes = await sharp(raster.rgba, {
          raw: { width: raster.width, height: raster.height, channels: 4 },
        })
          .removeAlpha()
          .resize(
            Math.round((raster.width * 1024) / Math.max(raster.width, raster.height)),
            Math.round((raster.height * 1024) / Math.max(raster.width, raster.height)),
            { fit: 'fill', kernel: 'linear' },
          )
          .raw()
          .toBuffer()
        const encodedTensor = new ort.Tensor('float32', Float32Array.from(encodedBytes), [
          Math.round((raster.height * 1024) / Math.max(raster.width, raster.height)),
          Math.round((raster.width * 1024) / Math.max(raster.width, raster.height)),
          3,
        ])
        let embedding: Tensor | undefined
        try {
          const encoded = await encoder.run({ input_image: encodedTensor })
          assert(encoded.image_embeddings instanceof ort.Tensor, 'Encoder omitted embedding tensor')
          embedding = encoded.image_embeddings
          for (const profile of frozen.profiles) {
            const result = await inferProfileFromEmbedding(
              input,
              raster.rgba,
              embedding,
              decoder,
              profile as ProfileId,
            )
            const maskFile = `${input.caseId}.${profile}.mask-u8`
            const maskPath = resolve(probePaths.output, maskFile)
            const plane = Buffer.concat(result.masks.map((mask) => Buffer.from(mask)))
            await writeFile(maskPath, plane, { flag: 'wx' })
            caseReport.profiles.push({
              profile,
              maskFile,
              maskSha256: sha256(plane),
              bytes: plane.length,
              candidateCount: result.masks.length,
              seedHits: result.hits,
              qualityDiagnostics: result.scores,
              nativeChosenIndex: result.nativeIndex,
              prompt: {
                box: result.box,
                labels: result.labels,
                sourceCoordinates: result.sourceCoordinates,
              },
            })
            plane.fill(0)
            for (const mask of result.masks) mask.fill(0)
          }
        } finally {
          embedding?.dispose()
          encodedTensor.dispose()
          encodedBytes.fill(0)
        }
        summary.cases.push(caseReport)
      } finally {
        raster.rgba.fill(0)
      }
    }
  } catch (error) {
    summary.status = 'failed'
    await writeFile(
      resolve(probePaths.output, 'failed.json'),
      `${JSON.stringify({ ...summary, error: error instanceof Error ? error.message : 'Unknown inference failure' }, null, 2)}\n`,
      { flag: 'wx' },
    )
    throw error
  } finally {
    await Promise.all([encoder.release(), decoder.release()])
  }
  await writeFile(
    resolve(probePaths.output, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    { flag: 'wx' },
  )
  process.stdout.write(
    `${JSON.stringify({
      status: summary.status,
      cases: summary.cases.length,
      physicalProviderHttpCalls: summary.physicalProviderHttpCalls,
      nativeEncoderRuns: summary.nativeEncoderRuns,
      nativeDecoderRuns: summary.nativeDecoderRuns,
    })}\n`,
  )
}

async function inferProfileFromEmbedding(
  input: ProbeCase,
  rgba: Buffer,
  embedding: Tensor,
  decoder: InferenceSession,
  profile: ProfileId,
) {
  const prompt = promptTensors(profile, input.seed, input.image.width, input.image.height)
  const scale = 1024 / Math.max(input.image.width, input.image.height)
  const resizedWidth = Math.round(input.image.width * scale)
  const resizedHeight = Math.round(input.image.height * scale)
  const coordinates = Float32Array.from(
    prompt.coordinates,
    (value, index) =>
      value *
      (index % 2 === 0 ? resizedWidth / input.image.width : resizedHeight / input.image.height),
  )
  const decoded = await decoder.run({
    image_embeddings: embedding,
    point_coords: new ort.Tensor('float32', coordinates, [1, prompt.labels.length, 2]),
    point_labels: new ort.Tensor('float32', prompt.labels, [1, prompt.labels.length]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', Float32Array.of(0), [1]),
    orig_im_size: new ort.Tensor(
      'float32',
      Float32Array.of(input.image.height, input.image.width),
      [2],
    ),
  })
  const maskTensor = decoded.masks
  const scoreTensor = decoded.iou_predictions
  assert(
    maskTensor instanceof ort.Tensor &&
      maskTensor.type === 'float32' &&
      maskTensor.data instanceof Float32Array,
    'Unexpected decoder masks',
  )
  assert(
    JSON.stringify(maskTensor.dims) ===
      JSON.stringify([1, 4, input.image.height, input.image.width]),
    'Decoder mask dimensions differ',
  )
  assert(
    scoreTensor instanceof ort.Tensor &&
      scoreTensor.type === 'float32' &&
      scoreTensor.data instanceof Float32Array,
    'Unexpected decoder scores',
  )
  assert(
    JSON.stringify(scoreTensor.dims) === JSON.stringify([1, 4]),
    'Decoder score dimensions differ',
  )
  const result = masksFromLogits({
    rgba,
    logits: maskTensor.data,
    scores: scoreTensor.data,
    width: input.image.width,
    height: input.image.height,
    roi: { left: 0, top: 0, width: input.image.width, height: input.image.height },
    seed: input.seed,
  })
  return {
    ...result,
    box: prompt.box,
    labels: [...prompt.labels],
    sourceCoordinates: [...prompt.coordinates],
  }
}

async function evaluate(): Promise<void> {
  const frozen = await verifyFreeze()
  const raw = JSON.parse(await readFile(resolve(probePaths.output, 'summary.json'), 'utf8')) as {
    freezeSha256: string
    cases: Array<{
      caseId: string
      imageSha256: string
      dimensions: { width: number; height: number }
      seed: Rect
      profiles: Array<{
        profile: ProfileId
        maskFile: string
        maskSha256: string
        nativeChosenIndex: number | null
        seedHits: boolean[]
      }>
    }>
  }
  assert(
    raw.freezeSha256 === sha256(await readFile(resolve(probePaths.output, 'freeze.json'))),
    'Result belongs to a different freeze',
  )
  const truthBytes = await readFile(probePaths.truthManifest)
  const truth = JSON.parse(truthBytes.toString('utf8')) as unknown
  const truthRows = Array.isArray(truth) ? truth : (truth as { cases?: unknown[] }).cases
  assert(Array.isArray(truthRows), 'Unexpected exposed truth format')
  const truthById = new Map(
    (truthRows as Array<Record<string, unknown>>).map((row) => [String(row.caseId ?? row.id), row]),
  )
  const report = [] as unknown[]
  for (const result of raw.cases) {
    const input = frozen.cases.find((candidate) => candidate.caseId === result.caseId)
    const row = truthById.get(result.caseId)
    assert(input && row, `Missing case input/truth: ${result.caseId}`)
    const reference = await loadReferenceMask(
      row,
      result.dimensions.width,
      result.dimensions.height,
    )
    try {
      for (const profile of result.profiles) {
        const maskBytes = await readFile(resolve(probePaths.output, profile.maskFile))
        assert(
          sha256(maskBytes) === profile.maskSha256,
          `Candidate masks changed: ${result.caseId}/${profile.profile}`,
        )
        const planeBytes = result.dimensions.width * result.dimensions.height
        assert(
          maskBytes.length === planeBytes * 4,
          `Candidate mask length mismatch: ${result.caseId}/${profile.profile}`,
        )
        const candidates = Array.from({ length: 4 }, (_, index) =>
          maskBytes.subarray(index * planeBytes, (index + 1) * planeBytes),
        )
        const metrics = candidates.map((candidate) => maskMetrics(candidate, reference.mask))
        const derivedBoxes = candidates.map((candidate) =>
          tightBox(candidate, result.dimensions.width, result.dimensions.height),
        )
        const referenceBox = tightBox(
          reference.mask,
          result.dimensions.width,
          result.dimensions.height,
        )
        const nativeIndex = profile.nativeChosenIndex
        const bestIndex = metrics.reduce(
          (best, current, index, all) => (current.iou > all[best]!.iou ? index : best),
          0,
        )
        const nativeMaskMetrics =
          nativeIndex === null
            ? maskMetrics(new Uint8Array(planeBytes), reference.mask)
            : metrics[nativeIndex]!
        const nativeBoxMetrics =
          nativeIndex === null
            ? { iou: 0, referenceCoverage: 0 }
            : boxMetrics(derivedBoxes[nativeIndex] ?? null, referenceBox)
        const bestBoxMetrics = boxMetrics(derivedBoxes[bestIndex] ?? null, referenceBox)
        report.push({
          caseId: result.caseId,
          profile: profile.profile,
          seedHit: profile.nativeChosenIndex !== null,
          candidateCount: candidates.length,
          nativeChosenIndex: nativeIndex,
          nativeChosen: {
            ...nativeMaskMetrics,
            boxIoU: nativeBoxMetrics.iou,
            boxCoverage: nativeBoxMetrics.referenceCoverage,
          },
          oracleBestIndex: bestIndex,
          oracleBestDiagnostic: {
            ...metrics[bestIndex]!,
            boxIoU: bestBoxMetrics.iou,
            boxCoverage: bestBoxMetrics.referenceCoverage,
          },
          maskCandidates: metrics,
        })
        maskBytes.fill(0)
      }
    } finally {
      reference.mask.fill(0)
      reference.sourceBytes.fill(0)
    }
  }
  const output = {
    schema: 'v03-segmentation-prompt-probe-evaluation-v1',
    freezeSha256: raw.freezeSha256,
    truthManifestSha256: sha256(truthBytes),
    aggregate: aggregateProfiles(report),
    cases: report,
  }
  await writeFile(
    resolve(probePaths.output, 'evaluation.json'),
    `${JSON.stringify(output, null, 2)}\n`,
    { flag: 'wx' },
  )
  process.stdout.write(
    `${JSON.stringify({ status: 'evaluated', rows: report.length, truthManifestSha256: output.truthManifestSha256 })}\n`,
  )
}

async function loadReferenceMask(row: Record<string, unknown>, width: number, height: number) {
  const candidates = [row.maskPath, row.referenceMaskPath, row.mask, row.instances]
  const pathValue = candidates.find((value) => typeof value === 'string')
  assert(
    typeof pathValue === 'string',
    `No reference mask file path for ${String(row.caseId ?? row.id)}`,
  )
  const path = resolve(dirname(probePaths.truthManifest), pathValue)
  const sourceBytes = await readFile(path)
  if (typeof row.maskSha256 === 'string')
    assert(sha256(sourceBytes) === row.maskSha256, 'Reference mask hash mismatch')
  const decoded = await sharp(sourceBytes, { limitInputPixels: 1_048_576, failOn: 'error' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  assert(
    decoded.info.width === width && decoded.info.height === height,
    'Reference mask canvas differs',
  )
  const mask = new Uint8Array(decoded.data.length)
  for (let index = 0; index < mask.length; index++) {
    const value = decoded.data[index]
    assert(value !== undefined && (value === 0 || value === 255), 'Reference mask must be binary')
    mask[index] = value === 255 ? 1 : 0
  }
  return { mask, sourceBytes }
}

function maskMetrics(predicted: Uint8Array, reference: Uint8Array) {
  assert(predicted.length === reference.length, 'Mask canvas lengths differ')
  let intersection = 0
  let union = 0
  let referencePixels = 0
  for (let index = 0; index < predicted.length; index++) {
    const a = predicted[index] === 1
    const b = reference[index] === 1
    if (a && b) intersection++
    if (a || b) union++
    if (b) referencePixels++
  }
  return {
    iou: union > 0 ? intersection / union : 1,
    referenceCoverage: referencePixels > 0 ? intersection / referencePixels : 1,
    intersection,
    union,
    referencePixels,
  }
}

function tightBox(mask: Uint8Array, width: number, height: number): Rect | null {
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (mask[y * width + x] === 1) {
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
  return right < left ? null : { left, top, width: right - left + 1, height: bottom - top + 1 }
}

function boxMetrics(a: Rect | null, b: Rect | null): { iou: number; referenceCoverage: number } {
  if (!a || !b) return { iou: 0, referenceCoverage: 0 }
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.left + a.width, b.left + b.width)
  const bottom = Math.min(a.top + a.height, b.top + b.height)
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
  const union = a.width * a.height + b.width * b.height - intersection
  return {
    iou: union > 0 ? intersection / union : 0,
    referenceCoverage: b.width * b.height > 0 ? intersection / (b.width * b.height) : 0,
  }
}

function aggregateProfiles(rows: unknown[]) {
  const values = rows as Array<{
    profile: ProfileId
    nativeChosen: { iou: number; referenceCoverage: number; boxIoU: number; boxCoverage: number }
    oracleBestDiagnostic: {
      iou: number
      referenceCoverage: number
      boxIoU: number
      boxCoverage: number
    }
  }>
  return (['point-seed', 'seed-plus-box'] as const).map((profile) => {
    const selected = values.filter((row) => row.profile === profile)
    const mean = (items: number[]) => items.reduce((sum, value) => sum + value, 0) / items.length
    return {
      profile,
      caseCount: selected.length,
      nativeChosen: {
        meanMaskIoU: mean(selected.map((row) => row.nativeChosen.iou)),
        meanMaskCoverage: mean(selected.map((row) => row.nativeChosen.referenceCoverage)),
        meanBoxIoU: mean(selected.map((row) => row.nativeChosen.boxIoU)),
        meanBoxCoverage: mean(selected.map((row) => row.nativeChosen.boxCoverage)),
      },
      oracleBestDiagnostic: {
        meanMaskIoU: mean(selected.map((row) => row.oracleBestDiagnostic.iou)),
        meanMaskCoverage: mean(selected.map((row) => row.oracleBestDiagnostic.referenceCoverage)),
        meanBoxIoU: mean(selected.map((row) => row.oracleBestDiagnostic.boxIoU)),
        meanBoxCoverage: mean(selected.map((row) => row.oracleBestDiagnostic.boxCoverage)),
      },
    }
  })
}

async function main() {
  const mode = process.argv[2]
  if (mode === '--prepare') return prepare()
  if (mode === '--run') return run()
  if (mode === '--evaluate') return evaluate()
  throw new Error('Use --prepare, --run, or --evaluate')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Prompt probe failed'}\n`)
    process.exitCode = 1
  })
}
