import type { CredentialPort } from '../contracts.js'
import { McpCoreError } from '../errors.js'

export class EnvironmentCredentialPort implements CredentialPort {
  readonly #environment: Readonly<Record<string, string | undefined>>

  constructor(environment: Readonly<Record<string, string | undefined>>) {
    this.#environment = environment
  }

  async resolve(input: Parameters<CredentialPort['resolve']>[0]): Promise<{ apiKey: string }> {
    input.signal.throwIfAborted()
    if (Date.now() >= input.deadlineAt) {
      throw new McpCoreError('TIMEOUT', 'Job deadline exceeded.', true)
    }
    if (input.profile.credentialMode !== 'service' || input.profile.apiKeyEnv === undefined) {
      throw new McpCoreError(
        'CREDENTIAL_UNAVAILABLE',
        'No credential resolver is configured for this profile.',
      )
    }
    const apiKey = this.#environment[input.profile.apiKeyEnv]
    if (apiKey === undefined || apiKey.length === 0) {
      throw new McpCoreError('CREDENTIAL_UNAVAILABLE', 'The configured credential is unavailable.')
    }
    return { apiKey }
  }
}

export function createEnvironmentCredentialPort(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CredentialPort {
  return new EnvironmentCredentialPort(environment)
}
