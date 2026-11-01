import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { DecisionPort, RasterPort } from '../../../src/entities/contracts.js'
import { ClassifierError, assertActive } from '../../../src/entities/errors.js'
import { createH6ContextComposer, createSharpH6Presentation } from '../h6-context-composer.js'
import type { H6DecisionBudgetRecordPort } from '../h6-context-composer.js'
import {
  H8A_FULL_CASE_DEADLINE_MS,
  H8A_FULL_MAX_ENCODED_BYTES,
  H8A_FULL_RECIPE_ID,
} from './constants.js'
import { h8aExclusionsSchema, h8aAuthoredTargetSchema, h8aFullSuccessSchema } from './contracts.js'
import {
  copyEncodedImageBytes,
  decodeOrientedSource,
  encodeOrientedPng,
  type OwnedOrientedSource,
  type OwnedOrientedPng,
} from './image-source.js'
import {
  buildOptionalCutout,
  clipPackedMaskToVisibleAlpha,
  foregroundBounds,
  maskHasForeground,
  regionCenter,
} from './mask-geometry.js'
import type { H8aFullNativePort } from './native-port.js'
import type { H8aFullSuccess } from './contracts.js'
import type { H8aNativeGenerationOutput } from './native-port.js'

export interface H8aFullPipelineInput {
  encodedImage: Uint8Array
  authoredTarget: string
  exclusions?: readonly string[]
  includeCutout?: boolean
  signal: AbortSignal
}

export interface H8aFullPipelineDependencies {
  decision: DecisionPort
  imageState: RasterPort['imageState']
  native: Pick<H8aFullNativePort, 'generate'>
  artifactRoot: string
  presentation?: ReturnType<typeof createSharpH6Presentation>
  budgetRecord?: H6DecisionBudgetRecordPort
}

interface H8aFullRunCapture {
  encodedImageSource: Uint8Array
  authoredTarget: string
  exclusions: string[]
  includeCutout: boolean
  callerSignal: AbortSignal
  dependencies: Omit<H8aFullPipelineDependencies, 'artifactRoot'>
  artifactRoot: string
}

export interface H8aFullRunSnapshot {
  encodedImage: Uint8Array
  authoredTarget: string
  exclusions: readonly string[]
  includeCutout: boolean
  deadlineAt: number
  taskDirectory: string
}

export function captureH8aFullRun(
  input: H8aFullPipelineInput,
  dependencies: H8aFullPipelineDependencies,
): H8aFullRunCapture {
  if (!input || typeof input !== 'object') throw invalidInput('H8a input must be an object')
  const encodedImageSource = input.encodedImage
  if (!(encodedImageSource instanceof Uint8Array))
    throw invalidInput('encoded image must be Uint8Array')
  if (
    encodedImageSource.byteLength === 0 ||
    encodedImageSource.byteLength > H8A_FULL_MAX_ENCODED_BYTES
  )
    throw invalidInput('encoded image must be nonempty and no larger than 24 MiB')
  if (!(input.signal instanceof AbortSignal)) throw invalidInput('H8a input requires AbortSignal')
  let authoredTarget: string
  let exclusions: string[]
  try {
    authoredTarget = h8aAuthoredTargetSchema.parse(input.authoredTarget)
    if (input.exclusions !== undefined && !Array.isArray(input.exclusions))
      throw invalidInput('exclusions must be an array')
    if ((input.exclusions?.length ?? 0) > 16) throw invalidInput('too many exclusions')
    exclusions = h8aExclusionsSchema.parse(input.exclusions ?? [])
  } catch (error) {
    if (error instanceof ClassifierError) throw error
    throw invalidInput('H8a target or exclusions are invalid', error)
  }
  if (input.includeCutout !== undefined && typeof input.includeCutout !== 'boolean')
    throw invalidInput('includeCutout must be boolean')
  if (
    !dependencies ||
    typeof dependencies.decision?.decide !== 'function' ||
    typeof dependencies.imageState !== 'function' ||
    typeof dependencies.native?.generate !== 'function' ||
    typeof dependencies.artifactRoot !== 'string' ||
    dependencies.artifactRoot.length === 0 ||
    (dependencies.presentation !== undefined &&
      (typeof dependencies.presentation.renderPresence !== 'function' ||
        typeof dependencies.presentation.renderNomination !== 'function' ||
        typeof dependencies.presentation.renderFinal !== 'function')) ||
    (dependencies.budgetRecord !== undefined &&
      (typeof dependencies.budgetRecord.admit !== 'function' ||
        typeof dependencies.budgetRecord.settle !== 'function'))
  )
    throw invalidInput('H8a runtime requires explicit valid injected ports and artifact root')
  return {
    encodedImageSource,
    authoredTarget,
    exclusions,
    includeCutout: input.includeCutout === true,
    callerSignal: input.signal,
    dependencies: {
      decision: dependencies.decision,
      imageState: dependencies.imageState,
      native: dependencies.native,
      ...(dependencies.presentation ? { presentation: dependencies.presentation } : {}),
      ...(dependencies.budgetRecord ? { budgetRecord: dependencies.budgetRecord } : {}),
    },
    artifactRoot: resolve(dependencies.artifactRoot),
  }
}

export function ownH8aFullRunSnapshot(
  capture: H8aFullRunCapture,
  deadlineAt: number,
  runId = randomUUID(),
): H8aFullRunSnapshot {
  if (!Number.isFinite(deadlineAt) || deadlineAt <= 0)
    throw invalidInput('absolute deadline is invalid')
  const encodedImage = copyEncodedImageBytes(capture.encodedImageSource)
  return {
    encodedImage,
    authoredTarget: capture.authoredTarget,
    exclusions: [...capture.exclusions],
    includeCutout: capture.includeCutout,
    deadlineAt,
    taskDirectory: join(capture.artifactRoot, 'h8a-full-runs', runId),
  }
}

export async function runH8aFullPipelineSnapshot(
  snapshot: H8aFullRunSnapshot,
  dependencies: Omit<H8aFullPipelineDependencies, 'artifactRoot'>,
  signal: AbortSignal,
): Promise<H8aFullSuccess> {
  let source: OwnedOrientedSource | undefined
  let orientedPng: OwnedOrientedPng | undefined
  let nativeResult: H8aNativeGenerationOutput | undefined
  let selectedMask: ReturnType<typeof clipPackedMaskToVisibleAlpha> | undefined
  let compositionMask: H8aNativeGenerationOutput['families']['D'][number]['mask'] | undefined
  let taskDirectoryCreated = false
  let result: H8aFullSuccess | undefined
  let failure: unknown

  try {
    assertActive(signal)
    if (performance.now() >= snapshot.deadlineAt) throw timeoutError()
    await mkdir(dirname(snapshot.taskDirectory), { recursive: true, mode: 0o700 })
    await mkdir(snapshot.taskDirectory, { recursive: false, mode: 0o700 })
    taskDirectoryCreated = true
    source = await decodeOrientedSource(snapshot.encodedImage)
    assertActive(signal)
    orientedPng = await encodeOrientedPng(source)
    assertActive(signal)
    if (performance.now() >= snapshot.deadlineAt) throw timeoutError()
    const sourcePath = join(snapshot.taskDirectory, 'oriented-source.png')
    await writeFile(sourcePath, orientedPng.bytes, { mode: 0o600, flag: 'wx' })
    if (performance.now() >= snapshot.deadlineAt) throw timeoutError()

    nativeResult = await dependencies.native.generate({
      authoredTarget: snapshot.authoredTarget,
      sourcePath,
      sourceSha256: orientedPng.sha256,
      width: source.width,
      height: source.height,
      deadlineAt: snapshot.deadlineAt,
      signal,
    })
    assertActive(signal)
    if (performance.now() >= snapshot.deadlineAt) throw timeoutError()

    const budgetRecord =
      dependencies.budgetRecord ??
      ({
        admit() {},
        settle() {},
      } satisfies H6DecisionBudgetRecordPort)
    const composer = createH6ContextComposer({
      decision: dependencies.decision,
      imageState: dependencies.imageState,
      presentation: dependencies.presentation ?? createSharpH6Presentation(),
      budgetRecord,
    })
    const composition = await composer.compose({
      image: source.raster,
      target: snapshot.authoredTarget,
      exclusions: snapshot.exclusions,
      families: nativeResult.families,
      signal,
    })
    if (composition.status === 'located') compositionMask = composition.mask
    assertActive(signal)
    if (performance.now() >= snapshot.deadlineAt) throw timeoutError()
    if (composition.status === 'unknown') {
      result = { status: 'unknown', reason: composition.reason }
    } else {
      selectedMask = clipPackedMaskToVisibleAlpha(composition.mask, source.raster)
      if (!maskHasForeground(selectedMask)) {
        selectedMask.data.fill(0)
        selectedMask = undefined
        result = { status: 'unknown', reason: 'no-visible-foreground' }
      } else {
        const region = foregroundBounds(selectedMask)
        if (!region)
          throw new ClassifierError('INVALID_RESPONSE', 'visible located mask lacks bounds')
        const center = regionCenter(region)
        const mask = {
          format: selectedMask.format,
          width: selectedMask.width,
          height: selectedMask.height,
          data: Uint8Array.from(selectedMask.data),
        } as const
        const renderedCutout = snapshot.includeCutout
          ? buildOptionalCutout(source.raster, selectedMask, region)
          : undefined
        const cutout = renderedCutout
          ? { ...renderedCutout, data: Uint8Array.from(renderedCutout.data) }
          : undefined
        renderedCutout?.data.fill(0)
        result = {
          status: 'located',
          family: composition.family,
          alias: composition.alias,
          sourceAlias: composition.sourceAlias,
          originalEncodedSha256: source.originalEncodedSha256,
          sourceFrame: {
            sha256: source.frameSha256,
            width: source.width,
            height: source.height,
          },
          mask,
          region,
          center,
          ...(cutout ? { cutout } : {}),
        }
      }
      compositionMask?.data.fill(0)
      compositionMask = undefined
    }
    if (nativeResult.recipeId !== H8A_FULL_RECIPE_ID && result)
      result = { ...result, recipeId: nativeResult.recipeId }
    result = h8aFullSuccessSchema.parse(result)
  } catch (error) {
    failure = normalizePipelineError(error)
  } finally {
    if (failure && result?.status === 'located') {
      result.mask.data.fill(0)
      result.cutout?.data.fill(0)
    }
    for (const family of ['D', 'U'] as const) {
      for (const candidate of nativeResult?.families[family] ?? []) candidate.mask.data.fill(0)
    }
    selectedMask?.data.fill(0)
    compositionMask?.data.fill(0)
    orientedPng?.dispose()
    source?.dispose()
    snapshot.encodedImage.fill(0)
    if (taskDirectoryCreated) {
      try {
        await rm(snapshot.taskDirectory, { recursive: true, force: false })
      } catch (cleanupError) {
        const combined = failure
          ? new AggregateError(
              [failure, cleanupError],
              'H8a run failed and task cleanup also failed',
              {
                cause: failure,
              },
            )
          : cleanupError
        failure = new ClassifierError('PROVIDER', 'H8a owned task directory cleanup failed', {
          cause: combined,
        })
      }
    }
    if (performance.now() >= snapshot.deadlineAt) {
      failure = new ClassifierError('TIMEOUT', 'H8a full run exceeded its absolute deadline', {
        cause: failure,
      })
    }
  }

  if (failure) throw failure
  if (!result) throw new ClassifierError('PROVIDER', 'H8a pipeline ended without a result')
  return result
}

export async function runH8aFullPipeline(
  input: H8aFullPipelineInput,
  dependencies: H8aFullPipelineDependencies,
): Promise<H8aFullSuccess> {
  const startedAt = performance.now()
  const deadlineAt = startedAt + H8A_FULL_CASE_DEADLINE_MS
  const capture = captureH8aFullRun(input, dependencies)
  const snapshot = ownH8aFullRunSnapshot(capture, deadlineAt)
  const controller = new AbortController()
  const onAbort = () => controller.abort(capture.callerSignal.reason)
  capture.callerSignal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(
    () => controller.abort(timeoutError()),
    Math.max(0, deadlineAt - performance.now()),
  )
  timer.unref?.()
  try {
    if (capture.callerSignal.aborted) onAbort()
    return await runH8aFullPipelineSnapshot(snapshot, capture.dependencies, controller.signal)
  } finally {
    clearTimeout(timer)
    capture.callerSignal.removeEventListener('abort', onAbort)
  }
}

function invalidInput(message: string, cause?: unknown): ClassifierError {
  return new ClassifierError('INVALID_INPUT', message, cause === undefined ? {} : { cause })
}

function timeoutError(): ClassifierError {
  return new ClassifierError('TIMEOUT', 'H8a full run exceeded its absolute deadline')
}

function normalizePipelineError(error: unknown): unknown {
  if (error instanceof ClassifierError) return error
  if (error instanceof Error)
    return new ClassifierError('PROVIDER', error.message.slice(0, 500), { cause: error })
  return new ClassifierError('PROVIDER', 'H8a pipeline failed', { cause: error })
}
