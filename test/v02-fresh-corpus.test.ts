import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import {
  freshCaseSchema,
  freshProducerTask,
  loadFreshCorpus,
  loadFreshImage,
} from '../benchmarks/v02/fresh-corpus.js'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
const signal = new AbortController().signal

async function fixture(directory: string) {
  const bytes = await sharp({
    create: { width: 24, height: 16, channels: 3, background: '#567890' },
  })
    .png()
    .toBuffer()
  const input = {
    caseId: 'ui-private-controller-id',
    image: { path: 'source.png', sha256: digest(bytes), width: 24, height: 16 },
    locate: { target: 'the whole toolbar button', instruction: 'Find its visible bounds.' },
    classify: { options: ['present', 'absent'] as ['present', 'absent'] },
  }
  await writeFile(join(directory, 'source.png'), bytes, { flag: 'wx' })
  const manifestBytes = Buffer.from(JSON.stringify([input]))
  const path = join(directory, 'inputs.json')
  await writeFile(path, manifestBytes, { flag: 'wx' })
  return { bytes, input, manifest: { path, sha256: digest(manifestBytes) } }
}

await test('fresh corpus pins producer bytes and excludes controller identity from model-facing tasks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-fresh-producer-'))
  try {
    const source = await fixture(directory)
    const loaded = await loadFreshCorpus(
      { manifests: [source.manifest], imageRoot: directory },
      signal,
    )
    assert.equal(loaded.cases.length, 1)
    assert.deepEqual(await loadFreshImage(loaded.cases[0]!, loaded.imageRoot, signal), source.bytes)
    assert.deepEqual(freshProducerTask(loaded.cases[0]!), {
      target: 'the whole toolbar button',
      instruction: 'Find its visible bounds.',
      question: 'Does this image contain the whole toolbar button?',
      classes: ['present', 'absent'],
    })
    const task = JSON.stringify(freshProducerTask(loaded.cases[0]!))
    for (const forbidden of [
      directory,
      source.input.caseId,
      source.input.image.sha256,
      'source.png',
    ])
      assert.equal(task.includes(forbidden), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('fresh producer inputs reject truth fields, traversal and duplicate case IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-fresh-validation-'))
  try {
    const source = await fixture(directory)
    assert.throws(() => freshCaseSchema.parse({ ...source.input, expectedAnswer: 'present' }))
    for (const path of ['../private.png', '/absolute.png', 'a/../b.png', 'a\\b.png'])
      assert.throws(() =>
        freshCaseSchema.parse({ ...source.input, image: { ...source.input.image, path } }),
      )
    await assert.rejects(
      loadFreshCorpus(
        { manifests: [source.manifest, source.manifest], imageRoot: directory },
        signal,
      ),
      { code: 'INVALID_INPUT' },
    )
    await assert.rejects(
      loadFreshCorpus(
        { manifests: [{ ...source.manifest, sha256: '0'.repeat(64) }], imageRoot: directory },
        signal,
      ),
      { code: 'INVALID_INPUT' },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('fresh raster validation stops altered bytes, geometry and pre-cancellation before provider work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-fresh-raster-'))
  try {
    const { input } = await fixture(directory)
    await assert.rejects(
      loadFreshImage({ ...input, image: { ...input.image, width: 25 } }, directory, signal),
      { code: 'INVALID_INPUT' },
    )
    await assert.rejects(
      loadFreshImage(
        { ...input, image: { ...input.image, sha256: '0'.repeat(64) } },
        directory,
        signal,
      ),
      { code: 'INVALID_INPUT' },
    )
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(loadFreshImage(input, directory, controller.signal), { code: 'ABORTED' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test(
  'fresh image root rejects symlinks to external files',
  {
    skip:
      process.platform === 'win32' ? 'Unprivileged Windows symlink creation is not assumed' : false,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zorya-fresh-link-'))
    const external = await mkdtemp(join(tmpdir(), 'zorya-fresh-external-'))
    try {
      const { input } = await fixture(external)
      await symlink(join(external, 'source.png'), join(directory, 'linked.png'))
      await assert.rejects(
        loadFreshImage(
          { ...input, image: { ...input.image, path: 'linked.png' } },
          directory,
          signal,
        ),
        { code: 'INVALID_INPUT' },
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
      await rm(external, { recursive: true, force: true })
    }
  },
)
