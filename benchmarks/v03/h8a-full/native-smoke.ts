import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readdir, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  RasterPort,
} from '../../../src/entities/contracts.js'
import { ClassifierError, assertActive } from '../../../src/entities/errors.js'
import { createH8aFullRuntime } from './factory.js'

const MAX_ENCODED_BYTES = 24 * 1024 * 1024
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const metadata = {
  model: null,
  provider: null,
  requestId: null,
  durationMs: 0,
  costUsd: 0,
  attempts: 1,
}

const MAX_ERROR_MESSAGE_CHARS = 512
const MAX_ERROR_CAUSE_DEPTH = 2

interface SmokeErrorReceipt {
  name: string
  code: string | null
  message: string
  cause?: SmokeErrorReceipt
}

export function removeOwnedEmptyDirectory(path: string): Promise<void> {
  return rmdir(path)
}

function sanitizeErrorMessage(value: string): string {
  return value
    .slice(0, MAX_ERROR_MESSAGE_CHARS * 4)
    .replace(
      /\b(api[_-]?key|authorization|access[_-]?token|token|secret|password)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1=[redacted]',
    )
    .replace(/\b(?:Bearer\s+)?(?:sk-or-v1-|sk-)[A-Za-z0-9._~-]+\b/giu, '[redacted]')
    .replace(/https?:\/\/\S+/giu, '[url]')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, '[path]')
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/gu, '[path]')
    .replace(/[A-Za-z0-9+/_=-]{160,}/gu, '[data]')
    .slice(0, MAX_ERROR_MESSAGE_CHARS)
}

export function smokeErrorReceipt(error: unknown, depth = 0): SmokeErrorReceipt | null {
  if (error === null || error === undefined || depth > MAX_ERROR_CAUSE_DEPTH) return null
  if (!(error instanceof Error)) {
    const message =
      typeof error === 'string' || typeof error === 'number' || typeof error === 'boolean'
        ? sanitizeErrorMessage(String(error))
        : '[non-error cause omitted]'
    return { name: typeof error, code: null, message }
  }

  const cause =
    Reflect.get(error, 'cause') ??
    (error instanceof ClassifierError ? error.details.cause : undefined)
  const causeReceipt = smokeErrorReceipt(cause, depth + 1)
  return {
    name: sanitizeErrorMessage(error.name || 'Error'),
    code: error instanceof ClassifierError ? error.code : null,
    message: sanitizeErrorMessage(error.message),
    ...(causeReceipt ? { cause: causeReceipt } : {}),
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`required environment variable is missing: ${name}`)
  return value
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate)
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== '..' &&
      !isAbsolute(pathFromParent))
  )
}

async function readOwnedImage(path: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ENCODED_BYTES)
      throw new ClassifierError(
        'RESOURCE_LIMIT',
        'smoke image must be a regular file no larger than 24 MiB',
      )
    const buffer = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== stat.size) throw new Error('smoke image changed while it was read')
    return buffer.subarray(0, stat.size)
  } finally {
    await handle.close()
  }
}

async function directoryEntries(path: string): Promise<string[] | undefined> {
  try {
    return await readdir(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && Reflect.get(error, 'code') === 'ENOENT')
      return undefined
    throw error
  }
}

function stageFor(request: DecisionRequest): string {
  if (request.questions.presence) return 'presence'
  const text = request.state.filter((part): part is string => typeof part === 'string').join('\n')
  if (text.includes('from family D')) return 'nominate-D'
  if (text.includes('from family U')) return 'nominate-U'
  return 'final-select'
}

function rankedAnswer(request: DecisionRequest): DecisionResult {
  const stage = request.questions.presence ? 'presence' : 'selection'
  const question = request.questions[stage]
  if (!question || question.type !== 'choice')
    throw new ClassifierError('INVALID_RESPONSE', 'smoke decision received an unsupported question')
  const keys = Object.keys(question.criteria)
  const rankingSize = question.rankingSize ?? 4
  const ranking = request.questions.presence
    ? ['present']
    : [...keys.filter((key) => key !== 'none'), 'none'].slice(0, Math.min(rankingSize, keys.length))
  return {
    answers: { [stage]: { type: 'ranked-choice', ranking } },
    metadata,
  }
}

async function main(): Promise<void> {
  const pythonExecutable = resolve(requiredEnvironment('H8A_PYTHON_EXECUTABLE'))
  const assetRoot = resolve(requiredEnvironment('H8A_ASSETS_DIR'))
  const imagePath = resolve(requiredEnvironment('H8A_SMOKE_IMAGE'))
  const artifactBase = resolve(requiredEnvironment('H8A_ARTIFACT_ROOT'))
  if (isWithin(repositoryRoot, artifactBase))
    throw new ClassifierError('INVALID_INPUT', 'H8A_ARTIFACT_ROOT must be outside the repository')
  const encodedImage = await readOwnedImage(imagePath)
  await mkdir(artifactBase, { recursive: true, mode: 0o700 })
  const artifactRoot = await mkdtemp(join(artifactBase, 'h8a-cpu-smoke-'))
  const inputSha256 = createHash('sha256').update(encodedImage).digest('hex')
  const abortController = new AbortController()
  const abort = () => abortController.abort(new ClassifierError('ABORTED', 'smoke interrupted'))
  const decisionCalls: string[] = []
  let nativeClosedBeforeDecision = true
  const decision: DecisionPort = {
    async decide(request, signal) {
      assertActive(signal)
      const nativeTasks = await directoryEntries(join(artifactRoot, 'h8a-full-tasks'))
      if (!nativeTasks || nativeTasks.length > 0) nativeClosedBeforeDecision = false
      decisionCalls.push(stageFor(request))
      return rankedAnswer(request)
    },
  }
  const imageState: RasterPort['imageState'] = async (image) => [
    {
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${Buffer.from(image.bytes).toString('base64')}`,
        detail: 'high',
      },
    },
  ]
  const runtime = createH8aFullRuntime({ pythonExecutable, assetRoot, artifactRoot })
  let terminal: 'located' | 'unknown' | 'error' = 'error'
  let errorCode: string | undefined
  let runtimeError: unknown
  let result: Awaited<ReturnType<typeof runtime.run>> | undefined
  let cleanupError: unknown
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    const run = runtime.run({
      encodedImage,
      authoredTarget: 'visible object',
      exclusions: [],
      includeCutout: true,
      signal: abortController.signal,
      decision,
      imageState,
    })
    encodedImage.fill(0)
    result = await run
    terminal = result.status
  } catch (error) {
    runtimeError = error
    if (error instanceof ClassifierError) errorCode = error.code
    else errorCode = 'PROVIDER'
  } finally {
    encodedImage.fill(0)
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    try {
      await runtime.dispose()
    } catch (error) {
      cleanupError = error
    }
  }

  const runEntries = await directoryEntries(join(artifactRoot, 'h8a-full-runs'))
  const nativeEntries = await directoryEntries(join(artifactRoot, 'h8a-full-tasks'))
  const taskContentsClean =
    (runEntries === undefined || runEntries.length === 0) &&
    (nativeEntries === undefined || nativeEntries.length === 0) &&
    cleanupError === undefined
  if (taskContentsClean) {
    try {
      if (runEntries) await removeOwnedEmptyDirectory(join(artifactRoot, 'h8a-full-runs'))
      if (nativeEntries) await removeOwnedEmptyDirectory(join(artifactRoot, 'h8a-full-tasks'))
      await removeOwnedEmptyDirectory(artifactRoot)
    } catch (error) {
      cleanupError = error
    }
  }
  const cleanupClean = taskContentsClean && cleanupError === undefined
  const receipt = {
    receiptId: basename(artifactRoot),
    recipeId: 'h8a-cpu-raw-target-v1',
    inputSha256,
    terminal,
    errorCode: errorCode ?? null,
    runtimeError: smokeErrorReceipt(runtimeError),
    nativeClosedBeforeDecision,
    decisionStages: decisionCalls,
    decisionCalls: decisionCalls.length,
    sourceFrame:
      result?.status === 'located'
        ? {
            sha256: result.sourceFrame.sha256,
            width: result.sourceFrame.width,
            height: result.sourceFrame.height,
          }
        : null,
    mask:
      result?.status === 'located'
        ? {
            sha256: createHash('sha256').update(result.mask.data).digest('hex'),
            byteLength: result.mask.data.byteLength,
            width: result.mask.width,
            height: result.mask.height,
            region: result.region,
            center: result.center,
          }
        : null,
    cutout:
      result?.status === 'located' && result.cutout
        ? {
            sha256: createHash('sha256').update(result.cutout.data).digest('hex'),
            byteLength: result.cutout.data.byteLength,
            width: result.cutout.width,
            height: result.cutout.height,
          }
        : null,
    cleanup: {
      clean: cleanupClean,
      runTaskEntries: runEntries?.length ?? 0,
      nativeTaskEntries: nativeEntries?.length ?? 0,
      errorCode:
        cleanupError instanceof ClassifierError
          ? cleanupError.code
          : cleanupError
            ? 'PROVIDER'
            : null,
      error: smokeErrorReceipt(cleanupError),
    },
    paidRequests: 0,
  }
  const receiptText = `${JSON.stringify(receipt)}\n`
  await writeFile(join(artifactBase, `${basename(artifactRoot)}.json`), receiptText, {
    flag: 'wx',
    mode: 0o600,
  })
  process.stdout.write(receiptText)
  if (
    terminal !== 'located' ||
    (result?.status === 'located' && !result.cutout) ||
    !nativeClosedBeforeDecision ||
    decisionCalls.length > 4 ||
    !cleanupClean
  )
    process.exitCode = 1
}

const invokedFile = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedFile === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ status: 'error', error: smokeErrorReceipt(error) })}\n`,
    )
    process.exitCode = 1
  })
}
