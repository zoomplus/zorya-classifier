import { createClassifier } from 'zorya-classifier'
import type { DecisionPort } from 'zorya-classifier'
import {
  createOpenAICompatibleText,
  createOpenAICompatibleVision,
} from 'zorya-classifier/openai-compatible'
import { createOpenRouterDecisions, createOpenRouterVision } from 'zorya-classifier/openrouter'
import { createGrabCutSegmenter, createMobileSamSegmenter } from 'zorya-classifier/segmentation'

import type { McpConfig } from '../config.js'
import type {
  ClassifierFactory,
  ClassifierLease,
  CredentialModelProfile,
  InjectedDecisionProfile,
  ModelProfile,
  NetworkModelProfile,
  OpenAICompatibleProfile,
} from '../contracts.js'
import { McpCoreError, abortError } from '../errors.js'

export class PublishedClassifierFactory implements ClassifierFactory {
  readonly #config: McpConfig

  constructor(config: McpConfig) {
    this.#config = config
  }

  async create(input: Parameters<ClassifierFactory['create']>[0]): Promise<ClassifierLease> {
    assertActive(input.signal, input.deadlineAt)
    let decision: DecisionPort
    if ('decisionPort' in input) {
      decision = input.decisionPort
    } else if ('apiKey' in input) {
      decision = this.#createCredentialedDecision(input.profile, input.apiKey)
    } else if (isKeylessProfile(input.profile)) {
      decision = this.#createKeylessDecision(input.profile)
    } else {
      throw new McpCoreError('CREDENTIAL_UNAVAILABLE', 'The profile credential is unavailable.')
    }

    const segmentation = await this.#createSegmenter()
    try {
      assertActive(input.signal, input.deadlineAt)
      const timeoutMs = Math.min(
        120_000,
        this.#config.limits.jobTimeoutMs,
        Math.max(1, input.deadlineAt - Date.now()),
      )
      const classifier = createClassifier({
        decision,
        timeoutMs,
        concurrency: 1,
        maxQueue: 1,
        maxInputBytes: this.#config.limits.maxImageBytes,
        ...(segmentation === undefined ? {} : { segmentation }),
      })

      return {
        classifier,
        ...(segmentation === undefined ? {} : { segmenter: segmentation }),
        dispose: async (_context) => {
          let firstError: unknown
          try {
            await classifier.dispose()
          } catch (error) {
            firstError = error
          }
          if (segmentation !== undefined) {
            const cleanupError = await disposeSegmenter(segmentation)
            firstError ??= cleanupError
          }
          if (firstError !== undefined) throw firstError
        },
      }
    } catch (error) {
      const cleanupError =
        segmentation === undefined ? undefined : await disposeSegmenter(segmentation)
      if (cleanupError !== undefined) throw new AggregateError([error, cleanupError])
      throw error
    }
  }

  #createCredentialedDecision(profile: CredentialModelProfile, apiKey: string) {
    const responseModelIds =
      profile.responseModelIds === undefined ? undefined : [...profile.responseModelIds]
    if (profile.adapter === 'openrouter-native') {
      const provider = this.#requiredProvider(profile)
      return createOpenRouterDecisions({
        model: profile.model,
        provider,
        apiKey,
        ...(profile.providerName === undefined ? {} : { providerName: profile.providerName }),
        ...(responseModelIds === undefined ? {} : { responseModelIds }),
      })
    }
    if (profile.adapter === 'openrouter-vision') {
      const provider = this.#requiredProvider(profile)
      return createOpenRouterVision({
        model: profile.model,
        provider,
        apiKey,
        ...(profile.providerName === undefined ? {} : { providerName: profile.providerName }),
        ...(responseModelIds === undefined ? {} : { responseModelIds }),
      })
    }
    const endpoint = this.#requiredEndpoint(profile)
    if (profile.adapter === 'openai-compatible-text') {
      return createOpenAICompatibleText({
        endpoint,
        model: profile.model,
        apiKey,
        ...(responseModelIds === undefined ? {} : { responseModelIds }),
      })
    }
    return createOpenAICompatibleVision({
      endpoint,
      model: profile.model,
      apiKey,
      ...(responseModelIds === undefined ? {} : { responseModelIds }),
    })
  }

  #createKeylessDecision(profile: OpenAICompatibleProfile & { readonly credentialMode: 'none' }) {
    const endpoint = this.#requiredEndpoint(profile)
    const responseModelIds =
      profile.responseModelIds === undefined ? undefined : [...profile.responseModelIds]
    if (profile.adapter === 'openai-compatible-text') {
      return createOpenAICompatibleText({
        endpoint,
        model: profile.model,
        ...(responseModelIds === undefined ? {} : { responseModelIds }),
      })
    }
    return createOpenAICompatibleVision({
      endpoint,
      model: profile.model,
      ...(responseModelIds === undefined ? {} : { responseModelIds }),
    })
  }

  async #createSegmenter() {
    const native = this.#config.segmentation
    if (native === undefined) return undefined
    if (native.kind === 'mobile-sam') {
      return createMobileSamSegmenter({
        encoderPath: native.encoderPath,
        decoderPath: native.decoderPath,
        executionProvider: native.executionProvider,
        threads: native.threads,
        ...(native.deviceId === undefined ? {} : { deviceId: native.deviceId }),
      })
    }
    return createGrabCutSegmenter({ assetPath: native.assetPath })
  }

  #requiredProvider(profile: NetworkModelProfile): string {
    if (profile.provider === undefined) {
      throw new McpCoreError('INVALID_INPUT', 'The configured OpenRouter provider is missing.')
    }
    return profile.provider
  }

  #requiredEndpoint(profile: NetworkModelProfile): string {
    if (profile.endpoint === undefined) {
      throw new McpCoreError('INVALID_INPUT', 'The configured model endpoint is missing.')
    }
    return profile.endpoint
  }
}

function assertActive(signal: AbortSignal, deadlineAt: number): void {
  if (signal.aborted) throw abortError(signal)
  if (Date.now() >= deadlineAt) {
    throw new McpCoreError('TIMEOUT', 'Job deadline exceeded.', true)
  }
}

async function disposeSegmenter(segmenter: Awaited<ReturnType<typeof createMobileSamSegmenter>>) {
  let firstError: unknown
  try {
    await segmenter.settle()
  } catch (error) {
    firstError = error
  }
  try {
    await segmenter.dispose()
  } catch (error) {
    firstError ??= error
  }
  return firstError
}

export type { InjectedDecisionProfile, ModelProfile }

function isKeylessProfile(
  profile: ModelProfile,
): profile is OpenAICompatibleProfile & { readonly credentialMode: 'none' } {
  return (
    (profile.adapter === 'openai-compatible-vision' ||
      profile.adapter === 'openai-compatible-text') &&
    profile.credentialMode === 'none'
  )
}
