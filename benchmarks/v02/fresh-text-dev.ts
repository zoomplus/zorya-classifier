import { mkdir, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  freshTextProfiles,
  readFreshTextOpenRouterKey,
  runFreshTextProfile,
} from './fresh-text-runner.js'
import { loadFreshCorpus, loadFreshImage } from './fresh-corpus.js'

const pins = [
  {
    path: 'benchmarks/v02/corpus/dev/inputs.json',
    sha256: '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a',
  },
  {
    path: 'benchmarks/v02/corpus/dev-independent-ui/inputs.json',
    sha256: '6013a54bebba277f6457765cd8ef78e12e2dd5bab4453a752967233ebb429bfc',
  },
] as const

export function parseFreshTextArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      'allow-paid': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      profile: { type: 'string' },
      'classify-only': { type: 'boolean', default: false },
      'image-root': { type: 'string', default: '/root/work/zorya-classifier-worktrees/v02/corpus' },
      out: { type: 'string', default: '.run/v02' },
    },
  })
  if (!values['allow-paid'] && !values['dry-run'])
    throw new Error('Fresh text DEV run requires explicit --allow-paid or --dry-run')
  if (
    !values.profile ||
    !freshTextProfiles.includes(values.profile as (typeof freshTextProfiles)[number])
  )
    throw new Error('Fresh text DEV run requires one known --profile')
  return {
    profile: values.profile as (typeof freshTextProfiles)[number],
    imageRoot: resolve(z.string().min(1).parse(values['image-root'])),
    outputRoot: resolve(z.string().min(1).parse(values.out)),
    manifests: pins.map((item) => ({ ...item, path: resolve(item.path) })),
    dryRun: values['dry-run'],
    stages: values['classify-only'] ? ('classify-only' as const) : ('classify-and-locate' as const),
  }
}

async function runDryPreflight(options: ReturnType<typeof parseFreshTextArgs>) {
  const signal = new AbortController().signal
  const corpus = await loadFreshCorpus(
    {
      manifests: options.manifests,
      imageRoot: options.imageRoot,
    },
    signal,
  )
  for (const item of corpus.cases) (await loadFreshImage(item, corpus.imageRoot, signal)).fill(0)
  const runId = `v02-fresh-text-preflight-${Date.now()}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(outputDirectory, { recursive: false })
  await writeFile(
    join(outputDirectory, 'preflight.json'),
    `${JSON.stringify(
      {
        runId,
        profileId: options.profile,
        plannedCaseIds: corpus.cases.map((item) => item.caseId),
        manifestHashes: corpus.manifests,
        verifiedImages: corpus.cases.length,
        providerCalls: 0,
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  )
  return {
    runId,
    profileId: options.profile,
    verifiedImages: corpus.cases.length,
    providerCalls: 0,
  }
}

async function runFromCommandLine(args: readonly string[]) {
  const options = parseFreshTextArgs(args)
  if (options.dryRun) return runDryPreflight(options)
  const apiKey = await readFreshTextOpenRouterKey()
  const result = await runFreshTextProfile({ ...options, apiKey }, options.profile)
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
      'Fresh text DEV run stopped; inspect its immutable local artifacts. Credentials, paths and provider bodies are never printed.\n',
    )
    process.exitCode = 1
  }
}
