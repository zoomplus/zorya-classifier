import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'
import sharp from 'sharp'
import type { DecisionPort, DecisionRequest } from '../../src/entities/contracts.js'
import type { WholeObjectLocalizationResult } from '../../src/entities/whole-object.js'
import { createClassifier, createResearchClassifier } from '../../src/app/create-classifier.js'
import { createOpenRouterText } from '../../src/infrastructure/openrouter-vision.js'
import { createOpenRouterDecisions } from '../../src/infrastructure/openrouter.js'
import { createTextRepresentation } from '../../src/infrastructure/text-representation.js'
import { textEncodersV1 } from '../experiments/text-encoders-v1.js'
import { RunBudget } from './budget.js'
import { inputManifestSchema, hashCanonical, modelRequestManifest } from './protocol.js'
import type { ProducerCase, ProducerManifest } from './protocol.js'
import { recordProvider } from './recording.js'
import type { PhysicalCallRecord, Recorder } from './recording.js'
import { applyPromptVariant, promptVariants } from './promptvariants.js'
import type { PromptVariantId } from './promptvariants.js'
import { textTransportVariants } from './transportvariants.js'
import type { TransportVariantId } from './transportvariants.js'

const sourceManifestPath = new URL('./input-manifest.json', import.meta.url)
const apiKeyPath = '/root/work/element/.env.local'
const routeTable = {
  togetherText: {
    model: 'deepseek/deepseek-v4.1-flash',
    provider: 'together',
    providerName: 'Together',
    apiEndpoint: '/api/v1/chat/completions',
    allowFallbacks: false as const,
  },
  lunaVision: {
    model: 'openai/gpt-6-luna-decisions',
    provider: 'openai',
    providerName: 'OpenAI',
    apiEndpoint: '/api/alpha/decisions',
    allowFallbacks: false as const,
  },
}

export interface DiagnosticRunOptions {
  imageRoot: string
  outputRoot: string
  maxPhysicalCalls: number
  maxCostUsd: number
  promptVariant: PromptVariantId
  transportVariant: TransportVariantId
  caseLimit: 2 | 4
}

interface StageRecord {
  status: 'ok' | 'unknown' | 'not-found' | 'failed'
  durationMs: number
  value?:
    | string
    | WholeObjectLocalizationResult['status']
    | {
        status: WholeObjectLocalizationResult['status']
        region?: { left: number; top: number; width: number; height: number }
        reason?: string
        completeness?: string
      }
  errorCode?: string
  calls: number
}

interface CaseRecord {
  caseId: string
  imageSha256: string
  encoder: string
  route: 'together-text' | 'openai-vision' | 'no-image-control'
  classify: StageRecord
  locate: StageRecord
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function writeImmutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, { flag: 'wx' })
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code
  return 'RUNNER_FAILURE'
}

async function loadManifest(): Promise<ProducerManifest> {
  return inputManifestSchema.parse(JSON.parse(await readFile(sourceManifestPath, 'utf8')))
}

async function loadImage(input: ProducerCase, imageRoot: string) {
  const path = resolve(imageRoot, input.image.path)
  const rel = relative(resolve(imageRoot), path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Image escaped the configured root')
  const bytes = new Uint8Array(await readFile(path))
  const digest = sha256(bytes)
  if (digest !== input.image.sha256) throw new Error(`Source hash mismatch for ${input.caseId}`)
  const metadata = await sharp(bytes, { limitInputPixels: 20_000_000 }).metadata()
  if (metadata.width !== input.image.width || metadata.height !== input.image.height)
    throw new Error(`Source dimensions mismatch for ${input.caseId}`)
  return { bytes, digest }
}

async function openRouterKey(): Promise<string> {
  const parsed = parseEnv(await readFile(apiKeyPath, 'utf8'))
  const key = parsed.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY is absent from the configured private env file')
  return key
}

function makeProvider(
  apiKey: string,
  route: typeof routeTable.togetherText,
  maxOutputTokens: 1024 | 4096,
  fetch: typeof globalThis.fetch,
  transportVariant: TransportVariantId = 'low-json-schema',
): DecisionPort {
  const transport = textTransportVariants[transportVariant]
  return createOpenRouterText({
    apiKey,
    model: route.model,
    provider: route.provider,
    providerName: route.providerName,
    responseFormat: transport.responseFormat,
    maxOutputTokens,
    reasoningEffort: transport.reasoningEffort,
    fetch,
  })
}

export function createTextProviderForVariant(
  apiKey: string,
  maxOutputTokens: 1024 | 4096,
  fetch: typeof globalThis.fetch,
  transportVariant: TransportVariantId,
): DecisionPort {
  return makeProvider(apiKey, routeTable.togetherText, maxOutputTokens, fetch, transportVariant)
}

export function createLunaDecisionProvider(
  apiKey: string,
  fetch: typeof globalThis.fetch,
): DecisionPort {
  return createOpenRouterDecisions({
    apiKey,
    model: routeTable.lunaVision.model,
    provider: routeTable.lunaVision.provider,
    providerName: routeTable.lunaVision.providerName,
    fetch,
  })
}

function transformedPort(
  recorder: Recorder,
  promptVariant?: PromptVariantId,
): DecisionPort & { __recorder: Recorder } {
  return {
    decide(request, signal) {
      const withVariant =
        promptVariant === undefined
          ? request
          : (applyPromptVariant(request, promptVariants[promptVariant]) as DecisionRequest)
      return recorder.port.decide(withVariant, signal)
    },
    __recorder: recorder,
  }
}

function newRecorder(
  providerFactory: (fetch: typeof globalThis.fetch) => DecisionPort,
  budget: RunBudget,
  directory: string,
  route: typeof routeTable.togetherText | typeof routeTable.lunaVision,
) {
  return recordProvider(providerFactory, budget, directory, route)
}

async function classify(
  bytes: Uint8Array,
  target: string,
  decision: DecisionPort,
  imageRepresentation?: ReturnType<typeof createTextRepresentation>,
): Promise<{ stage: StageRecord; calls: PhysicalCallRecord[] }> {
  const recorder = decision as DecisionPort & { __recorder: Recorder }
  const start = performance.now()
  const classifier = imageRepresentation
    ? createResearchClassifier({ decision }, imageRepresentation)
    : createClassifier({ decision })
  try {
    const result = await classifier.classify({
      input: {
        image: bytes,
        text: `Does this image contain a visible physical instance of ${target}?`,
      },
      classes: [
        {
          id: 'present',
          description: 'At least one visible physical instance of the named target is present.',
        },
        {
          id: 'absent',
          description: 'No visible physical instance of the named target is present.',
        },
      ],
      instructions: 'Choose exactly one closed class. Do not infer from external context.',
      ...(imageRepresentation
        ? {
            representation: {
              type: 'experimental-text' as const,
              profile: 'text-image-v1' as const,
            },
          }
        : {}),
    })
    return {
      stage: {
        status: 'ok',
        durationMs: performance.now() - start,
        value: result.choice,
        calls: recorder.__recorder.calls.length,
      },
      calls: recorder.__recorder.calls,
    }
  } catch (error) {
    return {
      stage: {
        status: 'failed',
        durationMs: performance.now() - start,
        errorCode: safeErrorCode(error),
        calls: recorder.__recorder.calls.length,
      },
      calls: recorder.__recorder.calls,
    }
  } finally {
    await classifier.dispose()
  }
}

async function locate(
  bytes: Uint8Array,
  target: string,
  decision: DecisionPort,
  imageRepresentation?: ReturnType<typeof createTextRepresentation>,
): Promise<{ stage: StageRecord; calls: PhysicalCallRecord[] }> {
  const recorder = decision as DecisionPort & { __recorder: Recorder }
  const start = performance.now()
  const classifier = imageRepresentation
    ? createResearchClassifier({ decision, concurrency: 1, maxQueue: 0 }, imageRepresentation)
    : createClassifier({ decision, concurrency: 1, maxQueue: 0 })
  try {
    const result = (await classifier.locate({
      image: bytes,
      target,
      mode: 'whole-object',
      boxTolerancePx: 8,
      maxExtentPasses: 3,
      ...(imageRepresentation
        ? {
            representation: {
              type: 'experimental-text' as const,
              profile: 'text-image-v1' as const,
            },
          }
        : {}),
    })) as WholeObjectLocalizationResult
    return {
      stage: {
        status: result.status === 'located' ? 'ok' : result.status,
        durationMs: performance.now() - start,
        value:
          result.status === 'located'
            ? { status: result.status, region: result.region, completeness: result.completeness }
            : { status: result.status, ...('reason' in result ? { reason: result.reason } : {}) },
        calls:
          result.status === 'located'
            ? result.metadata.stages.length
            : 'metadata' in result
              ? result.metadata.stages.length
              : 0,
      },
      calls: recorder.__recorder.calls,
    }
  } catch (error) {
    return {
      stage: {
        status: 'failed',
        durationMs: performance.now() - start,
        errorCode: safeErrorCode(error),
        calls: recorder.__recorder.calls.length,
      },
      calls: recorder.__recorder.calls,
    }
  } finally {
    await classifier.dispose()
  }
}

function noImageRequest(kind: 'classify' | 'locate', target: string): DecisionRequest {
  return {
    state: [
      'NO IMAGE, IMAGE URL, PIXELS, OR TEXTUAL IMAGE REPRESENTATION IS PROVIDED.',
      `Task: ${kind === 'classify' ? 'closed-set presence classification' : 'whole-object location feasibility'} for the target ${target}.`,
      'With no visual data, do not guess. Select unknown if the available closed answers do not permit a supported determination.',
    ],
    questions:
      kind === 'classify'
        ? {
            classification: {
              type: 'choice',
              rankingSize: 1,
              instructions: 'Does the target appear? Choose one or unknown.',
              criteria: {
                present: 'At least one visible target is present.',
                absent: 'No visible target is present.',
                unknown: 'No visual data is available or evidence is insufficient.',
              },
            },
          }
        : {
            location: {
              type: 'choice',
              rankingSize: 1,
              instructions:
                'Can the visible bounds be determined from supplied evidence? Choose unknown if not.',
              criteria: {
                located: 'A supported source-space visible-object extent is available.',
                unknown: 'No image evidence is available to locate the target.',
              },
            },
          },
  }
}

async function noImageControl(
  target: string,
  kind: 'classify' | 'locate',
  providerFactory: (fetch: typeof globalThis.fetch) => DecisionPort,
  budget: RunBudget,
  directory: string,
): Promise<{ stage: StageRecord; calls: PhysicalCallRecord[] }> {
  const route = routeTable.togetherText
  const recorder = newRecorder(providerFactory, budget, directory, route)
  const started = performance.now()
  try {
    const result = await recorder.port.decide(
      noImageRequest(kind, target),
      new AbortController().signal,
    )
    const answer = result.answers[kind === 'classify' ? 'classification' : 'location']
    const choice =
      answer?.type === 'choice'
        ? answer.choice
        : answer?.type === 'ranked-choice'
          ? answer.ranking[0]
          : undefined
    return {
      stage: {
        status: 'ok',
        durationMs: performance.now() - started,
        value: choice ?? 'unknown',
        calls: recorder.calls.length,
      },
      calls: recorder.calls,
    }
  } catch (error) {
    return {
      stage: {
        status: 'failed',
        durationMs: performance.now() - started,
        errorCode: safeErrorCode(error),
        calls: recorder.calls.length,
      },
      calls: recorder.calls,
    }
  }
}

export async function runDiagnostic(options: DiagnosticRunOptions) {
  const manifest = await loadManifest()
  const selectedCases =
    options.caseLimit === 2 ? [manifest.cases[0]!, manifest.cases.at(-1)!] : manifest.cases
  const selectedVariant = promptVariants[options.promptVariant]
  const ids = [
    'ascii-luma-v1',
    'palette-grid-v1',
    'svg-contours-v1',
    'pixel-rle-v1',
    'ascii-contours-v1',
    'ascii-svg-layered-v1',
  ] as const
  const runId = `v02-diagnostic-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(outputDirectory, { recursive: false })
  const budget = new RunBudget(options.maxPhysicalCalls, options.maxCostUsd)
  const apiKey = await openRouterKey()
  const manifestHash = hashCanonical(manifest)
  const manifestRecord = {
    schemaVersion: 1,
    runId,
    purpose: 'old-exposed-development diagnostic; not fresh qualification',
    startedAt: new Date().toISOString(),
    sourceManifestSha256: manifestHash,
    selectedCaseIds: selectedCases.map((item) => item.caseId),
    promptVariant: options.promptVariant,
    promptVariantSha256: hashCanonical(selectedVariant),
    transportVariant: options.transportVariant,
    transportVariantSha256: hashCanonical(textTransportVariants[options.transportVariant]),
    routeTable,
    limits: {
      maxPhysicalCalls: options.maxPhysicalCalls,
      maxCostUsd: options.maxCostUsd,
      outputTokens: { classify: 1024, locate: 4096 },
      retries: 0,
      fallback: false,
    },
    modelBoundary: { ...modelRequestManifest, sourceCaseIdsAndPathsAreProducerLocalOnly: true },
  }
  await writeImmutable(
    join(outputDirectory, 'run-manifest.json'),
    JSON.stringify(manifestRecord, null, 2) + '\n',
  )
  const results: CaseRecord[] = []
  const allCalls: PhysicalCallRecord[] = []
  for (const input of selectedCases) {
    const { bytes, digest } = await loadImage(input, options.imageRoot)
    const candidates: {
      encoder: string
      route: CaseRecord['route']
      kind: 'text' | 'vision' | 'no-image'
    }[] = [
      ...ids.map((encoder) => ({
        encoder,
        route: 'together-text' as const,
        kind: 'text' as const,
      })),
      { encoder: 'native-vision-control', route: 'openai-vision', kind: 'vision' },
      { encoder: 'no-image-control', route: 'no-image-control', kind: 'no-image' },
    ]
    for (const candidate of candidates) {
      const candidateDirectory = join(outputDirectory, candidate.encoder, input.caseId)
      await mkdir(candidateDirectory, { recursive: true })
      if (candidate.kind === 'no-image') {
        const p1 = (fetch: typeof globalThis.fetch) =>
          makeProvider(apiKey, routeTable.togetherText, 1024, fetch, options.transportVariant)
        const c = await noImageControl(
          input.target,
          'classify',
          p1,
          budget,
          join(candidateDirectory, 'classify'),
        )
        const p2 = (fetch: typeof globalThis.fetch) =>
          makeProvider(apiKey, routeTable.togetherText, 4096, fetch, options.transportVariant)
        const l = await noImageControl(
          input.target,
          'locate',
          p2,
          budget,
          join(candidateDirectory, 'locate'),
        )
        allCalls.push(...c.calls, ...l.calls)
        results.push({
          caseId: input.caseId,
          imageSha256: digest,
          encoder: candidate.encoder,
          route: candidate.route,
          classify: c.stage,
          locate: l.stage,
        })
        continue
      }
      const route = candidate.kind === 'vision' ? routeTable.lunaVision : routeTable.togetherText
      const classifyProvider = (fetch: typeof globalThis.fetch) =>
        candidate.kind === 'vision'
          ? createLunaDecisionProvider(apiKey, fetch)
          : makeProvider(apiKey, routeTable.togetherText, 1024, fetch, options.transportVariant)
      const classifyRecorder = newRecorder(
        classifyProvider,
        budget,
        join(candidateDirectory, 'classify'),
        route,
      )
      const classifyPort = transformedPort(
        classifyRecorder,
        candidate.kind === 'text' ? options.promptVariant : undefined,
      )
      const representation =
        candidate.kind === 'text'
          ? createTextRepresentation(textEncodersV1[candidate.encoder]!)
          : undefined
      const c = await classify(bytes, input.target, classifyPort, representation)
      allCalls.push(...classifyRecorder.calls)

      const locateProvider = (fetch: typeof globalThis.fetch) =>
        candidate.kind === 'vision'
          ? createLunaDecisionProvider(apiKey, fetch)
          : makeProvider(apiKey, routeTable.togetherText, 4096, fetch, options.transportVariant)
      const locateRecorder = newRecorder(
        locateProvider,
        budget,
        join(candidateDirectory, 'locate'),
        route,
      )
      const locatePort = transformedPort(
        locateRecorder,
        candidate.kind === 'text' ? options.promptVariant : undefined,
      )
      const l = await locate(bytes, input.target, locatePort, representation)
      allCalls.push(...locateRecorder.calls)
      results.push({
        caseId: input.caseId,
        imageSha256: digest,
        encoder: candidate.encoder,
        route: candidate.route,
        classify: c.stage,
        locate: l.stage,
      })
      await writeImmutable(
        join(candidateDirectory, 'outcome.json'),
        JSON.stringify(
          {
            caseId: input.caseId,
            encoder: candidate.encoder,
            route: candidate.route,
            sourceSha256: digest,
            classify: c.stage,
            locate: l.stage,
          },
          null,
          2,
        ) + '\n',
      )
    }
  }
  const summary = {
    runId,
    status: budget.snapshot().inFlightCalls === 0 ? 'complete' : 'incomplete',
    caseCount: selectedCases.length,
    resultCount: results.length,
    results,
    aggregate: budget.snapshot(),
    latency: latencySummary(allCalls.map((call) => call.durationMs)),
    routeReceipts: allCalls.map((call) => ({
      route: call.route,
      receipt: call.receipt,
      errorCode: call.errorCode,
      durationMs: call.durationMs,
    })),
  }
  await writeImmutable(
    join(outputDirectory, 'summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  )
  await writeImmutable(
    join(outputDirectory, 'run-complete.json'),
    JSON.stringify({ endedAt: new Date().toISOString(), aggregate: budget.snapshot() }, null, 2) +
      '\n',
  )
  return { ...summary, outputDirectory }
}

export async function runTransportProbe(options: {
  imageRoot: string
  outputRoot: string
  maxPhysicalCalls: 1
  maxCostUsd: number
  promptVariant: PromptVariantId
  transportVariant: TransportVariantId
}) {
  if (options.maxCostUsd > 0.1) throw new RangeError('Transport probe budget cannot exceed $0.10')
  const manifest = await loadManifest()
  const input = manifest.cases[0]!
  const selectedPrompt = promptVariants[options.promptVariant]
  const selectedTransport = textTransportVariants[options.transportVariant]
  const runId = `v02-transport-probe-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const callDirectory = join(outputDirectory, 'ascii-luma-v1', input.caseId, 'classify')
  await mkdir(callDirectory, { recursive: true })
  const budget = new RunBudget(options.maxPhysicalCalls, options.maxCostUsd)
  const apiKey = await openRouterKey()
  const manifestRecord = {
    schemaVersion: 1,
    runId,
    purpose: 'one-call exposed-development transport probe; not qualification',
    sourceManifestSha256: hashCanonical(manifest),
    selectedCaseId: input.caseId,
    encoder: 'ascii-luma-v1',
    promptVariant: options.promptVariant,
    promptVariantSha256: hashCanonical(selectedPrompt),
    transportVariant: options.transportVariant,
    transportVariantSha256: hashCanonical(selectedTransport),
    route: routeTable.togetherText,
    limits: {
      maxPhysicalCalls: options.maxPhysicalCalls,
      maxCostUsd: options.maxCostUsd,
      maxOutputTokens: 1024,
    },
    modelBoundary: { ...modelRequestManifest, sourceCaseIdsAndPathsAreProducerLocalOnly: true },
  }
  await writeImmutable(
    join(outputDirectory, 'run-manifest.json'),
    JSON.stringify(manifestRecord, null, 2) + '\n',
  )
  const recorder = newRecorder(
    (fetch) => makeProvider(apiKey, routeTable.togetherText, 1024, fetch, options.transportVariant),
    budget,
    callDirectory,
    routeTable.togetherText,
  )
  const port = transformedPort(recorder, options.promptVariant)
  const { bytes, digest } = await loadImage(input, options.imageRoot)
  const stageResult = await classify(
    bytes,
    input.target,
    port,
    createTextRepresentation(textEncodersV1['ascii-luma-v1']!),
  )
  const summary = {
    runId,
    status: budget.snapshot().inFlightCalls === 0 ? 'complete' : 'incomplete',
    sourceSha256: digest,
    encoder: 'ascii-luma-v1',
    route: 'together-text',
    transportVariant: options.transportVariant,
    classify: stageResult.stage,
    aggregate: budget.snapshot(),
    latency: latencySummary(recorder.calls.map((call) => call.durationMs)),
  }
  await writeImmutable(
    join(outputDirectory, 'summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  )
  await writeImmutable(
    join(outputDirectory, 'run-complete.json'),
    JSON.stringify({ endedAt: new Date().toISOString(), aggregate: budget.snapshot() }, null, 2) +
      '\n',
  )
  return { ...summary, outputDirectory }
}

function latencySummary(values: readonly number[]) {
  if (!values.length) return { count: 0, p50Ms: null, p95Ms: null, minMs: null, maxMs: null }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (percentile: number) =>
    sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? null
  return {
    count: sorted.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    minMs: sorted[0]!,
    maxMs: sorted.at(-1)!,
  }
}
