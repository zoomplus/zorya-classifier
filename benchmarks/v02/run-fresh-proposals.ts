import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { loadFreshCorpus, loadFreshImage } from './fresh-corpus.js'
import {
  freshProposalManifestHashes,
  freshProposalPolicy,
  readFreshProposalOpenRouterKey,
  runFreshProposalDev,
} from './fresh-proposal-runner.js'

const pinnedManifests = [
  {
    path: 'benchmarks/v02/corpus/dev/inputs.json',
    sha256: freshProposalManifestHashes[0],
  },
  {
    path: 'benchmarks/v02/corpus/dev-independent-ui/inputs.json',
    sha256: freshProposalManifestHashes[1],
  },
  {
    path: '/root/work/zorya-classifier/benchmarks/v02/corpus/dev-independent-map/inputs.json',
    sha256: freshProposalManifestHashes[2],
  },
] as const

export function parseFreshProposalArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      'allow-paid': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'image-root': { type: 'string', default: '/root/work/zorya-classifier-worktrees/v02/corpus' },
      'map-inputs': { type: 'string', default: pinnedManifests[2].path },
      encoder: { type: 'string' },
      decoder: { type: 'string' },
      out: { type: 'string', default: '.run/v02' },
    },
  })
  if (!values['allow-paid'] && !values['dry-run'])
    throw new Error('Fresh proposal run requires explicit --allow-paid or --dry-run')
  if (!values['dry-run'] && (!values.encoder || !values.decoder))
    throw new Error('A paid MobileSAM proposal run requires --encoder and --decoder paths')
  return {
    imageRoot: resolve(z.string().min(1).parse(values['image-root'])),
    outputRoot: resolve(z.string().min(1).parse(values.out)),
    encoderPath: values.encoder ? resolve(values.encoder) : '',
    decoderPath: values.decoder ? resolve(values.decoder) : '',
    manifests: [
      { ...pinnedManifests[0], path: resolve(pinnedManifests[0].path) },
      { ...pinnedManifests[1], path: resolve(pinnedManifests[1].path) },
      { ...pinnedManifests[2], path: resolve(z.string().min(1).parse(values['map-inputs'])) },
    ],
    dryRun: values['dry-run'],
  }
}

async function runPreflight(options: ReturnType<typeof parseFreshProposalArgs>) {
  const controller = new AbortController()
  const corpus = await loadFreshCorpus(
    { manifests: options.manifests, imageRoot: options.imageRoot },
    controller.signal,
  )
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
  if (corpus.cases.length !== 40) throw new Error('Pinned producer manifests must contain 40 cases')
  const runId = `v02-fresh-proposal-preflight-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const report = {
    runId,
    mode: 'offline-preflight-only',
    plannedCaseIds: corpus.cases.map((item) => item.caseId),
    manifests: corpus.manifests,
    images,
    policy: freshProposalPolicy,
    physicalProviderCalls: 0,
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  await writeFile(join(outputDirectory, 'preflight.json'), serialized, { flag: 'wx' })
  await writeFile(
    join(outputDirectory, 'run-complete.json'),
    `${JSON.stringify({ runId, summarySha256: createHash('sha256').update(serialized).digest('hex') }, null, 2)}\n`,
    { flag: 'wx' },
  )
  return {
    runId,
    mode: 'offline-preflight-only',
    verifiedImages: images.filter((item) => item.status === 'verified').length,
    failedImages: images.filter((item) => item.status === 'failed').length,
    physicalProviderCalls: 0,
  }
}

async function runFromCommandLine(args: readonly string[]) {
  const options = parseFreshProposalArgs(args)
  if (options.dryRun) return runPreflight(options)
  const apiKey = await readFreshProposalOpenRouterKey()
  const result = await runFreshProposalDev({ ...options, apiKey })
  return {
    runId: result.runId,
    profileId: result.profileId,
    status: result.status,
    planned: result.plannedCaseIds.length,
    completed: result.completedCaseIds.length,
    missing: result.missingCaseIds.length,
    aggregate: result.aggregate,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(await runFromCommandLine(process.argv.slice(2))) + '\n')
  } catch {
    process.stderr.write(
      'Fresh proposal run stopped; inspect immutable local artifacts. Credentials, source paths and provider bodies are never printed.\n',
    )
    process.exitCode = 1
  }
}
