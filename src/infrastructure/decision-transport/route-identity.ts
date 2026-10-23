function routeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '')
}

interface ResponseModelIdentity {
  model: string
  responseModelIds?: readonly string[] | undefined
}

export function acceptsResponseModel(value: string, identity: ResponseModelIdentity): boolean {
  if (value === identity.model || identity.responseModelIds?.includes(value)) return true
  if (!value.startsWith(identity.model + '-')) return false
  const suffix = value.slice(identity.model.length + 1)
  if (!/^\d{4}-?\d{2}-?\d{2}$/u.test(suffix)) return false
  const digits = suffix.replaceAll('-', ''),
    date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
  const parsed = new Date(date + 'T00:00:00.000Z')
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date
}

interface PinnedProviderIdentity {
  provider?: string | undefined
  providerName?: string | undefined
}

export function unexpectedResponseProvider(
  envelopeProvider: string | null | undefined,
  pinned: PinnedProviderIdentity,
): boolean {
  if (!envelopeProvider) return false
  const expected = pinned.providerName ?? pinned.provider
  if (expected === undefined) return false
  return routeName(envelopeProvider) !== routeName(expected)
}
