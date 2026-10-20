import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  preflightPointCandidateChoice,
  readPointCandidateOpenRouterKey,
  runPointCandidateChoice,
} from './point-candidate-choice.js'

const candidatePins = [
  {
    path: '/root/work/zorya-classifier-worktrees/v02/a3/.run/point-proposal-contact-sheets-alias-safe-final.json',
    sha256: '2e46c49f1031340b0739b69ea0f7a0319328c97b8bbc9b73e707f52b8105f824',
  },
  {
    path: '/root/work/zorya-classifier-worktrees/v02/a3/.run/point-proposals-extra-batch-1-alias.json',
    sha256: '41aa57b4a8219b651405eacdf0a40cdb98b9d2704f0c083a928a1597be1829d0',
  },
  {
    path: '/root/work/zorya-classifier-worktrees/v02/a3/.run/point-proposals-extra-batch-2-alias.json',
    sha256: 'e7f43d60e3930003726d044b88a4bbebdf678da21c660e6b53eb7b5dfb5d0c6b',
  },
] as const
const inputPins = [
  {
    path: resolve('benchmarks/v02/corpus/dev/inputs.json'),
    sha256: '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a',
  },
  {
    path: resolve('benchmarks/v02/corpus/dev-independent-ui/inputs.json'),
    sha256: '6013a54bebba277f6457765cd8ef78e12e2dd5bab4453a752967233ebb429bfc',
  },
] as const

async function main(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      'allow-paid': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'image-root': { type: 'string', default: '/root/work/zorya-classifier-worktrees/v02/corpus' },
      out: { type: 'string', default: '.run/v02' },
    },
  })
  if (Boolean(values['allow-paid']) === Boolean(values['dry-run']))
    throw new Error('Choose exactly one of --allow-paid or --dry-run')
  const options = {
    contactSheetManifests: candidatePins.map((item) => ({ ...item })),
    inputManifests: inputPins.map((item) => ({ ...item })),
    imageRoot: resolve(z.string().min(1).parse(values['image-root'])),
    outputRoot: resolve(z.string().min(1).parse(values.out)),
  }
  if (values['dry-run']) return preflightPointCandidateChoice(options)
  const result = await runPointCandidateChoice({
    ...options,
    apiKey: await readPointCandidateOpenRouterKey(),
  })
  return {
    runId: result.runId,
    status: result.status,
    plannedCases: result.plannedCaseAliases.length,
    completedCases: result.completedCaseAliases.length,
    aggregate: result.aggregate,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(await main(process.argv.slice(2))) + '\n')
  } catch {
    process.stderr.write(
      'Point candidate choice stopped; inspect immutable local evidence. Credentials, paths and provider bodies are never printed.\n',
    )
    process.exitCode = 1
  }
}
