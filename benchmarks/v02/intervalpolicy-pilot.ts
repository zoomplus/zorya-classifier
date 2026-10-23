import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Classifier } from '../../src/app/create-classifier.js'
import type { DecisionPort } from '../../src/entities/contracts.js'
import type { BoundaryViewPort } from '../../src/entities/boundary-view.js'
import type { WholeObjectIntervalPolicy } from '../../src/processes/whole-object.js'
import { hashCanonical, inputManifestSchema } from './protocol.js'
import type { ProducerManifest } from './protocol.js'
import { RunBudget } from './budget.js'
import type { SeedOutlinePilotOptions } from './seedoutlinepilot.js'
import { runSeedOutlinePilot } from './seedoutlinepilot.js'
import { appendRuntimeSourceFiles } from '../runtime-source-files.js'

export const intervalPolicyVariants = Object.freeze([
  Object.freeze({ id: 'seed-outline-fixed-16-v1', intervalPolicy: 'fixed-16-v1' as const }),
  Object.freeze({
    id: 'seed-outline-tolerance-aware-v1',
    intervalPolicy: 'tolerance-aware-v1' as const,
  }),
])

export const intervalPolicyPilotPolicy = Object.freeze({
  promptId: 'seed-unbounded-v1',
  presentationId: 'original-seed-outline-v1',
  tolerancePx: 8,
  maxExtentPasses: 3,
  timeoutMs: 45000,
  retries: 0,
  fallback: false,
  maxPhysicalCalls: 64,
  maxCostUsd: 2,
  unknownCostReserveUsd: 0.04,
  latencyEnvironment: 'concurrent-with-linux-native-soak',
  latencyRankingEligible: false,
})

const manifestUrl = new URL('./input-manifest.json', import.meta.url)

export interface IntervalPolicyPilotOptions
  extends Omit<SeedOutlinePilotOptions, 'intervalPolicy' | 'sharedBudget' | 'variantId'> {
  composeClassifier: (
    decision: DecisionPort,
    boundaryView: BoundaryViewPort,
    intervalPolicy: WholeObjectIntervalPolicy,
  ) => Classifier
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function writeImmutable(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}

/** Paired, native-only exposed Car/Boat comparison; no evaluator data enters either producer. */
export async function runIntervalPolicyPilot(options: IntervalPolicyPilotOptions) {
  const manifest: ProducerManifest = inputManifestSchema.parse(
    JSON.parse(await readFile(manifestUrl, 'utf8')),
  )
  const sourcePathPrefix = [
    './intervalpolicy-pilot.ts',
    './run-interval-policy-pilot.ts',
    './seedoutlinepilot.ts',
    './seedoutlinepresentation.ts',
    './seedunboundedprompt.ts',
    './protocol.ts',
    './recording.ts',
    './budget.ts',
    '../../src/app/create-classifier.ts',
    '../../src/entities/whole-object.ts',
    '../../src/entities/boundary-view.ts',
    '../../src/processes/whole-object.ts',
    '../../src/processes/boundary-state.ts',
    '../../src/processes/locate.ts',
    '../../src/features/prompts.ts',
    '../../src/features/choice.ts',
    '../../src/features/choice-beam-layout.ts',
    '../../src/features/uniform-grid.ts',
    '../../src/infrastructure/openrouter.ts',
    '../experiments/boundary-view.ts',
    '../experiments/create-research-classifier.ts',
  ] as const
  const sourcePaths = await appendRuntimeSourceFiles(sourcePathPrefix, import.meta.url)
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => {
        const bytes = await readFile(new URL(path, import.meta.url))
        return [path, sha256(bytes)] as const
      }),
    ),
  )
  const route = Object.freeze({
    id: 'native-luna-openai-decisions-v1',
    model: 'openai/gpt-6-luna-decisions',
    provider: 'openai',
    providerName: 'OpenAI',
    apiEndpoint: '/api/alpha/decisions',
    allowFallbacks: false,
  })
  const variantSha256 = hashCanonical({
    route,
    variants: intervalPolicyVariants,
    policy: intervalPolicyPilotPolicy,
    sourceHashes: Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)),
  })
  const runId = `v02-interval-policy-paired-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const budget = new RunBudget(
    intervalPolicyPilotPolicy.maxPhysicalCalls,
    intervalPolicyPilotPolicy.maxCostUsd,
    intervalPolicyPilotPolicy.unknownCostReserveUsd,
  )
  await writeImmutable(resolve(outputDirectory, 'run-manifest.json'), {
    schemaVersion: 1,
    runId,
    purpose: 'paired native Luna exposed Car/Boat interval partition diagnostic',
    startedAt: new Date().toISOString(),
    variantId: 'seed-outline-interval-policy-pair-v1',
    variantSha256,
    sourceHashes,
    producerSourceSha256: hashCanonical(
      Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)),
    ),
    sourceManifestSha256: hashCanonical(manifest),
    selectedCaseIds: ['photo-dev-02', 'photo-dev-03'],
    route,
    variants: intervalPolicyVariants,
    policy: intervalPolicyPilotPolicy,
    modelBoundary: { evaluatorTruthRead: false, retries: 0, fallback: false },
  })

  const runs: Array<{ status: string; [key: string]: unknown }> = []
  for (const variant of intervalPolicyVariants) {
    const result = await runSeedOutlinePilot({
      ...options,
      outputRoot: resolve(outputDirectory, variant.id),
      intervalPolicy: variant.intervalPolicy,
      variantId: variant.id,
      sharedBudget: budget,
    })
    runs.push({
      variantId: variant.id,
      intervalPolicy: variant.intervalPolicy,
      runId: result.runId,
      status: result.status,
      outcomes: result.outcomes,
      requestHashes: result.physicalReceipts.map((call) => call.requestSha256),
      receiptCount: result.physicalReceipts.length,
    })
  }
  const summary = {
    runId,
    variantId: 'seed-outline-interval-policy-pair-v1',
    variantSha256,
    status: runs.every((run) => run.status === 'complete') ? 'complete' : 'incomplete',
    runs,
    aggregate: budget.snapshot(),
    latencyEnvironment: intervalPolicyPilotPolicy.latencyEnvironment,
    latencyRankingEligible: false,
  }
  await writeImmutable(resolve(outputDirectory, 'summary.json'), summary)
  await writeImmutable(resolve(outputDirectory, 'run-complete.json'), {
    runId,
    completedAt: new Date().toISOString(),
    summarySha256: sha256(JSON.stringify(summary)),
  })
  return { ...summary, outputDirectory }
}
