import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const catalogPath = fileURLToPath(new URL('./test-catalog.json', import.meta.url))
const skipDirectories = new Set(['node_modules', 'dist', '.run', '.git'])

const knownTestGroups = ['portable', 'local-evidence', 'python-native'] as const
type KnownTestGroup = (typeof knownTestGroups)[number]

const prerequisitesSchema = z.record(
  z.enum(knownTestGroups),
  z.object({
    summary: z.string().min(1),
    knownFailures: z.string().min(1),
  }),
)

const catalogRelativeTestPathSchema = z.string().superRefine((value, ctx) => {
  if (value.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Catalog path must not be empty' })
    return
  }
  if (value.includes('\\')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Catalog path must use forward slashes',
    })
    return
  }
  if (isAbsolute(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Catalog path must be relative' })
    return
  }
  if (!value.endsWith('.test.ts')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Catalog path must end with .test.ts',
    })
    return
  }
  for (const segment of value.split('/')) {
    if (segment.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Catalog path must not contain empty segments',
      })
      return
    }
    if (segment === '.' || segment === '..') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Catalog path must not contain dot or parent segments',
      })
      return
    }
  }
})

const catalogSchema = z
  .object({
    version: z.literal(1),
    groups: z
      .object({
        portable: z.array(catalogRelativeTestPathSchema),
        'local-evidence': z.array(catalogRelativeTestPathSchema),
        'python-native': z.array(catalogRelativeTestPathSchema),
      })
      .strict(),
    prerequisites: prerequisitesSchema.optional(),
  })
  .strict()

export type TestCatalog = z.infer<typeof catalogSchema>

export async function discoverTestFiles(): Promise<string[]> {
  const discovered: string[] = []
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (skipDirectories.has(entry.name)) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (entry.name.endsWith('.test.ts')) {
        discovered.push(relative(repositoryRoot, absolute).split(sep).join('/'))
      }
    }
  }
  await walk(repositoryRoot)
  discovered.sort()
  return discovered
}

export async function loadCatalog(): Promise<TestCatalog> {
  const text = await readFile(catalogPath, 'utf8')
  const parsed: unknown = JSON.parse(text)
  return catalogSchema.parse(parsed)
}

function parseCatalogInput(input: unknown): TestCatalog {
  try {
    return catalogSchema.parse(input)
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(error.issues.map((issue) => issue.message).join('\n'))
    }
    throw error
  }
}

function catalogPathContainmentIssue(file: string): string | null {
  const absoluteTarget = resolve(repositoryRoot, file)
  const relativeToRoot = relative(repositoryRoot, absoluteTarget)
  if (
    relativeToRoot.startsWith(`..${sep}`) ||
    relativeToRoot === '..' ||
    isAbsolute(relativeToRoot)
  ) {
    return `Catalog path escapes repository root: ${file}`
  }
  return null
}

export async function validateCatalog(
  input: unknown | null = null,
  discovered: readonly string[] | null = null,
): Promise<TestCatalog> {
  const errors: string[] = []
  const resolvedCatalog = input === null ? await loadCatalog() : parseCatalogInput(input)

  const resolvedDiscovered = discovered ?? (await discoverTestFiles())
  const seen = new Map<string, KnownTestGroup>()

  for (const group of knownTestGroups) {
    const files = resolvedCatalog.groups[group]
    for (const file of files) {
      const containmentIssue = catalogPathContainmentIssue(file)
      if (containmentIssue) {
        errors.push(containmentIssue)
        continue
      }
      const prior = seen.get(file)
      if (prior) errors.push(`${file} classified in both ${prior} and ${group}`)
      else seen.set(file, group)
      try {
        await stat(join(repositoryRoot, file))
      } catch {
        errors.push(`Catalog entry missing on disk: ${file}`)
      }
    }
  }

  for (const file of resolvedDiscovered) {
    if (!seen.has(file)) errors.push(`Discovered test lacks classification: ${file}`)
  }

  for (const file of seen.keys()) {
    if (!resolvedDiscovered.includes(file)) {
      errors.push(`Catalog entry not discovered by repository scan: ${file}`)
    }
  }

  if (errors.length) throw new Error(errors.join('\n'))
  return resolvedCatalog
}

export async function listGroup(
  groupName: KnownTestGroup,
  catalog: TestCatalog | null = null,
): Promise<string[]> {
  const resolved = catalog ?? (await validateCatalog())
  const files = resolved.groups[groupName]
  if (!files) throw new Error(`Unknown test group: ${groupName}`)
  return files
}
