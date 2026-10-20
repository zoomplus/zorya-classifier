import { readFile } from 'node:fs/promises'
import { z } from 'zod'

/** Historical evaluator fixtures must not silently inherit today's runtime closure. */
export async function historicalRuntimeSourcePaths(): Promise<string[]> {
  const review = z
    .object({ sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)) })
    .parse(
      JSON.parse(
        await readFile(
          new URL(
            '../../docs/evidence/v02/box-heldout-source-review-20261020-v1.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    )
  const paths = Object.keys(review.sourceHashes).filter((path) => path.startsWith('src/'))
  if (paths.length !== 53) throw new Error('Historical runtime fixture must retain its 53 sources')
  return paths
}
