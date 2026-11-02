import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ImagePayload, MediaLoadRequest, MediaPort } from '../contracts.js'
import { McpCoreError } from '../errors.js'
import {
  createRemoteImageLoader,
  inspectImageBytes,
  type RemoteImageOptions,
} from './remote-image.js'

export interface MediaLoaderOptions {
  readonly remote: RemoteImageOptions
  readonly stdioInputRoot?: string
  readonly readUploaded?: (input: {
    readonly ownerId: string
    readonly id: string
    readonly signal: AbortSignal
    readonly deadlineAt: number
    readonly maxBytes: number
  }) => Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }>
  readonly maxPixels?: number
}

export function decodeInlineBase64(data: string, maxBytes: number): Buffer {
  if (data.length === 0 || data.length % 4 !== 0) throw new Error('Inline image data is invalid.')
  if (data.length > Math.ceil(maxBytes / 3) * 4)
    throw new Error('Inline image exceeds the byte limit.')
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const contentLength = data.length - padding
  if ((padding === 2 && contentLength % 4 !== 2) || (padding === 1 && contentLength % 4 !== 3))
    throw new Error('Inline image data is invalid.')
  for (let index = 0; index < contentLength; index += 1) {
    const code = data.charCodeAt(index)
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    if (!valid) throw new Error('Inline image data is invalid.')
  }
  const decodedSize = (data.length / 4) * 3 - padding
  if (decodedSize > maxBytes) throw new Error('Inline image exceeds the configured byte limit.')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data)
    throw new Error('Inline image data is not canonical base64.')
  return bytes
}

function checkDeadline(request: MediaLoadRequest): void {
  if (request.signal.aborted)
    throw new McpCoreError('CANCELLED', 'Image loading was cancelled.', true)
  if (Date.now() >= request.deadlineAt)
    throw new McpCoreError('TIMEOUT', 'Image loading deadline expired.', true)
}

function safeMediaFailure(error: unknown): McpCoreError {
  if (error instanceof McpCoreError) return error
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('cancel'))
    return new McpCoreError('CANCELLED', 'Image loading was cancelled.', true)
  if (message.includes('deadline') || message.includes('timed out'))
    return new McpCoreError('TIMEOUT', 'Image loading deadline expired.', true)
  if (message.includes('capacity'))
    return new McpCoreError('CAPACITY_LIMIT', 'Image loading capacity is full.', true)
  if (
    message.includes('outside') ||
    message.includes('not allowed') ||
    message.includes('invalid') ||
    message.includes('unsupported') ||
    message.includes('only for')
  )
    return new McpCoreError('INVALID_INPUT', 'Image source is invalid or not allowed.')
  if (
    message.includes('byte limit') ||
    message.includes('pixel limit') ||
    message.includes('exceeds')
  )
    return new McpCoreError('RESOURCE_LIMIT', 'Image exceeds a configured resource limit.')
  if (message.includes('not found'))
    return new McpCoreError('NOT_FOUND', 'Uploaded image was not found.')
  return new McpCoreError('MEDIA_UNAVAILABLE', 'Image could not be loaded.', true)
}

async function readLocalFile(
  pathInput: string,
  rootInput: string,
  request: MediaLoadRequest,
): Promise<Buffer> {
  checkDeadline(request)
  const root = await realpath(rootInput)
  const candidate = isAbsolute(pathInput) ? resolve(pathInput) : resolve(root, pathInput)
  const rootRelative = relative(root, candidate)
  if (
    rootRelative === '' ||
    rootRelative === '..' ||
    rootRelative.startsWith(`..${sep}`) ||
    isAbsolute(rootRelative)
  ) {
    throw new Error('Local image path is outside the configured input root.')
  }
  const canonical = await realpath(candidate)
  const canonicalRelative = relative(root, canonical)
  if (
    canonicalRelative === '..' ||
    canonicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(canonicalRelative)
  ) {
    throw new Error('Local image path is outside the configured input root.')
  }
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(request.maxBytes))
      throw new Error('Local image file is not a bounded regular file.')
    const chunks: Buffer[] = []
    const buffer = Buffer.alloc(Math.min(64 * 1024, request.maxBytes + 1))
    let total = 0
    while (total <= request.maxBytes) {
      checkDeadline(request)
      const length = Math.min(buffer.byteLength, request.maxBytes + 1 - total)
      const { bytesRead } = await handle.read(buffer, 0, length, total)
      if (bytesRead === 0) break
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      total += bytesRead
    }
    if (total > request.maxBytes)
      throw new Error('Local image file exceeds the configured byte limit.')
    const after = await handle.stat({ bigint: true })
    const rootAfter = await realpath(rootInput)
    const pathAfter = await realpath(candidate)
    const pathStatAfter = await stat(canonical, { bigint: true })
    if (
      rootAfter !== root ||
      pathAfter !== canonical ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(total) !== after.size ||
      pathStatAfter.dev !== after.dev ||
      pathStatAfter.ino !== after.ino
    ) {
      throw new Error('Local image changed while it was being read.')
    }
    checkDeadline(request)
    return Buffer.concat(chunks, total)
  } finally {
    await handle.close()
  }
}

async function ownBytes(
  value: Uint8Array,
  maxBytes: number,
  mediaType: string,
  maxPixels: number,
): Promise<ImagePayload> {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maxBytes) {
    throw new Error('Image bytes are empty or exceed the configured byte limit.')
  }
  const owned = Buffer.from(value)
  try {
    return await inspectImageBytes(owned, mediaType, maxPixels)
  } finally {
    owned.fill(0)
  }
}

export function createMediaPort(options: MediaLoaderOptions): MediaPort {
  const loadRemote = createRemoteImageLoader(options.remote)
  const maxPixels = options.maxPixels ?? 16_777_216
  return {
    async loadImage(request) {
      try {
        checkDeadline(request)
        if (request.source.kind === 'url' || request.source.kind === 'chatgptFile') {
          return await loadRemote(request)
        }
        if (request.source.kind === 'localPath') {
          if (request.principal.transport !== 'stdio' || !options.stdioInputRoot) {
            throw new Error(
              'Local paths are available only for an explicitly configured stdio input root.',
            )
          }
          const bytes = await readLocalFile(request.source.path, options.stdioInputRoot, request)
          try {
            return await ownBytes(bytes, request.maxBytes, 'application/octet-stream', maxPixels)
          } finally {
            bytes.fill(0)
          }
        }
        if (request.source.kind === 'uploadedId') {
          if (!options.readUploaded) throw new Error('Uploaded images are not configured.')
          const stored = await options.readUploaded({
            ownerId: request.principal.ownerId,
            id: request.source.id,
            signal: request.signal,
            deadlineAt: request.deadlineAt,
            maxBytes: request.maxBytes,
          })
          try {
            return await ownBytes(stored.bytes, request.maxBytes, stored.mediaType, maxPixels)
          } finally {
            stored.bytes.fill(0)
          }
        }
        const bytes = decodeInlineBase64(request.source.data, request.maxBytes)
        try {
          return await ownBytes(
            bytes,
            request.maxBytes,
            request.source.mediaType ?? 'application/octet-stream',
            maxPixels,
          )
        } finally {
          bytes.fill(0)
        }
      } catch (error) {
        throw safeMediaFailure(error)
      }
    },
  }
}
