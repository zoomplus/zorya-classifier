import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { loadFreshCorpus, loadFreshImage } from './fresh-corpus.js'
import {
  categoricalFreshPolicy,
  categoricalFreshProfiles,
  freshProposalManifestHashes,
  mobileSamProposalAssets,
  readFreshProposalOpenRouterKey as readKey,
  runCategoricalPresenceFreshPair,
  validateTargetPolicyTasks,
} from './categorical-presence-fresh-runner.js'

const defaultEncoder =
  '/root/work/zorya-worktrees/locator-segmentation-model/.run/segmentation-model/models/mobile_sam_image_encoder.onnx'
const defaultDecoder =
  '/root/work/zorya-worktrees/locator-segmentation-model/.run/segmentation-model/models/sam_mask_decoder_multi.onnx'

const defaultManifests = [
  {
    path: '/root/work/zorya-classifier/benchmarks/v02/corpus/dev/inputs.json',
    sha256: freshProposalManifestHashes[0],
  },
  {
    path: '/root/work/zorya-classifier/benchmarks/v02/corpus/dev-independent-ui/inputs.json',
    sha256: freshProposalManifestHashes[1],
  },
  {
    path: '/root/work/zorya-classifier/benchmarks/v02/corpus/dev-independent-map/inputs.json',
    sha256: freshProposalManifestHashes[2],
  },
] as const

export function parseCategoricalFreshArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      'allow-paid': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'image-root': { type: 'string', default: '/root/work/zorya-classifier-worktrees/v02/corpus' },
      'photo-inputs': { type: 'string', default: defaultManifests[0].path },
      'ui-inputs': { type: 'string', default: defaultManifests[1].path },
      'map-inputs': { type: 'string', default: defaultManifests[2].path },
      encoder: { type: 'string', default: defaultEncoder },
      decoder: { type: 'string', default: defaultDecoder },
      out: { type: 'string', default: '.run/v02' },
    },
  })
  if (!values['allow-paid'] && !values['dry-run'])
    throw new Error('Categorical full DEV run requires explicit --allow-paid or --dry-run')
  if (!values.encoder || !values.decoder)
    throw new Error('A paid MobileSAM proposal run requires --encoder and --decoder paths')
  return {
    dryRun: values['dry-run'],
    imageRoot: resolve(z.string().min(1).parse(values['image-root'])),
    outputRoot: resolve(z.string().min(1).parse(values.out)),
    encoderPath: resolve(values.encoder),
    decoderPath: resolve(values.decoder),
    manifests: [
      {
        path: resolve(z.string().min(1).parse(values['photo-inputs'])),
        sha256: freshProposalManifestHashes[0],
      },
      {
        path: resolve(z.string().min(1).parse(values['ui-inputs'])),
        sha256: freshProposalManifestHashes[1],
      },
      {
        path: resolve(z.string().min(1).parse(values['map-inputs'])),
        sha256: freshProposalManifestHashes[2],
      },
    ],
  }
}

export function assertCategoricalFreshDevCorpusShape(corpus: {
  cases: readonly unknown[]
  manifests: readonly { sha256: string; cases: number }[]
}): void {
  if (
    corpus.cases.length !== 40 ||
    corpus.manifests.length !== 3 ||
    corpus.manifests.some(
      (manifest, index) => manifest.sha256 !== freshProposalManifestHashes[index],
    ) ||
    corpus.manifests[0]?.cases !== 20 ||
    corpus.manifests[1]?.cases !== 10 ||
    corpus.manifests[2]?.cases !== 10
  )
    throw new Error('Pinned DEV manifests must contain 20 photo, 10 UI and 10 map inputs')
}

async function preflight(options: ReturnType<typeof parseCategoricalFreshArgs>) {
  const controller = new AbortController()
  const corpus = await loadFreshCorpus(
    { manifests: options.manifests, imageRoot: options.imageRoot },
    controller.signal,
  )
  assertCategoricalFreshDevCorpusShape(corpus)
  validateTargetPolicyTasks(corpus.cases)
  const assetDigests = await Promise.all(
    [options.encoderPath, options.decoderPath].map(async (path) => {
      const bytes = await readFile(path)
      const result = {
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
      bytes.fill(0)
      return result
    }),
  )
  if (
    assetDigests[0]?.bytes !== mobileSamProposalAssets.encoder.bytes ||
    assetDigests[0]?.sha256 !== mobileSamProposalAssets.encoder.sha256 ||
    assetDigests[1]?.bytes !== mobileSamProposalAssets.decoder.bytes ||
    assetDigests[1]?.sha256 !== mobileSamProposalAssets.decoder.sha256
  )
    throw new Error('Pinned MobileSAM assets failed preflight verification')
  const images = []
  for (const item of corpus.cases) {
    try {
      const bytes = await loadFreshImage(item, corpus.imageRoot, controller.signal)
      bytes.fill(0)
      images.push({ caseId: item.caseId, status: 'verified', errorCode: null })
    } catch {
      images.push({ caseId: item.caseId, status: 'failed', errorCode: 'INVALID_INPUT' })
    }
  }
  const runId = `v02-categorical-fresh-preflight-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const body = `${JSON.stringify(
    {
      runId,
      mode: 'offline-preflight-only',
      plannedCaseIds: corpus.cases.map((item) => item.caseId),
      manifests: corpus.manifests,
      images,
      profiles: [categoricalFreshProfiles.preserveInstruction, categoricalFreshProfiles.targetOnly],
      policy: categoricalFreshPolicy,
      mobileSam: mobileSamProposalAssets,
      assetFilesVerified: assetDigests,
      physicalProviderCalls: 0,
    },
    null,
    2,
  )}\n`
  await writeFile(resolve(outputDirectory, 'preflight.json'), body, { flag: 'wx' })
  await writeFile(
    resolve(outputDirectory, 'run-complete.json'),
    `${JSON.stringify({ runId, summarySha256: createHash('sha256').update(body).digest('hex') }, null, 2)}\n`,
    { flag: 'wx' },
  )
  return {
    runId,
    mode: 'offline-preflight-only',
    planned: corpus.cases.length,
    verified: images.filter((item) => item.status === 'verified').length,
    failed: images.filter((item) => item.status === 'failed').length,
    physicalProviderCalls: 0,
  }
}

async function run(args: readonly string[]) {
  const options = parseCategoricalFreshArgs(args)
  if (options.dryRun) return preflight(options)
  const apiKey = await readKey()
  return runCategoricalPresenceFreshPair({ ...options, apiKey })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(await run(process.argv.slice(2))) + '\n')
  } catch {
    process.stderr.write(
      'Categorical fresh DEV run stopped; inspect immutable local artifacts. Credentials, source paths and provider bodies are never printed.\n',
    )
    process.exitCode = 1
  }
}
