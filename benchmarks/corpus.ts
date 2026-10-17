import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { z } from 'zod'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const rect = z
  .tuple([
    z.number().min(0).max(1),
    z.number().min(0).max(1),
    z.number().min(0).max(1),
    z.number().min(0).max(1),
  ])
  .refine((v) => v[0] < v[2] && v[1] < v[3])
const photoSchema = z
  .object({
    caseId: z.string().regex(/^photo-(dev|heldout)-\d+$/u),
    image: z
      .object({
        path: z.string(),
        sha256: hash,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    locate: z.object({ target: z.string(), instruction: z.string() }).strict(),
    classify: z
      .object({
        question: z.string(),
        options: z.tuple([z.literal('present'), z.literal('absent')]),
      })
      .strict(),
  })
  .strict()
const photoTruthSchema = z
  .object({
    caseId: z.string(),
    expectedPresence: z.enum(['present', 'absent']),
    targetBoxes: z.array(z.object({ xyxy: rect }).passthrough()),
    negativeEvidence: z
      .object({
        type: z.literal('explicit-human-verified-image-label'),
        source: z.literal('verification'),
        confidence: z.literal(0),
      })
      .passthrough()
      .nullable(),
    stratum: z.string(),
    tags: z.array(z.string()),
  })
  .passthrough()
const textTruthSchema = z
  .object({
    split: z.enum(['dev', 'heldout']),
    examples: z.array(
      z
        .object({
          input_index: z.number().int().nonnegative(),
          id: z.string().regex(/^support-(dev|heldout)-\d+$/u),
          expected_label: z.string(),
          text_sha256: hash,
        })
        .passthrough(),
    ),
  })
  .passthrough()
const policySchema = z
  .object({
    task: z.string(),
    rules: z.array(z.string()),
    classes: z.array(z.object({ id: z.string(), definition: z.string() }).strict()),
  })
  .strict()
export type Split = 'dev' | 'heldout'
export type PhotoCase = z.infer<typeof photoSchema> & { split: Split }
export type PhotoTruth = z.infer<typeof photoTruthSchema>
export type TextCase = { caseId: string; split: Split; text: string }
export type TextTruth = { caseId: string; expected: string }
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')
export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
function local(root: string, path: string): string {
  const resolved = resolve(root, path)
  if (!resolved.startsWith(resolve(root) + sep))
    throw new Error('Corpus file must remain inside corpus root')
  return resolved
}
export async function loadCorpus(root: string, splits: readonly Split[], limit?: number) {
  const policy = policySchema.parse(await readJson(local(root, 'text/inputs/policy.json')))
  const photos: PhotoCase[] = [],
    texts: TextCase[] = [],
    photoTruth = new Map<string, PhotoTruth>(),
    textTruth = new Map<string, TextTruth>()
  const manifests: Record<string, string> = {}
  for (const path of [
    'corpus-manifest.json',
    'photo-manifest.json',
    'text/text-manifest.json',
    'text/inputs/policy.json',
  ])
    manifests[path] = sha256(await readFile(local(root, path)))
  for (const split of splits) {
    const inputPath = `inputs/${split}.json`,
      truthPath = `ground-truth/${split}.json`,
      textInputPath = `text/inputs/${split}.json`,
      textTruthPath = `text/ground-truth/${split}.json`
    for (const path of [inputPath, truthPath, textInputPath, textTruthPath])
      manifests[path] = sha256(await readFile(local(root, path)))
    const input = z.array(photoSchema).parse(await readJson(local(root, inputPath)))
    const truth = z.array(photoTruthSchema).parse(await readJson(local(root, truthPath)))
    const expectedPhotos = split === 'dev' ? 20 : 40,
      expectedTexts = split === 'dev' ? 10 : 20
    if (
      input.length !== expectedPhotos ||
      truth.length !== input.length ||
      new Set(input.map((v) => v.caseId)).size !== input.length ||
      new Set(truth.map((v) => v.caseId)).size !== truth.length
    )
      throw new Error('Unexpected photo corpus cardinality')
    for (const item of input.slice(0, limit)) {
      const gt = truth.find((v) => v.caseId === item.caseId)
      if (
        !gt ||
        !item.caseId.startsWith(`photo-${split}-`) ||
        (gt.expectedPresence === 'present'
          ? !gt.targetBoxes.length
          : gt.targetBoxes.length !== 0 || gt.negativeEvidence === null)
      )
        throw new Error('Invalid photo truth join or negative evidence')
      photos.push({ ...item, split })
      photoTruth.set(item.caseId, gt)
    }
    const textInputs = z
      .array(z.object({ text: z.string() }).strict())
      .parse(await readJson(local(root, textInputPath)))
    const textLabels = textTruthSchema.parse(await readJson(local(root, textTruthPath)))
    if (
      textLabels.split !== split ||
      textInputs.length !== expectedTexts ||
      textLabels.examples.length !== textInputs.length ||
      new Set(textLabels.examples.map((v) => v.input_index)).size !== textInputs.length
    )
      throw new Error('Unexpected text corpus cardinality')
    for (const [index, item] of textInputs.slice(0, limit).entries()) {
      const gt = textLabels.examples.find((v) => v.input_index === index)
      if (
        !gt ||
        gt.text_sha256 !== sha256(item.text) ||
        !policy.classes.some((v) => v.id === gt.expected_label)
      )
        throw new Error('Invalid text truth join')
      texts.push({ caseId: gt.id, split, text: item.text })
      textTruth.set(gt.id, { caseId: gt.id, expected: gt.expected_label })
    }
  }
  return { photos, texts, photoTruth, textTruth, policy, manifests }
}
export async function photoBytes(root: string, input: PhotoCase): Promise<Buffer> {
  const bytes = await readFile(local(root, input.image.path))
  if (bytes.length > 16 * 1024 * 1024 || sha256(bytes) !== input.image.sha256)
    throw new Error('Photo content hash or size mismatch')
  return bytes
}
