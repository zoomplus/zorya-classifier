import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { buildHeldoutPlans, verifyHeldoutFreezeBytes } from './categorical-heldout-plan.js'
import {
  readFreshProposalOpenRouterKey,
  runCategoricalPresenceFreshHeldout,
} from './categorical-presence-fresh-runner.js'
import {
  readFreshTextOpenRouterKey,
  runCategoricalHeldoutNoImageControl,
} from './fresh-text-runner.js'

const defaultEncoder =
  '/root/work/zorya-worktrees/locator-segmentation-model/.run/segmentation-model/models/mobile_sam_image_encoder.onnx'
const defaultDecoder =
  '/root/work/zorya-worktrees/locator-segmentation-model/.run/segmentation-model/models/sam_mask_decoder_multi.onnx'

export type HeldoutProfile = 'candidate' | 'no-image-control'

export function parseCategoricalHeldoutArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      'allow-paid': { type: 'boolean', default: false },
      profile: { type: 'string' },
      freeze: { type: 'string' },
      'freeze-sha256': { type: 'string' },
      'image-root': { type: 'string' },
      'photo-inputs': { type: 'string' },
      'ui-inputs': { type: 'string' },
      'map-inputs': { type: 'string' },
      encoder: { type: 'string', default: defaultEncoder },
      decoder: { type: 'string', default: defaultDecoder },
      out: { type: 'string', default: '.run/v02' },
    },
  })
  if (!values['allow-paid'])
    throw new Error('HELDOUT dispatch is disabled without the explicit allow-paid flag')
  if (values.profile !== 'candidate' && values.profile !== 'no-image-control')
    throw new TypeError('Select exactly one HELDOUT profile')
  const common = {
    freezePath: resolve(z.string().min(1).parse(values.freeze)),
    freezeSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .parse(values['freeze-sha256']),
    imageRoot: resolve(z.string().min(1).parse(values['image-root'])),
    outputRoot: resolve(z.string().min(1).parse(values.out)),
    photoInputs: resolve(z.string().min(1).parse(values['photo-inputs'])),
  }
  if (values.profile === 'candidate')
    return {
      profile: 'candidate' as const,
      ...common,
      uiInputs: resolve(z.string().min(1).parse(values['ui-inputs'])),
      mapInputs: resolve(z.string().min(1).parse(values['map-inputs'])),
      encoderPath: resolve(z.string().min(1).parse(values.encoder)),
      decoderPath: resolve(z.string().min(1).parse(values.decoder)),
    }
  return { profile: 'no-image-control' as const, ...common }
}

async function loadFreeze(path: string, expectedSha256: string): Promise<unknown> {
  const bytes = await readFile(path)
  try {
    return verifyHeldoutFreezeBytes(bytes, expectedSha256)
  } finally {
    bytes.fill(0)
  }
}

export async function runCategoricalHeldout(args: readonly string[]) {
  const options = parseCategoricalHeldoutArgs(args)
  const freeze = await loadFreeze(options.freezePath, options.freezeSha256)
  const plans = buildHeldoutPlans(freeze)
  const startedAt = new Date().toISOString()
  const dispatcherRunId = `v02-heldout-dispatch-${startedAt.replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  await mkdir(options.outputRoot, { recursive: true })
  const dispatchPath = resolve(options.outputRoot, `${dispatcherRunId}-start.json`)
  await writeFile(
    dispatchPath,
    `${JSON.stringify(
      {
        schema: 'categorical-heldout-dispatch-v1',
        dispatcherRunId,
        phase: 'heldout',
        profile: options.profile,
        freezeSha256: options.freezeSha256,
        startedAt,
        state: 'dispatching',
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  )
  try {
    let result: { outputDirectory?: string; status?: string }
    if (options.profile === 'candidate') {
      const apiKey = await readFreshProposalOpenRouterKey()
      result = await runCategoricalPresenceFreshHeldout(
        {
          manifests: [
            { path: options.photoInputs, sha256: plans.candidate.manifests[0]!.sha256 },
            { path: options.uiInputs, sha256: plans.candidate.manifests[1]!.sha256 },
            { path: options.mapInputs, sha256: plans.candidate.manifests[2]!.sha256 },
          ],
          imageRoot: options.imageRoot,
          outputRoot: options.outputRoot,
          apiKey,
          encoderPath: options.encoderPath,
          decoderPath: options.decoderPath,
        },
        freeze,
      )
    } else {
      const apiKey = await readFreshTextOpenRouterKey()
      result = await runCategoricalHeldoutNoImageControl(
        {
          manifests: [{ path: options.photoInputs, sha256: plans.noImage.manifest.sha256 }],
          imageRoot: options.imageRoot,
          outputRoot: options.outputRoot,
          apiKey,
        },
        freeze,
      )
    }
    await writeFile(
      resolve(options.outputRoot, `${dispatcherRunId}-complete.json`),
      `${JSON.stringify(
        {
          schema: 'categorical-heldout-dispatch-complete-v1',
          dispatcherRunId,
          profile: options.profile,
          status: result.status ?? 'completed',
          outputDirectory: result.outputDirectory ?? null,
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    )
    return { dispatcherRunId, dispatchPath, result }
  } catch (error) {
    await writeFile(
      resolve(options.outputRoot, `${dispatcherRunId}-incomplete.json`),
      `${JSON.stringify(
        {
          schema: 'categorical-heldout-dispatch-incomplete-v1',
          dispatcherRunId,
          profile: options.profile,
          finishedAt: new Date().toISOString(),
          errorCode:
            error &&
            typeof error === 'object' &&
            'code' in error &&
            [
              'INVALID_INPUT',
              'INVALID_RESPONSE',
              'RESOURCE_LIMIT',
              'UNSUPPORTED',
              'CAPACITY',
              'TIMEOUT',
              'ABORTED',
              'DISPOSED',
              'PROVIDER',
              'AUTHENTICATION',
              'V02_RUN_BUDGET_EXHAUSTED',
            ].includes(String(error.code))
              ? String(error.code)
              : 'RUNNER_FAILURE',
        },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    )
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(await runCategoricalHeldout(process.argv.slice(2))) + '\n')
  } catch {
    process.stderr.write(
      'Categorical HELDOUT run stopped; inspect immutable local artifacts. Credentials, source paths and provider bodies are never printed.\n',
    )
    process.exitCode = 1
  }
}
