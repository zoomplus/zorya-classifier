import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freshCaseSchema, type FreshCase } from './fresh-corpus.js'

const photoSourceSha256 = 'f0be4b9b2d5a11bd77f1b890860745c3bf17dd185b5cc1fb73c1af674c9465d5'
const uiSourceSha256 = '598da2b326e8d4cbedf1ca0517ce6ecccc8d141125ee53a88ef397aa9a5ea0a2'
const mapSourceSha256 = 'afb2e521962573709ab25ddf53beab4f17d2e33c74192c4fd9218cc34e03efb3'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError(`${label} must be a nonempty string`)
  return value
}

function dimension(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${label} must be a positive integer`)
  return value
}

/** Copy only the fixed producer fields; truth, geometry, and annotations are never read. */
export function copyAuthoredFreshCase(sourceValue: unknown, imagePath: string): FreshCase {
  const source = record(sourceValue, 'Source case')
  const sourceImage = record(source.image, 'Source image')
  const sourceLocate = record(source.locate, 'Source locate prompt')
  const sourceClassify = record(source.classify, 'Source classify prompt')
  const result = {
    caseId: text(source.caseId, 'caseId'),
    image: {
      path: imagePath,
      sha256: text(sourceImage.sha256, 'image.sha256'),
      width: dimension(sourceImage.width, 'image.width'),
      height: dimension(sourceImage.height, 'image.height'),
    },
    locate: {
      target: text(sourceLocate.target, 'locate.target'),
      ...(typeof sourceLocate.instruction === 'string'
        ? { instruction: sourceLocate.instruction }
        : {}),
    },
    classify: {
      ...(typeof sourceClassify.question === 'string' ? { question: sourceClassify.question } : {}),
      options: sourceClassify.options,
    },
  }
  return freshCaseSchema.parse(result)
}

function relativeImagePath(imageRoot: string, pathValue: unknown): string {
  const raw = text(pathValue, 'image.path')
  const absolute = resolve(imageRoot, raw)
  const value = relative(imageRoot, absolute)
  if (!value || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value))
    throw new Error('Source image path escaped the image root')
  return value.split(sep).join('/')
}

async function installImageAlias(
  imageRoot: string,
  relativeAlias: string,
  sourcePath: string,
): Promise<string> {
  const canonicalImages = resolve(imageRoot, relativeAlias)
  const originalImages = await realpath(resolve(imageRoot, sourcePath))
  await mkdir(dirname(canonicalImages), { recursive: true })
  try {
    const info = await lstat(canonicalImages)
    if (!info.isSymbolicLink() || (await realpath(canonicalImages)) !== originalImages)
      throw new Error('Canonical map image alias already exists with different content')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await symlink(originalImages, canonicalImages, 'dir')
  }
  return relativeAlias.split(sep).join('/')
}

async function readJsonArray(path: string, expectedSha256: string): Promise<unknown[]> {
  const bytes = await readFile(path)
  if (digest(bytes) !== expectedSha256) throw new Error(`Source manifest pin mismatch: ${path}`)
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  if (!Array.isArray(value)) throw new Error(`Source manifest is not a JSON array: ${path}`)
  return value
}

async function writeExclusive(path: string, value: unknown): Promise<string> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  await writeFile(path, bytes, { flag: 'wx' })
  return digest(bytes)
}

function authoredLabelList(source: string, name: 'positives' | 'negatives'): string[] {
  const match = source.match(new RegExp(`^\\s*${name}=\\[([^\\n]*)\\]$`, 'mu'))
  if (!match) throw new Error(`UI source generator is missing its ${name} list`)
  const tokens = [...match[1]!.matchAll(/'([^']*)'/gu)].map((item) => item[1]!)
  if (!tokens.length || match[1]!.replace(/'[^']*'/gu, '').replace(/[\s,]/gu, ''))
    throw new Error(`UI source generator ${name} list is not a literal string list`)
  return tokens
}

const uiTargetTemplate =
  'the visible AbiWord toolbar button for the {action} action, including the whole visible painted button background and border'
const uiClassificationQuestionTemplate =
  'Is there a visible AbiWord toolbar button whose action is {action}?'

export async function deriveHeldoutProducerInputs(imageRootInput: string, outputDirInput: string) {
  const imageRoot = await realpath(imageRootInput)
  const outputDir = resolve(outputDirInput)
  await mkdir(outputDir, { recursive: true })
  const cache = resolve(imageRoot, 'benchmarks/cache/v02/corpus')
  const photoPath = resolve(cache, 'inputs-heldout.json')
  const mapPath = resolve(
    imageRoot,
    '.run/v02-heldout-openttd-independent-v1/frozen-v1/inputs.json',
  )
  const uiPath = resolve(imageRoot, '.run/v02-heldout-abiword-independent-v1/run03/inputs.jsonl')
  const uiGeneratorPath = resolve(
    imageRoot,
    '.run/v02-heldout-abiword-independent-v1/run03/capture_cases.py',
  )
  const photos = await readJsonArray(photoPath, photoSourceSha256)
  const maps = await readJsonArray(mapPath, mapSourceSha256)
  const uiBytes = await readFile(uiPath)
  if (digest(uiBytes) !== uiSourceSha256) throw new Error('UI source manifest pin mismatch')
  const uiRows = uiBytes
    .toString('utf8')
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as unknown)
  const uiGeneratorBytes = await readFile(uiGeneratorPath)
  const uiGenerator = uiGeneratorBytes.toString('utf8')
  if (!uiGenerator.includes("'abiword-ui-{ix+1:02d}'"))
    throw new Error('UI source generator no longer binds sequential input IDs to case order')
  const uiPositiveLabels = authoredLabelList(uiGenerator, 'positives')
  const uiNegativeLabels = authoredLabelList(uiGenerator, 'negatives')
  if (uiPositiveLabels.length !== 15 || uiNegativeLabels.length !== 5)
    throw new Error('UI source generator target counts no longer match the frozen 15/5 stratum')
  const mapPrefix = await installImageAlias(
    imageRoot,
    'benchmarks/cache/v02/corpus/canonical-paths/heldout-openttd/images',
    '.run/v02-heldout-openttd-independent-v1/frozen-v1/images',
  )
  const uiPrefix = await installImageAlias(
    imageRoot,
    'benchmarks/cache/v02/corpus/canonical-paths/heldout-abiword/images',
    '.run/v02-heldout-abiword-independent-v1/run03/images',
  )

  const photoCases = photos.map((item) => {
    const source = record(item, 'Photo source')
    const sourceImage = record(source.image, 'Photo image')
    return copyAuthoredFreshCase(item, relativeImagePath(imageRoot, sourceImage.path))
  })
  const mapCases = maps.map((item) => {
    const source = record(item, 'Map source')
    const sourceImage = record(source.image, 'Map image')
    const oldRelativePath = text(sourceImage.path, 'map image.path')
    const prefix = '.run/v02-heldout-openttd-independent-v1/frozen-v1/images/'
    if (!oldRelativePath.startsWith(prefix))
      throw new Error('Map source image path does not match the frozen source layout')
    const imagePath = `${mapPrefix}/${basename(oldRelativePath)}`
    return copyAuthoredFreshCase(item, imagePath)
  })
  const uiCases = uiRows.map((item, index) => {
    const source = record(item, 'UI source input')
    const caseId = text(source.id, 'UI source id')
    const expectedId = `abiword-ui-${String(index + 1).padStart(2, '0')}`
    if (caseId !== expectedId) throw new Error('UI source case order does not match its generator')
    const imageSourcePath = text(source.path, 'UI source path')
    if (!/^images\/[A-Za-z0-9_-]+\.png$/u.test(imageSourcePath))
      throw new Error('UI source image path is outside the frozen screenshot layout')
    if (!Array.isArray(source.size) || source.size.length !== 2)
      throw new Error('UI source image dimensions are missing')
    const imagePath = `${uiPrefix}/${basename(imageSourcePath)}`
    const action =
      index < uiPositiveLabels.length
        ? uiPositiveLabels[index]!
        : uiNegativeLabels[index - uiPositiveLabels.length]!
    const sourceCase = {
      caseId,
      image: {
        path: imagePath,
        sha256: source.sha256,
        width: dimension(source.size[0], 'UI image width'),
        height: dimension(source.size[1], 'UI image height'),
      },
      locate: { target: uiTargetTemplate.replace('{action}', action) },
      classify: {
        question: uiClassificationQuestionTemplate.replace('{action}', action),
        options: ['present', 'absent'],
      },
    }
    return freshCaseSchema.parse(sourceCase)
  })
  const photoOutput = resolve(outputDir, 'photo-inputs.json')
  const uiOutput = resolve(outputDir, 'ui-inputs.json')
  const mapOutput = resolve(outputDir, 'map-inputs.json')
  const idMapOutput = resolve(outputDir, 'image-id-map.json')
  const photoSha256 = await writeExclusive(photoOutput, photoCases)
  const uiSha256 = await writeExclusive(uiOutput, uiCases)
  const mapSha256 = await writeExclusive(mapOutput, mapCases)
  const mappingSha256 = await writeExclusive(
    idMapOutput,
    [...photoCases, ...uiCases, ...mapCases].map((item) => ({
      caseId: item.caseId,
      imageSha256: item.image.sha256,
      imagePath: item.image.path,
    })),
  )
  const promptHash = (cases: readonly FreshCase[]) =>
    digest(
      Buffer.from(
        JSON.stringify(cases.map(({ caseId, locate, classify }) => ({ caseId, locate, classify }))),
      ),
    )
  const conversionCodeSha256 = digest(await readFile(fileURLToPath(import.meta.url)))
  const uiTemplateSha256 = digest(
    Buffer.from(`${uiTargetTemplate}\n${uiClassificationQuestionTemplate}\n`),
  )
  const result = {
    imageRoot,
    conversionCodeSha256,
    uiGeneratorSha256: digest(uiGeneratorBytes),
    sourcePins: {
      photo: { sha256: photoSourceSha256, cases: photos.length },
      ui: { sha256: uiSourceSha256, records: uiRows.length, format: 'jsonl' },
      map: { sha256: mapSourceSha256, cases: maps.length },
    },
    canonical: {
      photo: { path: photoOutput, sha256: photoSha256, cases: photoCases.length },
      ui: { path: uiOutput, sha256: uiSha256, cases: uiCases.length },
      map: { path: mapOutput, sha256: mapSha256, cases: mapCases.length },
      imageIdMap: { path: idMapOutput, sha256: mappingSha256, cases: 80 },
    },
    promptIdentity: {
      sha256: promptHash([...photoCases, ...uiCases, ...mapCases]),
      uiTemplateSha256,
      canonicalizedCases: photoCases.length + uiCases.length + mapCases.length,
      completeHeldoutIdentityAvailable: true,
    },
    uiTemplate: {
      target: uiTargetTemplate,
      classificationQuestion: uiClassificationQuestionTemplate,
    },
    uiActionMapping: {
      sha256: digest(
        Buffer.from(
          JSON.stringify(uiCases.map(({ caseId, locate }) => ({ caseId, target: locate.target }))),
        ),
      ),
      cases: uiCases.length,
      source: 'capture_cases.py ordered planned action lists and sequential case IDs',
    },
  }
  const provenancePath = resolve(outputDir, 'provenance.json')
  const provenanceSha256 = await writeExclusive(provenancePath, result)
  return { ...result, provenance: { path: provenancePath, sha256: provenanceSha256 } }
}

async function main(): Promise<void> {
  const [imageRoot, outputDir] = process.argv.slice(2)
  if (!imageRoot || !outputDir || process.argv.length !== 4)
    throw new Error('Usage: derive-heldout-inputs <image-root> <exclusive-output-directory>')
  console.log(JSON.stringify(await deriveHeldoutProducerInputs(imageRoot, outputDir), null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
