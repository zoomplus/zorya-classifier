#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { createClassifier } from './index.js'
import { createCliDecision } from './app/cli-route.js'
import { parseCliArguments } from './app/cli-arguments.js'
import { writeExtractionFiles } from './app/extraction-files.js'
import { createMobileSamSegmenter, createGrabCutSegmenter } from './segmentation.js'
import type { SegmentationPort } from './index.js'

async function main() {
  const args = parseCliArguments(process.argv.slice(2))
  if (args.command === 'help') {
    console.log(
      'zorya-classifier classify-text <text> <classes.json>\nzorya-classifier classify-image <image> <classes.json>\nzorya-classifier locate <image> <target> [--mode region|whole-object]\nzorya-classifier extract <image> <target> --output <prefix> --backend mobile-sam --encoder <path> --decoder <path> [--provider cpu|dml]\nzorya-classifier extract <image> <target> --output <prefix> --backend grabcut --opencv <path>\nSet ZORYA_MODEL. Default ZORYA_MODE=decisions; use chat for ordinary vision models/custom chat endpoints. OpenRouter: OPENROUTER_API_KEY + ZORYA_PROVIDER. Direct: ZORYA_ENDPOINT + optional ZORYA_API_KEY. Optional ZORYA_REASONING_EFFORT and ZORYA_RESPONSE_FORMAT. One classify request; up to three region or six whole-object requests. Extraction additionally runs the explicit local backend. Output files are never overwritten; native assets are never downloaded automatically.',
    )
    return
  }
  const { command, value, target } = args
  const decision = createCliDecision(process.env)
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  let segmenter: SegmentationPort | undefined
  let client: ReturnType<typeof createClassifier> | undefined
  try {
    // Validate local data before creating a native worker or dispatching any model request.
    const image = command === 'classify-text' ? undefined : await readFile(value)
    let classes
    if (command === 'classify-text' || command === 'classify-image') {
      const { z } = await import('zod')
      const { classSchema, limits } = await import('./entities/contracts.js')
      const unknownClasses: unknown = JSON.parse(await readFile(target, 'utf8'))
      classes = z.array(classSchema).min(2).max(limits.maxClasses).parse(unknownClasses)
    }
    controller.signal.throwIfAborted()
    if (command === 'extract')
      segmenter =
        args.backend === 'mobile-sam'
          ? await createMobileSamSegmenter({
              encoderPath: args.encoder!,
              decoderPath: args.decoder!,
              executionProvider: args.provider ?? 'cpu',
            })
          : await createGrabCutSegmenter({ assetPath: args.opencv! })
    client = createClassifier({ decision, ...(segmenter ? { segmentation: segmenter } : {}) })
    controller.signal.throwIfAborted()
    if (command === 'locate') {
      console.log(
        JSON.stringify(
          await client.locate({
            image: image!,
            target,
            ...(args.mode ? { mode: args.mode } : {}),
            signal: controller.signal,
          }),
          null,
          2,
        ),
      )
    } else if (command === 'extract') {
      const result = await client.extract({ image: image!, target, signal: controller.signal })
      console.log(
        JSON.stringify(
          result.status === 'extracted'
            ? { status: result.status, files: await writeExtractionFiles(args.output!, result) }
            : result,
          null,
          2,
        ),
      )
    } else {
      const input = command === 'classify-text' ? value : { image: image! }
      console.log(
        JSON.stringify(
          await client.classify({ input, classes: classes!, signal: controller.signal }),
          null,
          2,
        ),
      )
    }
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    try {
      await client?.dispose()
    } finally {
      await segmenter?.dispose()
    }
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Command failed')
  process.exitCode = 1
})
