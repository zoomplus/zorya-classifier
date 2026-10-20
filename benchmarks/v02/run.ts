import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { runDiagnostic } from './runner.js'

export function parseV02RunnerArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      'allow-paid': { type: 'boolean', default: false },
      'max-physical-calls': { type: 'string' },
      'max-cost-usd': { type: 'string' },
      'image-root': { type: 'string', default: '/root/work/zorya-classifier/benchmarks/corpus' },
      out: { type: 'string', default: '.run/v02' },
      'prompt-variant': { type: 'string', default: 'grammar-plus-examples' },
      cases: { type: 'string', default: '4' },
    },
  })
  if (
    !values['allow-paid'] ||
    values['max-physical-calls'] === undefined ||
    values['max-cost-usd'] === undefined
  )
    throw new Error(
      'Paid diagnostic requires --allow-paid --max-physical-calls N --max-cost-usd USD',
    )
  return {
    imageRoot: resolve(z.string().min(1).parse(values['image-root'])),
    outputRoot: resolve(z.string().min(1).parse(values.out)),
    maxPhysicalCalls: z.coerce.number().int().min(1).max(250).parse(values['max-physical-calls']),
    maxCostUsd: z.coerce.number().positive().max(5).parse(values['max-cost-usd']),
    promptVariant: z
      .enum(['no-grammar', 'grammar', 'grammar-plus-examples'])
      .parse(values['prompt-variant']),
    caseLimit: z.coerce
      .number()
      .int()
      .refine((value): value is 2 | 4 => value === 2 || value === 4)
      .parse(values.cases),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runDiagnostic(parseV02RunnerArgs(process.argv.slice(2)))
    process.stdout.write(
      JSON.stringify({
        runId: result.runId,
        status: result.status,
        resultCount: result.resultCount,
        aggregate: result.aggregate,
        latency: result.latency,
        outputDirectory: result.outputDirectory,
      }) + '\n',
    )
    if (result.status !== 'complete') process.exitCode = 1
  } catch {
    process.stderr.write(
      'v0.2 diagnostic stopped before completion; inspect its immutable stage artifacts. Credentials and provider error bodies are never printed.\n',
    )
    process.exitCode = 1
  }
}
