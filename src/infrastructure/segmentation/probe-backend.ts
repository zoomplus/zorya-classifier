import { ClassifierError } from '../../entities/errors.js'
import { NativeChildPool } from './native-child.js'
import { nativeErrorReplySchema, nativeProbeReplySchema } from './native-protocol.js'

export async function probeBackend(
  workerUrl: URL,
  backend: 'mobile-sam' | 'grabcut',
  payload: Record<string, unknown>,
): Promise<void> {
  const pool = new NativeChildPool<Record<string, unknown>>({
    workerUrl,
    maxActive: 1,
    maxWaiting: 2,
    jobTimeoutMs: 10_000,
    abortGraceMs: 250,
    encode: (job) => Buffer.from(JSON.stringify({ id: job.id, ...job.payload })),
    decode: (raw, id) => {
      const error = nativeErrorReplySchema.safeParse(raw)
      if (error.success) {
        if (error.data.id !== id)
          throw new ClassifierError('INVALID_RESPONSE', 'Backend probe error ID mismatch')
        throw new ClassifierError(error.data.code, error.data.message)
      }
      const reply = nativeProbeReplySchema.safeParse(raw)
      if (!reply.success || reply.data.id !== id || reply.data.backend !== backend)
        throw new ClassifierError(
          'INVALID_RESPONSE',
          'Native backend probe returned an invalid reply',
        )
      return reply.data
    },
  })
  try {
    await pool.run({ ...payload, kind: `probe-${backend}` }, new AbortController().signal)
  } finally {
    await pool.dispose()
  }
}
