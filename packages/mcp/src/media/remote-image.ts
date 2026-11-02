import { Resolver } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { isIP, type LookupFunction } from 'node:net'
import ipaddr from 'ipaddr.js'
import sharp from 'sharp'
import type { ImagePayload, MediaLoadRequest } from '../contracts.js'
import { McpCoreError } from '../errors.js'

export interface RemoteImageOptions {
  readonly trustedHosts: readonly string[]
  readonly maxRedirects?: number
  readonly timeoutMs?: number
  readonly maxPixels?: number
  readonly lookupAll?: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<readonly { readonly address: string; readonly family: number }[]>
  /** Controlled transport seam for tests; production HTTP requests always use the pinned HTTPS request implementation. */
  readonly requestForTesting?: (
    url: URL,
    address: { readonly address: string; readonly family: number },
    signal: AbortSignal,
    maxBytes: number,
  ) => Promise<RemoteImageResponse>
}

export interface RemoteImageResponse {
  readonly statusCode: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

const MAX_REDIRECTS = 3
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

function normalizeHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
}

function isAllowedHost(hostname: string, configured: readonly string[]): boolean {
  const host = normalizeHost(hostname)
  return configured.some((entry) => {
    const allowed = normalizeHost(entry.replace(/^\*\./u, ''))
    return host === allowed || (entry.startsWith('*.') && host.endsWith(`.${allowed}`))
  })
}

function isPublicAddress(value: string): boolean {
  try {
    const address = ipaddr.parse(value)
    if (address instanceof ipaddr.IPv6) {
      const rawAddress = value.toLowerCase().split('%', 1)[0] ?? ''
      const ipv6 = address
      if (ipv6.zoneId) return false
      const denied = [
        ['::', 96],
        ['64:ff9b::', 96],
        ['64:ff9b:1::', 48],
        ['2001::', 32],
        ['2002::', 16],
        ['2001:db8::', 32],
      ] as const
      if (denied.some(([network, prefix]) => ipv6.match(ipaddr.parse(network), prefix)))
        return false
      if (ipv6.isIPv4MappedAddress()) {
        const compatibleText =
          (rawAddress.startsWith('::') && !rawAddress.startsWith('::ffff:')) ||
          /^0:0:0:0:0:0:/u.test(rawAddress)
        if (compatibleText) return false
        return isPublicAddress(ipv6.toIPv4Address().toString())
      }
    }
    return address.range() === 'unicast'
  } catch {
    return false
  }
}

async function systemLookup(
  hostname: string,
  signal: AbortSignal,
): Promise<readonly { address: string; family: number }[]> {
  const normalizedHostname = normalizeHost(hostname)
  const family = isIP(normalizedHostname)
  if (family !== 0) {
    return [{ address: normalizedHostname, family }]
  }
  if (signal.aborted) throw new Error('Remote image request was cancelled.')
  const resolver = new Resolver()
  const abort = (): void => resolver.cancel()
  signal.addEventListener('abort', abort, { once: true })
  const query = <T>(
    run: (callback: (error: NodeJS.ErrnoException | null, addresses: T[]) => void) => void,
  ): Promise<T[]> =>
    new Promise((resolve, reject) => {
      run((error, addresses) => {
        if (!error) resolve(addresses)
        else if (error.code === 'ENODATA' || error.code === 'ENOTFOUND') resolve([])
        else reject(error)
      })
    })
  try {
    const [v4Result, v6Result] = await Promise.allSettled([
      query<string>((callback) => resolver.resolve4(hostname, callback)),
      query<string>((callback) => resolver.resolve6(hostname, callback)),
    ])
    if (signal.aborted) throw new Error('Remote image request was cancelled.')
    const rejected = [v4Result, v6Result].find((result) => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
    const v4 = v4Result.status === 'fulfilled' ? v4Result.value : []
    const v6 = v6Result.status === 'fulfilled' ? v6Result.value : []
    return [
      ...v4.map((address) => ({ address, family: 4 })),
      ...v6.map((address) => ({ address, family: 6 })),
    ]
  } finally {
    signal.removeEventListener('abort', abort)
    resolver.cancel()
  }
}

export function validateRemoteImageAddresses(
  addresses: readonly { readonly address: string; readonly family: number }[],
): { readonly address: string; readonly family: number } {
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Remote image host resolves to a prohibited address.')
  }
  const first = addresses[0]
  if (!first) throw new Error('Remote image host did not resolve to an address.')
  return first
}

async function resolvePinned(
  hostname: string,
  lookupAll: RemoteImageOptions['lookupAll'],
  signal: AbortSignal,
) {
  const addresses = await (lookupAll ?? systemLookup)(hostname, signal)
  return validateRemoteImageAddresses(addresses)
}

function parseImageSourceUrl(raw: string, trustedHosts: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Remote image URL is invalid.')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !isAllowedHost(url.hostname, trustedHosts)
  ) {
    throw new Error('Remote image URL is not allowed.')
  }
  return url
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

async function collectResponse(response: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response) {
    let bytes: Buffer
    if (Buffer.isBuffer(chunk)) bytes = chunk
    else if (typeof chunk === 'string') bytes = Buffer.from(chunk)
    else if (chunk instanceof Uint8Array) bytes = Buffer.from(chunk)
    else throw new Error('Remote image response contains an invalid chunk.')
    total += bytes.byteLength
    if (total > limit) {
      const closed = new Promise<void>((resolve) => response.once('close', resolve))
      response.destroy()
      await closed
      throw new Error('Remote image exceeds the configured byte limit.')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total)
}

async function requestImage(
  url: URL,
  address: { readonly address: string; readonly family: number },
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: Buffer }> {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: address.address, family: address.family }])
    else callback(null, address.address, address.family)
  }
  const req = httpsRequest(url, {
    method: 'GET',
    headers: { accept: 'image/jpeg,image/png,image/webp' },
    lookup,
    ...(isIP(normalizeHost(url.hostname)) === 0 ? { servername: url.hostname } : {}),
    signal,
  })
  const requestClosed = new Promise<void>((resolve) => req.once('close', resolve))
  const responsePromise = new Promise<IncomingMessage>((resolve, reject) => {
    req.once('response', resolve)
    req.once('error', reject)
  })
  req.end()
  try {
    const response = await responsePromise
    const statusCode = response.statusCode ?? 0
    if (statusCode >= 200 && statusCode < 300) {
      const body = await collectResponse(response, maxBytes)
      await requestClosed
      return { statusCode, headers: response.headers, body }
    }
    response.destroy()
    await requestClosed
    return { statusCode, headers: response.headers, body: Buffer.alloc(0) }
  } catch (error) {
    await requestClosed
    throw error
  }
}

export async function inspectImageBytes(
  bytes: Buffer,
  declaredType: string | undefined,
  maxPixels: number,
): Promise<ImagePayload> {
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: maxPixels, animated: false })
  const metadata = await image.metadata()
  if (
    !['jpeg', 'png', 'webp'].includes(metadata.format ?? '') ||
    !metadata.width ||
    !metadata.height ||
    (metadata.pages ?? 1) !== 1
  ) {
    throw new Error('Remote image format is not supported.')
  }
  if (metadata.width * metadata.height > maxPixels)
    throw new Error('Remote image exceeds the configured pixel limit.')
  const mediaType = metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`
  const normalizedDeclaredType = declaredType?.split(';', 1)[0]?.trim().toLowerCase()
  if (
    normalizedDeclaredType !== undefined &&
    normalizedDeclaredType !== 'application/octet-stream' &&
    normalizedDeclaredType !== mediaType
  ) {
    throw new Error('Remote image content type does not match its bytes.')
  }
  const orientation = metadata.orientation ?? 1
  const swapsAxes = orientation >= 5 && orientation <= 8
  return {
    bytes: Uint8Array.from(bytes),
    mediaType,
    width: swapsAxes ? metadata.height : metadata.width,
    height: swapsAxes ? metadata.width : metadata.height,
  }
}

export function createRemoteImageLoader(options: RemoteImageOptions) {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxPixels = options.maxPixels ?? 16_777_216
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS) {
    throw new Error('Remote image redirect limit must be between zero and three.')
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000 ||
    !Number.isSafeInteger(maxPixels) ||
    maxPixels < 1 ||
    maxPixels > 16_777_216 ||
    options.trustedHosts.length > 128 ||
    options.trustedHosts.some(
      (host) => typeof host !== 'string' || host.length < 1 || host.length > 253,
    )
  ) {
    throw new Error('Remote image configuration limits are invalid.')
  }

  return async function loadRemoteImage(request: MediaLoadRequest): Promise<ImagePayload> {
    const sourceUrl =
      request.source.kind === 'url'
        ? request.source.url
        : request.source.kind === 'chatgptFile'
          ? request.source.downloadUrl
          : undefined
    if (sourceUrl === undefined) throw new Error('Remote image loader received a non-URL source.')
    const deadlineMs = request.deadlineAt - Date.now()
    if (deadlineMs <= 0)
      throw new McpCoreError('TIMEOUT', 'Remote image operation deadline expired.', true)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, deadlineMs))
    const abort = (): void => controller.abort(request.signal.reason)
    if (request.signal.aborted) abort()
    else request.signal.addEventListener('abort', abort, { once: true })
    try {
      let url = parseImageSourceUrl(sourceUrl, options.trustedHosts)
      for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
        if (request.signal.aborted)
          throw new McpCoreError('CANCELLED', 'Remote image request was cancelled.', true)
        if (controller.signal.aborted)
          throw new McpCoreError('TIMEOUT', 'Remote image request deadline expired.', true)
        const pinned = await resolvePinned(url.hostname, options.lookupAll, controller.signal)
        const response = await (options.requestForTesting ?? requestImage)(
          url,
          pinned,
          controller.signal,
          request.maxBytes,
        )
        if (REDIRECT_CODES.has(response.statusCode)) {
          const location = header(response.headers, 'location')
          if (!location || redirects === maxRedirects)
            throw new Error('Remote image redirect limit exceeded.')
          url = parseImageSourceUrl(new URL(location, url).href, options.trustedHosts)
          continue
        }
        if (response.statusCode < 200 || response.statusCode >= 300)
          throw new Error('Remote image server returned an unsuccessful status.')
        if (response.body.byteLength > request.maxBytes)
          throw new McpCoreError(
            'RESOURCE_LIMIT',
            'Remote image exceeds the configured byte limit.',
          )
        const contentLength = Number(header(response.headers, 'content-length'))
        if (Number.isFinite(contentLength) && contentLength > request.maxBytes)
          throw new Error('Remote image exceeds the configured byte limit.')
        const ownedBody = Buffer.from(response.body)
        let image: ImagePayload
        try {
          image = await inspectImageBytes(
            ownedBody,
            header(response.headers, 'content-type'),
            maxPixels,
          )
        } finally {
          ownedBody.fill(0)
        }
        if (request.signal.aborted)
          throw new McpCoreError('CANCELLED', 'Remote image request was cancelled.', true)
        if (controller.signal.aborted || Date.now() >= request.deadlineAt)
          throw new McpCoreError('TIMEOUT', 'Remote image request deadline expired.', true)
        return image
      }
      throw new Error('Remote image redirect limit exceeded.')
    } catch (error) {
      if (request.signal.aborted)
        throw new McpCoreError('CANCELLED', 'Remote image request was cancelled.', true)
      if (controller.signal.aborted)
        throw new McpCoreError('TIMEOUT', 'Remote image request deadline expired.', true)
      throw error instanceof Error && error.message.startsWith('Remote image')
        ? error
        : new Error('Remote image request failed.')
    } finally {
      clearTimeout(timeout)
      request.signal.removeEventListener('abort', abort)
    }
  }
}
