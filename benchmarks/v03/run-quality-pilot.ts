import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs, parseEnv } from 'node:util'
import { pathToFileURL } from 'node:url'
import type { DecisionPort, PixelRect } from '../../src/entities/contracts.js'
import { ClassifierError } from '../../src/entities/errors.js'
import { createClassifier } from '../../src/app/create-classifier.js'
import { createOpenRouterDecisions } from '../../src/infrastructure/openrouter.js'
import { RunBudget } from '../v02/budget.js'
import { freshProducerTask, loadFreshImage } from '../v02/fresh-corpus.js'
import type { FreshCase } from '../v02/fresh-corpus.js'
import { createNativeCategoricalPresencePort } from '../v02/native-categorical-presence-port.js'
import { hashCanonical } from '../v02/protocol.js'
import { recordProvider } from '../v02/recording.js'
import {
  assertRecorderHealthy,
  regionSeededProducerSourceManifest,
} from '../v02/region-seeded-runner.js'
import { loadV03PilotCorpus } from './pilot-manifest.js'
import { locateWithZoom } from './zoom-locator.js'

export type PilotProfile = 'v02-presence-region' | 'v03-zoom-region'
const profiles: PilotProfile[] = ['v02-presence-region', 'v03-zoom-region']
const route = Object.freeze({
  model: 'openai/gpt-6-luna-decisions',
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: '/api/alpha/decisions',
  allowFallbacks: false as const,
})
const policy = Object.freeze({
  purpose: 'DEV seed-localization screen only; no whole-object qualification',
  timeoutMs: 120_000,
  maxCallsPerCase: 4,
  maxPhysicalCalls: 96,
  maxCostUsd: 5,
  unknownReserveUsd: 0.05,
  concurrency: 1,
  retry: 0,
  nativePresence: 'categorical wrapper, identical for both recipes',
  schedule: 'alternate baseline-first and candidate-first by manifest index',
})

interface SeedRecord {
  status: 'located' | 'unknown' | 'not-found' | 'failed'
  region?: PixelRect
  sourceWidth?: number
  sourceHeight?: number
}
export interface PilotRow {
  caseId: string
  imageSha256: string
  classify: { status: 'skipped' | 'classified' | 'failed'; choice?: string }
  extraction: {
    status: SeedRecord['status']
    reason?: string
    seed: SeedRecord
    durationMs: number
    errorCode?: string
  }
  diagnostic: unknown
}

function code(error: unknown): string {
  return error instanceof ClassifierError ? error.code : 'PILOT_ERROR'
}

/** No labels, truth, case identity or image paths are forwarded to the model. */
export async function runPilotCase(
  item: FreshCase,
  image: Uint8Array,
  profile: PilotProfile,
  decision: DecisionPort,
  signal: AbortSignal,
): Promise<PilotRow> {
  const started = performance.now()
  const task = freshProducerTask(item)
  const target = task.instruction ? `${task.target}\n${task.instruction}` : task.target
  let classify: PilotRow['classify'] = { status: 'skipped' }
  const api = createClassifier({
    decision,
    timeoutMs: policy.timeoutMs,
    concurrency: 1,
    maxQueue: 0,
  })
  try {
    if (profile === 'v02-presence-region') {
      try {
        const result = await api.classify({
          input: { image },
          classes: [
            { id: 'present', description: 'The target in the question is visible in this image.' },
            {
              id: 'absent',
              description: 'The target in the question is not visible in this image.',
            },
          ],
          instructions: `${task.question}\n\nUse only the supplied image. Choose exactly one closed label.`,
          signal,
        })
        classify = { status: 'classified', choice: result.choice }
        if (result.choice === 'absent') {
          return {
            caseId: item.caseId,
            imageSha256: item.image.sha256,
            classify,
            extraction: {
              status: 'not-found',
              reason: 'classification-absent',
              seed: { status: 'not-found' },
              durationMs: performance.now() - started,
            },
            diagnostic: result,
          }
        }
      } catch (error) {
        classify = { status: 'failed' }
        throw error
      }
    }
    const result =
      profile === 'v03-zoom-region'
        ? await locateWithZoom({ image, target, signal }, { decision })
        : await api.locate({ image, target, mode: 'region', signal })
    const region =
      result.status === 'located'
        ? 'sourceRegion' in result
          ? result.sourceRegion
          : result.region
        : undefined
    return {
      caseId: item.caseId,
      imageSha256: item.image.sha256,
      classify,
      extraction: {
        status: result.status,
        ...('reason' in result ? { reason: result.reason } : {}),
        seed: {
          status: result.status,
          ...(region
            ? {
                region: { ...region },
                sourceWidth: item.image.width,
                sourceHeight: item.image.height,
              }
            : {}),
        },
        durationMs: performance.now() - started,
      },
      diagnostic: result,
    }
  } catch (error) {
    return {
      caseId: item.caseId,
      imageSha256: item.image.sha256,
      classify,
      extraction: {
        status: 'failed',
        seed: { status: 'failed' },
        durationMs: performance.now() - started,
        errorCode: code(error),
      },
      diagnostic: null,
    }
  } finally {
    await api.dispose()
  }
}

async function immutable(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

async function sourceManifest(): Promise<Record<string, string>> {
  const historical = await regionSeededProducerSourceManifest()
  for (const path of ['./run-quality-pilot.ts', './zoom-locator.ts', './pilot-manifest.ts']) {
    historical[`v03/${path}`] = createHash('sha256')
      .update(await readFile(new URL(path, import.meta.url)))
      .digest('hex')
  }
  return historical
}

async function main(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      'allow-paid': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'image-root': {
        type: 'string',
        default: '/root/work/zorya-classifier-worktrees/v02/corpus',
      },
      'env-file': { type: 'string', default: '/root/work/element/.env.local' },
      out: { type: 'string', default: '.run/v03/zoom-pilot' },
    },
  })
  if (values['allow-paid'] === values['dry-run'])
    throw new TypeError('Choose --dry-run or --allow-paid')
  const controller = new AbortController()
  const onInterrupt = () => controller.abort(new ClassifierError('ABORTED', 'Pilot interrupted'))
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onInterrupt)
  try {
    const corpus = await loadV03PilotCorpus(resolve(values['image-root']), controller.signal)
    if (corpus.cases.length !== 12) throw new TypeError('Frozen pilot must have twelve cases')
    // Validate every pinned image before the first paid dispatch.
    for (const item of corpus.cases)
      (await loadFreshImage(item, corpus.imageRoot, controller.signal)).fill(0)
    const sourceBefore = await sourceManifest()
    const runId = `zoom-seed-pilot-${new Date().toISOString().replaceAll(/[:.]/gu, '')}-${randomUUID().slice(0, 8)}`
    const directory = resolve(values.out, runId)
    await mkdir(directory, { recursive: true })
    await immutable(join(directory, 'run-manifest.json'), {
      runId,
      phase: 'dev',
      profiles,
      policy,
      route,
      sourceFiles: sourceBefore,
      sourceSha256: hashCanonical(sourceBefore),
      corpus: corpus.manifests,
      plannedCaseIds: corpus.cases.map((row) => row.caseId),
      imageHashes: corpus.cases.map((row) => ({ caseId: row.caseId, sha256: row.image.sha256 })),
      paid: values['allow-paid'],
    })
    console.log(JSON.stringify({ runId, directory, paid: values['allow-paid'] }))
    if (!values['allow-paid']) return
    const env = parseEnv(await readFile(resolve(values['env-file']), 'utf8'))
    const credential = env.OPENROUTER_API_KEY
    if (!credential) throw new TypeError('Explicit environment file has no OpenRouter key')
    const budget = new RunBudget(
      policy.maxPhysicalCalls,
      policy.maxCostUsd,
      policy.unknownReserveUsd,
    )
    const results: Record<PilotProfile, PilotRow[]> = {
      'v02-presence-region': [],
      'v03-zoom-region': [],
    }
    let failure: string | null = null
    for (const [index, item] of corpus.cases.entries()) {
      const schedule = index % 2 === 0 ? profiles : [...profiles].reverse()
      for (const profile of schedule) {
        if (controller.signal.aborted) break
        const caseDirectory = join(directory, profile, item.caseId)
        await mkdir(caseDirectory, { recursive: true })
        const recorder = recordProvider(
          (fetch) =>
            createOpenRouterDecisions({
              apiKey: credential,
              model: route.model,
              provider: route.provider,
              providerName: route.providerName,
              fetch,
            }),
          budget,
          join(caseDirectory, 'calls'),
          route,
        )
        const local = new AbortController()
        const relay = () => local.abort(controller.signal.reason)
        if (controller.signal.aborted) relay()
        else controller.signal.addEventListener('abort', relay, { once: true })
        const timer = setTimeout(
          () => local.abort(new ClassifierError('TIMEOUT', 'Pilot case deadline')),
          policy.timeoutMs,
        )
        let image: Uint8Array | undefined
        try {
          image = await loadFreshImage(item, corpus.imageRoot, local.signal)
          const decision = createNativeCategoricalPresencePort({
            async decide(request, signal) {
              if (recorder.logicalCalls.length >= policy.maxCallsPerCase)
                throw new ClassifierError('RESOURCE_LIMIT', 'Pilot case call bound exceeded')
              return recorder.port.decide(request, signal)
            },
          })
          const row = await runPilotCase(item, image, profile, decision, local.signal)
          assertRecorderHealthy(recorder)
          await immutable(join(caseDirectory, 'result.json'), row)
          results[profile].push(row)
          console.log(
            JSON.stringify({
              profile,
              caseId: item.caseId,
              status: row.extraction.status,
              reason: row.extraction.reason,
              calls: recorder.calls.length,
              durationMs: Math.round(row.extraction.durationMs),
            }),
          )
        } catch (error) {
          failure = code(error)
          controller.abort(error)
        } finally {
          clearTimeout(timer)
          controller.signal.removeEventListener('abort', relay)
          image?.fill(0)
        }
      }
      if (controller.signal.aborted) break
    }
    const sourceAfter = await sourceManifest()
    const sourceUnchanged = hashCanonical(sourceBefore) === hashCanonical(sourceAfter)
    for (const profile of profiles) {
      const completedCaseIds = results[profile].map((row) => row.caseId)
      const plannedCaseIds = corpus.cases.map((row) => row.caseId)
      await mkdir(join(directory, profile), { recursive: true })
      await immutable(join(directory, profile, 'summary.json'), {
        runId,
        profileId: profile,
        phase: 'dev',
        purpose: policy.purpose,
        status:
          !failure && sourceUnchanged && completedCaseIds.length === plannedCaseIds.length
            ? 'complete'
            : 'incomplete',
        plannedCaseIds,
        completedCaseIds,
        missingCaseIds: plannedCaseIds.filter((id) => !completedCaseIds.includes(id)),
        results: results[profile],
        sourceUnchanged,
        sourceAfterSha256: hashCanonical(sourceAfter),
        failure,
      })
    }
    await immutable(join(directory, 'accounting.json'), {
      ...budget.snapshot(),
      failure,
      sourceUnchanged,
    })
    if (failure || !sourceUnchanged) throw new Error('Pilot incomplete; inspect preserved evidence')
  } finally {
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onInterrupt)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error('v03 pilot failed; inspect its immutable receipts. Credentials are not logged.')
    process.exitCode = 1
  })
}
