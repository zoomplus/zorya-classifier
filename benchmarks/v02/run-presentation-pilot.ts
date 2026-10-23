import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { parseEnv } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createClassifier } from '../../src/app/create-classifier.js'
import { createResearchClassifier } from '../experiments/create-research-classifier.js'
import { createSharpBoundaryView } from '../experiments/boundary-view.js'
import { presentationVariants } from './presentationvariants.js'
import { runPresentationPilot } from './presentationpilot.js'
import type { PresentationPilotOptions } from './presentationpilot.js'

const keyFile = '/root/work/element/.env.local'
export function parsePresentationPilotArgs(args: readonly string[]) {
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
  const parsed = parseEnv(await readFile(keyFile, 'utf8'))
  const key = parsed.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY is absent from configured private environment')
  return key
}

async function rendererHash(): Promise<string> {
  const bytes = await readFile(new URL('../experiments/boundary-view.ts', import.meta.url))
  return createHash('sha256').update(bytes).digest('hex')
}

async function runFromCommandLine(args: readonly string[]) {
  const options = parsePresentationPilotArgs(args)
  const apiKey = await readOpenRouterKey()
  const boundaryView = createSharpBoundaryView()
  const rendererSha256 = await rendererHash()
  const composeClassifier: PresentationPilotOptions['composeClassifier'] = (
    decision,
    variantId,
    boundary,
    timeoutMs = presentationVariants[variantId].timeoutMs,
  ) => {
    const classifierOptions = {
      decision,
      timeoutMs,
      concurrency: 1,
      maxQueue: 0,
    }
    if (variantId === 'numeric-v1') return createClassifier(classifierOptions)
    if (!boundary) throw new TypeError('axis-rulers-v1 requires a boundary renderer')
    return createResearchClassifier(classifierOptions, undefined, boundary)
  }
  return runPresentationPilot({
    ...options,
    apiKey,
    ...(boundaryView === undefined ? {} : { boundaryView }),
    ...(rendererSha256 === undefined ? {} : { rendererSha256 }),
    composeClassifier,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runFromCommandLine(process.argv.slice(2))
    process.stdout.write(
      JSON.stringify({
        runId: result.runId,
        status: result.status,
        comparisonId: result.comparisonId,
        aggregate: result.aggregate,
        latency: result.latency,
        outputDirectory: result.outputDirectory,
      }) + '\n',
    )
    if (result.status !== 'complete') process.exitCode = 1
  } catch {
    process.stderr.write(
      'Presentation pilot stopped; inspect immutable local artifacts. Credentials and provider bodies are never printed.\n',
    )
    process.exitCode = 1
  }
}
