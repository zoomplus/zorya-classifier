import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'

export interface IpAccessConfig {
  readonly allowedCidrs: readonly string[]
  readonly trustedProxyCidrs: readonly string[]
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
}

interface CompiledCidr {
  readonly network: ipaddr.IPv4 | ipaddr.IPv6
  readonly prefix: number
}

function address(value: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  if (isIP(value) === 0) return undefined
  try {
    const parsed = ipaddr.parse(value)
    return parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()
      ? parsed.toIPv4Address()
      : parsed
  } catch {
    return undefined
  }
}

function compile(values: readonly string[]): readonly CompiledCidr[] {
  if (!Array.isArray(values) || values.length > 4096)
    throw new Error('IP access CIDR configuration is invalid.')
  return values.map((value) => {
    if (typeof value !== 'string') throw new Error('IP access CIDR configuration is invalid.')
    const parts = value.split('/')
    if (
      parts.length !== 2 ||
      isIP(parts[0] ?? '') === 0 ||
      !/^(0|[1-9][0-9]*)$/u.test(parts[1] ?? '')
    )
      throw new Error('IP access CIDR configuration is invalid.')
    let network: ipaddr.IPv4 | ipaddr.IPv6 | undefined
    try {
      const parsed = ipaddr.parse(parts[0] ?? '')
      const rawPrefix = Number(parts[1])
      if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
        if (rawPrefix < 96) throw new Error('Mapped IPv4 CIDR is too broad.')
        network = parsed.toIPv4Address()
      } else {
        network = parsed
      }
    } catch {
      throw new Error('IP access CIDR configuration is invalid.')
    }
    const parsedPrefix = Number(parts[1])
    const prefix =
      network?.kind() === 'ipv4' && parts[0]?.includes(':') ? parsedPrefix - 96 : parsedPrefix
    const maxPrefix = network?.kind() === 'ipv4' ? 32 : 128
    if (!network || !Number.isSafeInteger(prefix) || prefix < 1 || prefix > maxPrefix)
      throw new Error('IP access CIDR configuration is invalid.')
    return { network, prefix }
  })
}

function matches(values: readonly CompiledCidr[], value: string): boolean {
  const candidate = address(value)
  if (!candidate) return false
  return values.some((entry) => {
    if (entry.network.kind() !== candidate.kind()) return false
    return candidate.match(entry.network, entry.prefix)
  })
}

function rawHeader(
  request: IncomingMessage,
  name: string,
): { readonly present: boolean; readonly value?: string } | undefined {
  let result: string | undefined
  let present = false
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== name) continue
    if (present) return undefined
    present = true
    result = request.rawHeaders[index + 1]
  }
  return { present, ...(result === undefined ? {} : { value: result }) }
}

export class IpAccessPolicy {
  readonly #allowed: readonly CompiledCidr[]
  readonly #trusted: readonly CompiledCidr[]
  readonly #hosts: ReadonlySet<string>
  readonly #origins: ReadonlySet<string>

  constructor(config: IpAccessConfig) {
    if (
      config.allowedHosts.length < 1 ||
      config.allowedHosts.length > 128 ||
      config.allowedOrigins.length > 128
    )
      throw new Error('IP access host/origin configuration is invalid.')
    this.#allowed = compile(config.allowedCidrs)
    this.#trusted = compile(config.trustedProxyCidrs)
    this.#hosts = new Set(
      config.allowedHosts.map((value) => {
        if (
          value !== value.toLowerCase() ||
          value.includes('*') ||
          value.includes('/') ||
          value.includes('@')
        )
          throw new Error('IP access host configuration must use exact lowercase Host values.')
        let parsed: URL
        try {
          parsed = new URL(`http://${value}`)
        } catch {
          throw new Error('IP access host configuration is invalid.')
        }
        if (
          parsed.host !== value ||
          parsed.pathname !== '/' ||
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash
        )
          throw new Error('IP access host configuration must contain only one exact Host value.')
        return value
      }),
    )
    this.#origins = new Set(
      config.allowedOrigins.map((value) => {
        let parsed: URL
        try {
          parsed = new URL(value)
        } catch {
          throw new Error('IP access origin configuration is invalid.')
        }
        if (
          parsed.protocol !== 'https:' ||
          parsed.origin !== value ||
          parsed.pathname !== '/' ||
          parsed.search ||
          parsed.hash ||
          parsed.username ||
          parsed.password
        )
          throw new Error('IP access origin configuration must use exact HTTPS origins.')
        return value
      }),
    )
  }

  clientAddress(request: IncomingMessage): string | undefined {
    const remote = request.socket.remoteAddress
    const parsedRemote = remote ? address(remote) : undefined
    if (!remote || !parsedRemote) return undefined
    let candidate = remote
    const trustedProxy = matches(this.#trusted, remote)
    const realIp = rawHeader(request, 'x-real-ip')
    const forwardedFor = rawHeader(request, 'x-forwarded-for')
    const forwarded = rawHeader(request, 'forwarded')
    if (!realIp || !forwardedFor || !forwarded || forwardedFor.present || forwarded.present)
      return undefined
    if (trustedProxy) {
      if (!realIp.present || !realIp.value || !address(realIp.value)) return undefined
      candidate = realIp.value
    } else if (realIp.present) {
      return undefined
    }
    return matches(this.#allowed, candidate)
      ? (address(candidate)?.toString() ?? undefined)
      : undefined
  }

  authorize(request: IncomingMessage): boolean {
    const host = rawHeader(request, 'host')
    if (!host?.present || !host.value || !this.#hosts.has(host.value.toLowerCase())) return false
    const origin = rawHeader(request, 'origin')
    if (!origin) return false
    if (origin.present) {
      if (!origin.value || !this.#origins.has(origin.value)) return false
      try {
        const parsed = new URL(origin.value)
        if (
          parsed.protocol !== 'https:' ||
          parsed.origin !== origin.value ||
          parsed.username ||
          parsed.password ||
          parsed.pathname !== '/' ||
          parsed.search ||
          parsed.hash
        )
          return false
      } catch {
        return false
      }
    }
    return this.clientAddress(request) !== undefined
  }
}
