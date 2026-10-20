import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  preflightSplitRoutePilot,
  readSplitPilotOpenRouterKey,
  runSplitRouteDevPilot,
  splitPilotInput,
} from './split-route-proposal-pilot.js'

export function parseSplitPilotArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      'allow-paid': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      input: { type: 'string', default: splitPilotInput.path },
      'image-root': { type: 'string', default: '/root/work/zorya-classifier-worktrees/v02/corpus' },
      encoder: { type: 'string' },
      decoder: { type: 'string' },
      out: { type: 'string', default: '.run/v02' },
    },
  })
  if (Boolean(values['allow-paid']) === Boolean(values['dry-run']))
    throw new Error('Choose exactly one of --dry-run or --allow-paid')
  if (values['allow-paid'] && (!values.encoder || !values.decoder))
    throw new Error('Paid pilot requires explicit --encoder and --decoder paths')
  return {
    allowPaid: values['allow-paid'],
    dryRun: values['dry-run'],
    inputManifestPath: resolve(z.string().min(1).parse(values.input)),
    imageRoot: resolve(z.string().min(1).parse(values['image-root'])),
    outputRoot: resolve(z.string().min(1).parse(values.out)),
    encoderPath: values.encoder ? resolve(values.encoder) : '',
    decoderPath: values.decoder ? resolve(values.decoder) : '',
  }
}

async function runFromCommandLine(args: readonly string[]) {
  const options = parseSplitPilotArgs(args)
  if (options.dryRun) {
    const report = await preflightSplitRoutePilot(options.inputManifestPath, options.imageRoot)
    return {
      mode: 'offline-preflight-only',
      planned: report.cases.length,
      verified: report.verifiedCaseIds.length,
      failures: report.failures.map(({ caseId, errorCode }) => ({ caseId, errorCode })),
      physicalProviderCalls: 0,
    }
  }
  const apiKey = await readSplitPilotOpenRouterKey()
  const result = await runSplitRouteDevPilot({ ...options, apiKey })
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
      'Split-route pilot stopped; inspect immutable local artifacts. Credentials and provider bodies are never printed.\n',
    )
    process.exitCode = 1
  }
}
