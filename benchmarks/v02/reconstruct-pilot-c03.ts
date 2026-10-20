import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import type {
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  PixelRect,
} from '../../src/entities/contracts.js'
import { ClassifierError } from '../../src/entities/errors.js'
import { createMobileSamObjectProposals } from '../../src/infrastructure/segmentation/mobile-sam/index.js'
import { createSharpRaster, readCanonicalPixels } from '../../src/infrastructure/raster.js'
import { unpackBinaryMask } from '../../src/features/segmentation/packed-mask.js'
import { freshProducerTask, loadFreshCorpus, loadFreshImage } from './fresh-corpus.js'
import { hashCanonical } from './protocol.js'

const inputPath = resolve('benchmarks/v02/corpus/dev/inputs.json')
const inputSha256 = '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a'
const imageRoot = '/root/work/zorya-classifier-worktrees/v02/corpus'
const targetCaseId = 'photo-dev-present-01'
const encoderPath =
  '/root/work/zorya-worktrees/locator-segmentation-model/.run/segmentation-model/models/mobile_sam_image_encoder.onnx'
const decoderPath =
  '/root/work/zorya-worktrees/locator-segmentation-model/.run/segmentation-model/models/sam_mask_decoder_multi.onnx'

const recordedSeedAnswers = [
  { top: ['P06', 'P10', 'P07', 'P11'], presence: 1 },
  { top: ['C027', 'C035', 'C043', 'C034'], presence: 1 },
  { top: ['B'], presence: 0.99 },
] as const

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function replaySeedDecision(call: number, request: DecisionRequest): DecisionResult {
  const record = recordedSeedAnswers[call]
  if (!record)
    throw new ClassifierError('INVALID_RESPONSE', 'Seed replay issued an unexpected extra call')
  const selection = request.questions.selection
  const presence = request.questions.presence
  if (selection?.type !== 'choice' || presence?.type !== 'noul')
    throw new ClassifierError(
      'INVALID_RESPONSE',
      'Seed replay request shape differed from the recorded protocol',
    )
  const requiredRankLength = selection.rankingSize ?? 4
  if (record.top.length !== Math.min(requiredRankLength, Object.keys(selection.criteria).length))
    throw new ClassifierError(
      'INVALID_RESPONSE',
      'Recorded seed ranking length does not match request',
    )
  if (record.top.some((id) => !Object.hasOwn(selection.criteria, id)))
    throw new ClassifierError('INVALID_RESPONSE', 'Recorded seed ranking contains an unknown label')
  return {
    answers: {
      selection: { type: 'ranked-choice', ranking: [...record.top] },
      presence: { type: 'noul', noul: record.presence },
    },
    metadata: {
      model: null,
      provider: null,
      requestId: null,
      durationMs: 0,
      costUsd: null,
      attempts: 1,
    },
  }
}

async function reconstruct(outputPath: string) {
  const signal = new AbortController().signal
  const corpus = await loadFreshCorpus(
    { manifests: [{ path: inputPath, sha256: inputSha256 }], imageRoot },
    signal,
  )
  const item = corpus.cases.find((candidate) => candidate.caseId === targetCaseId)
  if (!item) throw new ClassifierError('INVALID_INPUT', 'Pinned exposed photo was missing')
  const bytes = await loadFreshImage(item, corpus.imageRoot, signal)
  const task = freshProducerTask(item)
  const raster = createSharpRaster()
  let call = 0
  const replayPort: DecisionPort = {
    async decide(request) {
      replayRequests.push(structuredClone(request))
      const result = replaySeedDecision(call, request)
      call++
      return result
    },
  }
  let proposalPort: Awaited<ReturnType<typeof createMobileSamObjectProposals>> | undefined
  let rgba: Uint8Array | undefined
  let maskData: Uint8Array | undefined
  let pngBytes: Uint8Array | undefined
  let previewBytes: Uint8Array | undefined
  try {
    const image = await raster.normalize(bytes, signal)
    const seedResult = await (
      await import('../../src/processes/locate.js')
    ).locateInput(
      {
        image: bytes,
        target: task.instruction ? `${task.target}\n${task.instruction}` : task.target,
        exclusions: [],
      },
      replayPort,
      raster,
      signal,
    )
    if (call !== 3 || seedResult.status !== 'located')
      throw new ClassifierError(
        'INVALID_RESPONSE',
        'Recorded seed replay did not produce the final B region',
      )
    const seed: PixelRect = { ...seedResult.region }
    const source = await readCanonicalPixels(image, signal)
    rgba = source.data
    proposalPort = await createMobileSamObjectProposals({
      encoderPath,
      decoderPath,
      executionProvider: 'cpu',
      threads: 2,
    })
    const proposalBatch = await proposalPort.propose({
      image: { data: rgba, width: source.width, height: source.height, format: 'rgba8' },
      seedRegion: seed,
      roi: { left: 0, top: 0, width: source.width, height: source.height },
      signal,
    })
    const selected = proposalBatch.proposals.find((candidate) => candidate.id === 'C03')
    if (!selected)
      throw new ClassifierError('INVALID_RESPONSE', 'Pinned proposal batch omitted C03')
    const unpacked = unpackBinaryMask(selected.mask)
    const derived = new Uint8Array(unpacked.length)
    let left = source.width
    let top = source.height
    let right = -1
    let bottom = -1
    let intersectsSeed = false
    let touchesHardRoi = false
    for (let i = 0; i < unpacked.length; i++) {
      if (unpacked[i] !== 1 || source.data[i * 4 + 3] === 0) continue
      derived[i] = 1
      const x = i % source.width
      const y = Math.floor(i / source.width)
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
      if (
        x >= seed.left &&
        x < seed.left + seed.width &&
        y >= seed.top &&
        y < seed.top + seed.height
      )
        intersectsSeed = true
      if (x === 0 || x === source.width - 1 || y === 0 || y === source.height - 1)
        touchesHardRoi = true
    }
    if (right < left || bottom < top)
      throw new ClassifierError('INVALID_RESPONSE', 'C03 has no visible source pixels')
    maskData = derived
    const pngBuffer = await sharp(maskData, {
      raw: { width: source.width, height: source.height, channels: 1 },
    })
      .png()
      .toBuffer()
    pngBytes = new Uint8Array(pngBuffer)
    const preview = new Uint8Array(maskData.length)
    for (let i = 0; i < maskData.length; i++) preview[i] = maskData[i] === 1 ? 255 : 0
    previewBytes = new Uint8Array(
      await sharp(preview, {
        raw: { width: source.width, height: source.height, channels: 1 },
      })
        .png()
        .toBuffer(),
    )
    await mkdir(outputPath, { recursive: false })
    await writeFile(join(outputPath, 'mask.u8'), maskData, { flag: 'wx' })
    await writeFile(join(outputPath, 'mask.png'), pngBytes, { flag: 'wx' })
    await writeFile(join(outputPath, 'mask-preview.png'), previewBytes, { flag: 'wx' })
    const summary = {
      purpose:
        'offline reconstruction of the recorded exposed DEV final seed B and top-ranked MobileSAM proposal C03; no provider request and no truth read',
      phase: 'dev-offline-diagnostic',
      sourceCaseId: targetCaseId,
      sourceImageSha256: item.image.sha256,
      sourceDimensions: { width: source.width, height: source.height },
      inputManifestSha256: corpus.manifests[0]?.sha256,
      seedReplay: {
        recordedChoiceRankings: recordedSeedAnswers.map((entry) => [...entry.top]),
        recordedNoulValues: recordedSeedAnswers.map((entry) => entry.presence),
        requestSha256: replayRequests.map((request) => hashCanonical(request)),
        decisionCalls: call,
        selectedSeedRegion: seed,
      },
      proposal: {
        method: proposalBatch.metadata.method,
        backend: proposalBatch.metadata.backend,
        durationMs: proposalBatch.metadata.durationMs,
        input: proposalBatch.metadata.input,
        candidateCount: proposalBatch.proposals.length,
        selectedAliasTopRanked: selected.id,
        packedMaskSha256: sha256(selected.mask.data),
      },
      derivedMask: {
        file: 'mask.u8',
        sha256: sha256(maskData),
        bytes: maskData.byteLength,
        format: 'binary-u8 row-major full-source mask, transparency cleared',
        maskPng: 'mask.png',
        maskPngSha256: sha256(pngBytes),
        visibilityPreview: 'mask-preview.png',
        visibilityPreviewSha256: sha256(previewBytes),
        sourceRegion: { left, top, width: right - left + 1, height: bottom - top + 1 },
        intersectsSeed,
        touchesHardRoi,
      },
      runtime: {
        node: process.version,
        noProviderCalls: true,
      },
    }
    await writeFile(
      join(outputPath, 'reconstruction.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
      {
        flag: 'wx',
      },
    )
    console.log(
      JSON.stringify({
        outputPath,
        seed,
        proposal: summary.proposal,
        derivedMask: summary.derivedMask,
      }),
    )
  } finally {
    await proposalPort?.settle()
    await proposalPort?.dispose()
    bytes.fill(0)
    rgba?.fill(0)
    maskData?.fill(0)
    pngBytes?.fill(0)
    previewBytes?.fill(0)
  }
}

const replayRequests: DecisionRequest[] = []

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outputPath = process.argv[2]
  if (!outputPath) {
    process.stderr.write('Provide an unused output directory for the offline mask artifact.\n')
    process.exitCode = 2
  } else {
    try {
      await reconstruct(resolve(outputPath))
    } catch {
      process.stderr.write('Offline C03 reconstruction failed; inspect local diagnostics.\n')
      process.exitCode = 1
    }
  }
}
