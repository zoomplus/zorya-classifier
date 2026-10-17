import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { runBenchmark } from './runner.js'

export function parseBenchmarkArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      mode: { type: 'string' },
      'allow-paid': { type: 'boolean', default: false },
      'max-calls': { type: 'string' },
      'max-cost-usd': { type: 'string' },
      corpus: { type: 'string', default: 'benchmarks/corpus' },
      out: { type: 'string' },
      split: { type: 'string', default: 'all' },
      limit: { type: 'string' },
    },
  })
  const mode = z.enum(['offline', 'live']).parse(values.mode),
    split = z.enum(['all', 'dev', 'heldout']).parse(values.split)
  if (
    mode === 'live' &&
    (!values['allow-paid'] ||
      values['max-calls'] === undefined ||
      values['max-cost-usd'] === undefined)
  )
    throw new Error('Live requires explicit --allow-paid --max-calls N --max-cost-usd USD')
  return {
    mode,
    allowPaid: values['allow-paid'],
    maxCalls: z.coerce
      .number()
      .int()
      .min(1)
      .max(360)
      .parse(values['max-calls'] ?? 360),
    maxCostUsd: z.coerce
      .number()
      .positive()
      .max(1)
      .parse(values['max-cost-usd'] ?? 1),
    corpusDirectory: z.string().min(1).parse(values.corpus),
    outputDirectory: z.string().min(1).parse(values.out),
    splits: split === 'all' ? (['dev', 'heldout'] as const) : [split],
    ...(values.limit === undefined
      ? {}
      : { limit: z.coerce.number().int().min(1).max(60).parse(values.limit) }),
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runBenchmark(parseBenchmarkArgs(process.argv.slice(2)))
    process.stdout.write(JSON.stringify(result) + '\n')
    if (result.status !== 'complete') process.exitCode = 1
  } catch {
    process.stderr.write(
      'Benchmark failed before a terminal report. Check arguments, corpus, output directory and stage artifacts; no credentials are printed.\n',
    )
    process.exitCode = 1
  }
}
