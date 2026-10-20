import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadFreshCorpus, loadFreshImage } from './fresh-corpus.js'
import {
  categoricalFreshPolicy,
  categoricalFreshProfiles,
  categoricalFreshProducerSourceSha256,
  mobileSamProposalAssets,
  readFreshProposalOpenRouterKey,
  runCategoricalPresenceFreshBoxConfirmationDev,
  validateTargetPolicyTasks,
} from './categorical-presence-fresh-runner.js'
import type { FreshProposalRunnerOptions } from './categorical-presence-fresh-runner.js'
import {
  assertCategoricalFreshDevCorpusShape,
  parseCategoricalFreshArgs,
} from './run-categorical-presence-fresh.js'

export function parseCategoricalBoxConfirmationDevArgs(args: readonly string[]) {
  return {
    ...parseCategoricalFreshArgs(args),
    profile: categoricalFreshProfiles.boxConfirmation,
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function writeImmutable(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

async function preflight(options: ReturnType<typeof parseCategoricalBoxConfirmationDevArgs>) {
  const controller = new AbortController()
  const corpus = await loadFreshCorpus(
    { manifests: options.manifests, imageRoot: options.imageRoot },
    controller.signal,
  )
  assertCategoricalFreshDevCorpusShape(corpus)
  validateTargetPolicyTasks(corpus.cases)

  const assetFiles = [options.encoderPath, options.decoderPath]
  const expectedAssets = [mobileSamProposalAssets.encoder, mobileSamProposalAssets.decoder]
  const assets = await Promise.all(
    assetFiles.map(async (path) => {
      const bytes = await readFile(path)
      try {
        return { bytes: bytes.byteLength, sha256: sha256(bytes), verified: true }
      } finally {
        bytes.fill(0)
      }
    }),
  )
  if (
    assets.some(
      (asset, index) =>
        asset.bytes !== expectedAssets[index]?.bytes ||
        asset.sha256 !== expectedAssets[index]?.sha256,
    )
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
  const runId = `v02-categorical-box-confirmation-preflight-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const body = `${JSON.stringify(
    {
      runId,
      mode: 'offline-preflight-only',
      profileId: options.profile.id,
      targetPolicy: options.profile.targetPolicy,
      phase: 'dev',
      purpose: 'full fresh DEV photo, independent UI and independent map producer pass',
      producerSourceSha256: await categoricalFreshProducerSourceSha256(),
      plannedCaseIds: corpus.cases.map((item) => item.caseId),
      manifests: corpus.manifests,
      images,
      policy: categoricalFreshPolicy,
      mobileSam: mobileSamProposalAssets,
      assetFilesVerified: assets,
      physicalProviderCalls: 0,
    },
    null,
    2,
  )}\n`
  await writeFile(resolve(outputDirectory, 'preflight.json'), body, { flag: 'wx' })
  await writeImmutable(resolve(outputDirectory, 'run-complete.json'), {
    runId,
    summarySha256: createHash('sha256').update(body).digest('hex'),
    physicalProviderCalls: 0,
  })
  return {
    runId,
    outputDirectory,
    mode: 'offline-preflight-only',
    profileId: options.profile.id,
    planned: corpus.cases.length,
    verified: images.filter((item) => item.status === 'verified').length,
    failed: images.filter((item) => item.status === 'failed').length,
    physicalProviderCalls: 0,
  }
}

export async function runCategoricalBoxConfirmationDev(args: readonly string[]) {
  const options = parseCategoricalBoxConfirmationDevArgs(args)
  if (options.dryRun) return preflight(options)
  const apiKey = await readFreshProposalOpenRouterKey()
  const runnerOptions: FreshProposalRunnerOptions = { ...options, apiKey }
  return runCategoricalPresenceFreshBoxConfirmationDev(runnerOptions)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(
      JSON.stringify(await runCategoricalBoxConfirmationDev(process.argv.slice(2))) + '\n',
    )
  } catch {
    process.stderr.write(
      'Categorical box-confirmation DEV run stopped; inspect immutable local artifacts. Credentials, source paths and provider bodies are never printed.\n',
    )
    process.exitCode = 1
  }
}
