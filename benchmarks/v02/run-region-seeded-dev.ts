import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { parseEnv } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { loadFreshCorpus, loadFreshImage } from './fresh-corpus.js'
import {
  regionSeededAssets,
  regionSeededDevManifests,
  regionSeededNoImageHeldoutProfile,
  regionSeededNoImageProfile,
  regionSeededProfile,
  regionSeededHeldoutProfile,
  regionSeededProducerSourceManifest,
  regionPresenceFirstNoImageProfile,
  regionPresenceFirstProfile,
  regionPresenceFirstHeldoutProfile,
  regionPresenceFirstNoImageHeldoutProfile,
  runRegionSeededProfile,
} from './region-seeded-runner.js'

const assetDefaults = {
  encoder:
    '/root/work/zorya-worktrees/locator-segmentation-model/.run/segmentation-model/models/mobile_sam_image_encoder.onnx',
  decoder:
    '/root/work/zorya-worktrees/locator-segmentation-model/.run/segmentation-model/models/sam_mask_decoder_multi.onnx',
}
const envFileDefault = '/root/work/element/.env.local'
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)

export function parseRegionSeededArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      'allow-paid': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      phase: { type: 'string', default: 'dev' },
      variant: { type: 'string', default: 'region-seeded-sam' },
      'profile-id': { type: 'string' },
      'presence-first': { type: 'boolean', default: false },
      'image-root': { type: 'string', default: '/root/work/zorya-classifier-worktrees/v02/corpus' },
      'photo-inputs': { type: 'string', default: regionSeededDevManifests[0].path },
      'photo-sha256': { type: 'string', default: regionSeededDevManifests[0].sha256 },
      'ui-inputs': { type: 'string', default: regionSeededDevManifests[1].path },
      'ui-sha256': { type: 'string', default: regionSeededDevManifests[1].sha256 },
      'map-inputs': { type: 'string', default: regionSeededDevManifests[2].path },
      'map-sha256': { type: 'string', default: regionSeededDevManifests[2].sha256 },
      encoder: { type: 'string', default: assetDefaults.encoder },
      decoder: { type: 'string', default: assetDefaults.decoder },
      'env-file': { type: 'string', default: envFileDefault },
      freeze: { type: 'string' },
      out: { type: 'string', default: '.run/v02/region-seeded' },
    },
  })
  if (values['allow-paid'] === values['dry-run'])
    throw new TypeError('Choose exactly one of --dry-run or --allow-paid')
  const phase = z.enum(['dev', 'heldout']).parse(values.phase)
  const variant = z.enum(['region-seeded-sam', 'no-image-control']).parse(values.variant)
  const requireClassifiedPresence = values['presence-first']
  const expectedProfile = requireClassifiedPresence
    ? variant === 'region-seeded-sam'
      ? phase === 'dev'
        ? regionPresenceFirstProfile.id
        : regionPresenceFirstHeldoutProfile.id
      : phase === 'dev'
        ? regionPresenceFirstNoImageProfile.id
        : regionPresenceFirstNoImageHeldoutProfile.id
    : variant === 'region-seeded-sam'
      ? phase === 'dev'
        ? regionSeededProfile.id
        : regionSeededHeldoutProfile.id
      : phase === 'dev'
        ? regionSeededNoImageProfile.id
        : regionSeededNoImageHeldoutProfile.id
  const profileId =
    values['profile-id'] === undefined
      ? expectedProfile
      : z.string().min(1).max(128).parse(values['profile-id'])
  if (profileId !== expectedProfile)
    throw new TypeError('Profile ID does not match the selected variant and phase')
  if (phase === 'heldout') {
    if (!values.freeze) throw new TypeError('HELDOUT requires --freeze')
    for (const option of [
      'image-root',
      'photo-inputs',
      'photo-sha256',
      'ui-inputs',
      'ui-sha256',
      'map-inputs',
      'map-sha256',
    ]) {
      if (!args.some((arg) => arg === `--${option}` || arg.startsWith(`--${option}=`)))
        throw new TypeError(`HELDOUT requires explicit --${option}`)
    }
  }
  return {
    paid: values['allow-paid'],
    phase,
    variant,
    profileId,
    requireClassifiedPresence,
    expectedCaseCount: phase === 'dev' ? 40 : 80,
    imageRoot: resolve(z.string().min(1).parse(values['image-root'])),
    outputRoot: resolve(z.string().min(1).parse(values.out)),
    manifests: [
      {
        path: resolve(z.string().min(1).parse(values['photo-inputs'])),
        sha256: hashSchema.parse(values['photo-sha256']),
      },
      {
        path: resolve(z.string().min(1).parse(values['ui-inputs'])),
        sha256: hashSchema.parse(values['ui-sha256']),
      },
      {
        path: resolve(z.string().min(1).parse(values['map-inputs'])),
        sha256: hashSchema.parse(values['map-sha256']),
      },
    ],
    encoderPath: resolve(values.encoder),
    decoderPath: resolve(values.decoder),
    envFile: resolve(values['env-file']),
    freezePath: values.freeze ? resolve(values.freeze) : undefined,
    maxPhysicalCalls: phase === 'heldout' ? 600 : 250,
    maxCostUsd: phase === 'heldout' ? 10 : 5,
    unknownCostReserveUsd: 0.05,
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function readApiKey(envFile: string): Promise<string> {
  const text = await readFile(envFile, 'utf8')
  const parsed = parseEnv(text)
  const key = parsed.OPENROUTER_API_KEY
  if (!key || key.length > 4096 || /\s/u.test(key))
    throw new TypeError('Provider credential is unavailable')
  return key
}

async function preflight(options: ReturnType<typeof parseRegionSeededArgs>) {
  const controller = new AbortController()
  const corpus = await loadFreshCorpus(
    { manifests: options.manifests, imageRoot: options.imageRoot },
    controller.signal,
  )
  if (corpus.cases.length !== options.expectedCaseCount)
    throw new TypeError('Input count does not match the selected phase')
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
  const assets =
    options.variant === 'region-seeded-sam'
      ? await Promise.all(
          [options.encoderPath, options.decoderPath].map(async (path) => {
            const bytes = await readFile(path)
            const value = { bytes: bytes.byteLength, sha256: sha256(bytes) }
            bytes.fill(0)
            return value
          }),
        )
      : []
  if (
    options.variant === 'region-seeded-sam' &&
    (assets[0]?.bytes !== regionSeededAssets.encoder.bytes ||
      assets[0].sha256 !== regionSeededAssets.encoder.sha256 ||
      assets[1]?.bytes !== regionSeededAssets.decoder.bytes ||
      assets[1].sha256 !== regionSeededAssets.decoder.sha256)
  )
    throw new TypeError('Pinned MobileSAM assets failed verification')
  const source = await regionSeededProducerSourceManifest()
  const runId = `v02-region-seeded-preflight-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const directory = resolve(options.outputRoot, runId)
  await mkdir(directory, { recursive: true })
  await writeFile(
    resolve(directory, 'preflight.json'),
    `${JSON.stringify(
      {
        runId,
        mode: 'offline-preflight-only',
        profileId: options.profileId,
        phase: options.phase,
        variant: options.variant,
        requireClassifiedPresence: options.requireClassifiedPresence,
        manifests: corpus.manifests,
        plannedCaseIds: corpus.cases.map((item) => item.caseId),
        imageChecks: images,
        producerSourceFiles: source,
        verifiedAssets: assets,
        physicalProviderCalls: 0,
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  )
  return {
    runId,
    outputDirectory: directory,
    mode: 'offline-preflight-only',
    profileId: options.profileId,
    planned: corpus.cases.length,
    verified: images.filter((row) => row.status === 'verified').length,
    failed: images.filter((row) => row.status === 'failed').length,
    physicalProviderCalls: 0,
  }
}

export async function runRegionSeededCli(args: readonly string[]) {
  const options = parseRegionSeededArgs(args)
  if (!options.paid) return preflight(options)
  const authorization = options.freezePath
    ? (JSON.parse(await readFile(options.freezePath, 'utf8')) as unknown)
    : undefined
  const apiKey = await readApiKey(options.envFile)
  const result = await runRegionSeededProfile({
    manifests: options.manifests,
    imageRoot: options.imageRoot,
    outputRoot: options.outputRoot,
    apiKey,
    encoderPath: options.encoderPath,
    decoderPath: options.decoderPath,
    profileId: options.profileId,
    phase: options.phase,
    variant: options.variant,
    requireClassifiedPresence: options.requireClassifiedPresence,
    expectedCaseCount: options.expectedCaseCount,
    maxPhysicalCalls: options.maxPhysicalCalls,
    maxCostUsd: options.maxCostUsd,
    unknownCostReserveUsd: options.unknownCostReserveUsd,
    ...(authorization !== undefined ? { authorization } : {}),
  })
  return {
    runId: result.runId,
    outputDirectory: result.outputDirectory,
    profileId: result.profileId,
    phase: result.phase,
    status: result.status,
    aggregate: result.aggregate,
    completedCaseIds: result.completedCaseIds,
    missingCaseIds: result.missingCaseIds,
    sourceUnchanged: result.sourceUnchanged,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runRegionSeededCli(process.argv.slice(2)))}\n`)
  } catch {
    process.stderr.write(
      'Region-seeded run stopped; inspect immutable private artifacts. Credentials and provider bodies are never printed.\n',
    )
    process.exitCode = 1
  }
}
