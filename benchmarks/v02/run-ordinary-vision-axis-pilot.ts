import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createResearchClassifier } from '../experiments/create-research-classifier.js'
import { runOrdinaryVisionPilot } from './ordinaryvisionpilot.js'
import type { OrdinaryVisionPilotOptions } from './ordinaryvisionpilot.js'

import { readOpenRouterKeyFromProcessEnv } from '../credentials.js'

export function parseOrdinaryVisionPilotArgs(args: readonly string[]) {
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
  return readOpenRouterKeyFromProcessEnv()
}

async function rendererHash(): Promise<string> {
  const bytes = await readFile(new URL('../experiments/boundary-view.ts', import.meta.url))
  return createHash('sha256').update(bytes).digest('hex')
}

async function runFromCommandLine(args: readonly string[]) {
  const options = parseOrdinaryVisionPilotArgs(args)
  const apiKey = await readOpenRouterKey()
  const rendererSha256 = await rendererHash()
  const composeClassifier: OrdinaryVisionPilotOptions['composeClassifier'] = (
    decision,
    boundaryView,
  ) =>
    createResearchClassifier(
      { decision, timeoutMs: 45000, concurrency: 1, maxQueue: 0 },
      undefined,
      boundaryView,
    )
  return runOrdinaryVisionPilot({ ...options, apiKey, rendererSha256, composeClassifier })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runFromCommandLine(process.argv.slice(2))
    process.stdout.write(
      JSON.stringify({
        runId: result.runId,
        variantId: result.variantId,
        status: result.status,
        stopReason: result.stopReason,
        outcomes: result.outcomes.map((item) => ({
          caseId: item.caseId,
          status: item.status,
          result: item.result,
          errorCode: item.errorCode,
        })),
        aggregate: result.aggregate,
        latency: result.latency,
        latencyRankingEligible: result.latencyRankingEligible,
        outputDirectory: result.outputDirectory,
      }) + '\n',
    )
    if (result.status !== 'complete') process.exitCode = 1
  } catch {
    process.stderr.write(
      'Ordinary vision pilot stopped; inspect immutable local artifacts. Credentials and provider bodies are never printed.\n',
    )
    process.exitCode = 1
  }
}
