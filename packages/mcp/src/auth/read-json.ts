import type { z } from 'zod'

export async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new Error('Authentication response exceeded its size limit.')
  }
  if (!response.body) throw new Error('Authentication response body is missing.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        for (const chunk of chunks) chunk.fill(0)
        next.value.fill(0)
        await reader.cancel()
        throw new Error('Authentication response exceeded its size limit.')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  )
  for (const chunk of chunks) chunk.fill(0)
  return result
}

export async function readJsonResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  maxBytes: number,
): Promise<T> {
  const bytes = await readResponseBytes(response, maxBytes)
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    return schema.parse(parsed)
  } finally {
    bytes.fill(0)
  }
}
