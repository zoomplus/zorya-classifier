import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { runRegionGrabCutComponent } from './region-grabcut-component.js'

export function parseRegionGrabCutComponentArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      'allow-native': { type: 'boolean', default: false },
      summary: { type: 'string' },
      'original-run': { type: 'string' },
      'image-root': { type: 'string' },
      'corpus-root': { type: 'string' },
      asset: { type: 'string' },
      out: { type: 'string' },
    },
  })
  if (!values['allow-native'])
    throw new TypeError('Choose --allow-native to start CPU component work')
  const parsed = z
    .object({
      summary: z.string().min(1),
      'original-run': z.string().min(1),
      'image-root': z.string().min(1),
      'corpus-root': z.string().min(1),
      asset: z.string().min(1),
      out: z.string().min(1),
      'allow-native': z.literal(true),
    })
    .strict()
    .parse(values)
  return {
    summaryPath: resolve(parsed.summary),
    originalRunDir: resolve(parsed['original-run']),
    imageRoot: resolve(parsed['image-root']),
    corpusRoot: resolve(parsed['corpus-root']),
    assetPath: resolve(parsed.asset),
    outputRoot: resolve(parsed.out),
  }
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseRegionGrabCutComponentArgs(args)
  const output = await runRegionGrabCutComponent(options)
  process.stdout.write(`${output}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main()
