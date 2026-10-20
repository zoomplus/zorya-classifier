import { parseArgs } from 'node:util'
import { z } from 'zod'
import { parse } from '../entities/contracts.js'
import { ClassifierError } from '../entities/errors.js'

const schema = z
  .object({
    command: z.enum(['classify-text', 'classify-image', 'locate', 'extract']),
    value: z.string().min(1),
    target: z.string().min(1),
    mode: z.enum(['region', 'whole-object']).optional(),
    output: z.string().min(1).optional(),
    backend: z.enum(['mobile-sam', 'grabcut']).optional(),
    encoder: z.string().min(1).optional(),
    decoder: z.string().min(1).optional(),
    opencv: z.string().min(1).optional(),
    provider: z.enum(['cpu', 'dml']).optional(),
  })
  .strict()
type CliArguments = z.infer<typeof schema>

export function parseCliArguments(args: string[]): CliArguments | { command: 'help' } {
  let raw: ReturnType<typeof parseArgs>
  try {
    raw = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        mode: { type: 'string' },
        output: { type: 'string' },
        backend: { type: 'string' },
        encoder: { type: 'string' },
        decoder: { type: 'string' },
        opencv: { type: 'string' },
        provider: { type: 'string' },
      },
    })
  } catch {
    throw new ClassifierError('INVALID_INPUT', 'Invalid CLI arguments; use --help')
  }
  if (raw.values['help'] || raw.positionals.length === 0) return { command: 'help' }
  if (raw.positionals.length !== 3)
    throw new ClassifierError(
      'INVALID_INPUT',
      'Expected command, input and target/classes; use --help',
    )
  const { help: _help, ...values } = raw.values
  const parsed = parse(schema, {
    ...values,
    command: raw.positionals[0],
    value: raw.positionals[1],
    target: raw.positionals[2],
  })
  const nativeFlags = ['backend', 'encoder', 'decoder', 'opencv', 'provider', 'output'] as const
  if (parsed.command !== 'extract' && nativeFlags.some((key) => parsed[key] !== undefined))
    throw new ClassifierError('INVALID_INPUT', 'Native/output flags apply only to extract')
  if (parsed.mode !== undefined && !['locate', 'extract'].includes(parsed.command))
    throw new ClassifierError('INVALID_INPUT', 'Mode applies only to image localization')
  if (parsed.command === 'extract') {
    if (!parsed.output || !parsed.backend || parsed.mode === 'region')
      throw new ClassifierError(
        'INVALID_INPUT',
        'extract requires --output and explicit --backend, and uses whole-object mode',
      )
    if (parsed.backend === 'mobile-sam' && (!parsed.encoder || !parsed.decoder || parsed.opencv))
      throw new ClassifierError('INVALID_INPUT', 'mobile-sam requires --encoder and --decoder')
    if (
      parsed.backend === 'grabcut' &&
      (!parsed.opencv || parsed.encoder || parsed.decoder || parsed.provider)
    )
      throw new ClassifierError(
        'INVALID_INPUT',
        'grabcut requires --opencv; model/provider flags do not apply',
      )
  }
  return parsed
}
