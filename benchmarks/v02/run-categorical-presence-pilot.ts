import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  preflightCategoricalPresencePilot,
  readCategoricalPilotOpenRouterKey as readKey,
  runCategoricalPresenceDevPilot,
  categoricalPilotInput,
} from './categorical-presence-pilot.js'

export function parseCategoricalPilotArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      'allow-paid': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'api-key-env': { type: 'string', default: 'OPENROUTER_API_KEY' },
      input: { type: 'string', default: categoricalPilotInput.path },
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
    apiKeyEnvironmentName: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
      .parse(values['api-key-env']),
  }
}

async function runFromCommandLine(args: readonly string[]) {
  const options = parseCategoricalPilotArgs(args)
  if (options.dryRun) {
    const report = await preflightCategoricalPresencePilot(
      options.inputManifestPath,
      options.imageRoot,
    )
    return {
      mode: 'offline-preflight-only',
      planned: report.cases.length,
      verified: report.verifiedCaseIds.length,
      failures: report.failures.map(({ caseId, errorCode }) => ({ caseId, errorCode })),
      physicalProviderCalls: 0,
    }
  }
  const apiKey = readKey(process.env, options.apiKeyEnvironmentName)
  const result = await runCategoricalPresenceDevPilot({ ...options, apiKey })
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
      'Categorical presence pilot stopped; inspect immutable local artifacts. Credentials and provider bodies are never printed.\n',
    )
    process.exitCode = 1
  }
}
