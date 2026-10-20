import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  freshProfilePolicy,
  freshProfileVariants,
  preflightFreshCorpus,
  readFreshOpenRouterKey,
  runFreshCorpusProfile,
} from './fresh-runner.js'

const manifestPins = [
  {
    path: 'benchmarks/v02/corpus/dev/inputs.json',
    sha256: '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a',
  },
  {
    path: 'benchmarks/v02/corpus/dev-independent-ui/inputs.json',
    sha256: '6013a54bebba277f6457765cd8ef78e12e2dd5bab4453a752967233ebb429bfc',
  },
] as const

export function parseFreshDevArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      'allow-paid': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'image-root': { type: 'string', default: '/root/work/zorya-classifier-worktrees/v02/corpus' },
      out: { type: 'string', default: '.run/v02' },
      profile: { type: 'string' },
    },
  })
  if (!values['allow-paid'] && !values['dry-run'])
    throw new Error('Fresh DEV run requires explicit --allow-paid or --dry-run')
  const profile = values.profile
  if (profile !== undefined && !freshProfileVariants.some((item) => item.id === profile))
    throw new Error('Unknown fresh DEV profile')
  return {
    imageRoot: resolve(z.string().min(1).parse(values['image-root'])),
    outputRoot: resolve(z.string().min(1).parse(values.out)),
    manifests: manifestPins.map((item) => ({ ...item, path: resolve(item.path) })),
    dryRun: values['dry-run'],
    profile,
  }
}

async function runDryPreflight(options: ReturnType<typeof parseFreshDevArgs>) {
  const preflight = await preflightFreshCorpus(options)
  const runId = `v02-fresh-preflight-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const summary = {
    runId,
    mode: 'offline-preflight-only',
    manifests: preflight.corpus.manifests,
    plannedCaseIds: preflight.corpus.cases.map((item) => item.caseId),
    profileIds: freshProfileVariants.map((profile) => profile.id),
    policy: freshProfilePolicy,
    images: preflight.corpus.cases.map((item) => ({
      caseId: item.caseId,
      imageSha256: item.image.sha256,
      imageDimensions: { width: item.image.width, height: item.image.height },
      status: preflight.imageChecks.get(item.caseId)?.ok ? 'verified' : 'failed',
      errorCode: preflight.imageChecks.get(item.caseId)?.ok
        ? null
        : ((preflight.imageChecks.get(item.caseId) as { errorCode: string } | undefined)
            ?.errorCode ?? 'INVALID_INPUT'),
    })),
    providerCalls: 0,
  }
  await writeFile(
    join(outputDirectory, 'preflight.json'),
    JSON.stringify(summary, null, 2) + '\n',
    {
      flag: 'wx',
    },
  )
  const summarySha256 = createHash('sha256').update(JSON.stringify(summary)).digest('hex')
  await writeFile(
    join(outputDirectory, 'run-complete.json'),
    JSON.stringify({ runId, summarySha256 }, null, 2) + '\n',
    { flag: 'wx' },
  )
  return {
    runId,
    mode: 'offline-preflight-only',
    providerCalls: 0,
    verifiedImages: summary.images.filter((item) => item.status === 'verified').length,
    failedImages: summary.images.filter((item) => item.status !== 'verified').length,
  }
}

async function runFromCommandLine(args: readonly string[]) {
  const options = parseFreshDevArgs(args)
  if (options.dryRun) return runDryPreflight(options)
  const apiKey = await readFreshOpenRouterKey()
  const results = []
  const selectedProfiles = options.profile
    ? freshProfileVariants.filter((item) => item.id === options.profile)
    : freshProfileVariants
  for (const profile of selectedProfiles) {
    const result = await runFreshCorpusProfile({ ...options, apiKey }, profile.id)
    results.push({
      runId: result.runId,
      profileId: result.profileId,
      status: result.status,
      planned: result.plannedCaseIds.length,
      completed: result.completedCaseIds.length,
      missing: result.missingCaseIds.length,
      aggregate: result.aggregate,
    })
  }
  return results
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(await runFromCommandLine(process.argv.slice(2))) + '\n')
  } catch {
    process.stderr.write(
      'Fresh DEV run stopped; inspect its immutable local artifacts. Credentials, source paths and provider bodies are never printed.\n',
    )
    process.exitCode = 1
  }
}
