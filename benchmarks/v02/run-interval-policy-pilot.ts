import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseArgs, parseEnv } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createResearchClassifier } from '../experiments/create-research-classifier.js'
import type { IntervalPolicyPilotOptions } from './intervalpolicy-pilot.js'
import { runIntervalPolicyPilot } from './intervalpolicy-pilot.js'

const keyFile = '/root/work/element/.env.local'

export function parseIntervalPolicyPilotArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      'allow-paid': { type: 'boolean', default: false },
      'image-root': { type: 'string', default: '/root/work/zorya-classifier/benchmarks/corpus' },
      out: { type: 'string', default: '.run/v02' },
    },
  })
  if (!values['allow-paid']) throw new Error('Pilot requires explicit --allow-paid')
  return {
    imageRoot: resolve(z.string().min(1).parse(values['image-root'])),
    outputRoot: resolve(z.string().min(1).parse(values.out)),
  }
}

async function readOpenRouterKey(): Promise<string> {
  const key = parseEnv(await readFile(keyFile, 'utf8')).OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY is absent from configured private environment')
  return key
}

async function runFromCommandLine(args: readonly string[]) {
  const options = parseIntervalPolicyPilotArgs(args)
  const apiKey = await readOpenRouterKey()
  const renderer = await readFile(new URL('../experiments/boundary-view.ts', import.meta.url))
  const rendererSha256 = createHash('sha256').update(renderer).digest('hex')
  const composeClassifier: IntervalPolicyPilotOptions['composeClassifier'] = (
    decision,
    boundaryView,
    intervalPolicy,
  ) =>
    createResearchClassifier(
      { decision, timeoutMs: 45000, concurrency: 1, maxQueue: 0 },
      undefined,
      boundaryView,
      intervalPolicy,
    )
  return runIntervalPolicyPilot({ ...options, apiKey, rendererSha256, composeClassifier })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runFromCommandLine(process.argv.slice(2))
    process.stdout.write(
      JSON.stringify({
        runId: result.runId,
        variantId: result.variantId,
        status: result.status,
        aggregate: result.aggregate,
        latencyEnvironment: result.latencyEnvironment,
        outputDirectory: result.outputDirectory,
      }) + '\n',
    )
    if (result.status !== 'complete') process.exitCode = 1
  } catch {
    process.stderr.write(
      'Interval-policy pilot stopped; inspect immutable local artifacts. Credentials and provider bodies are never printed.\n',
    )
    process.exitCode = 1
  }
}
