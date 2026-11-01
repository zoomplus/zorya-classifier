import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import test from 'node:test'
import type { PackedBinaryMask } from '../../../src/entities/object-proposals.js'
import type { H6Family, H6ProposalCandidate } from '../h6-context-composer.js'
import { zoomTileRegions } from '../zoom-locator.js'
import { H8A_FULL_CASE_DEADLINE_MS } from '../h8a-full/constants.js'
import { ClassifierError } from '../../../src/entities/errors.js'
import {
  H8A_TILE_PROBE_RECIPE_ID,
  maskTouchesInternalTileEdge,
  projectTileMaskToSource,
  runTiledProposalAvailabilityProbe,
  tiledProposalProbeEvidenceSchema,
} from './tiled-proposal-probe.js'
import type {
  TiledProposalProbeEvidence,
  TiledProposalProbeInput,
  TiledProposalProbeDependencies,
} from './tiled-proposal-probe.js'
import type {
  H8aNativeGenerationInput,
  H8aNativeGenerationOutput,
} from '../h8a-full/native-port.js'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function pack(
  width: number,
  height: number,
  coordinates: readonly (readonly [number, number])[],
): PackedBinaryMask {
  const data = new Uint8Array(Math.ceil((width * height) / 8))
  for (const [x, y] of coordinates) {
    const index = y * width + x
    data[index >> 3] = (data[index >> 3] ?? 0) | (1 << (index & 7))
  }
  return { format: 'binary-lsb0', width, height, data }
}

function candidate(family: H6Family, ordinal: number, mask: PackedBinaryMask): H6ProposalCandidate {
  return { id: `${family}${String(ordinal).padStart(2, '0')}`, mask }
}

async function sourcePng(width = 7, height = 5): Promise<Uint8Array> {
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      pixels[offset] = x + 1
      pixels[offset + 1] = y + 1
      pixels[offset + 2] = (x * 13 + y * 7) & 0xff
      pixels[offset + 3] = 255
    }
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
  return Uint8Array.from(png)
}

function probeInput(
  root: string,
  bytes: Uint8Array,
  outputName = 'probe-output',
): TiledProposalProbeInput {
  return {
    opaqueCaseId: 'opaque-case-7',
    sourceBytes: bytes,
    sourceBytesSha256: digest(bytes),
    targetTaskText: 'small target on screen',
    outputDir: join(root, 'artifacts', outputName),
    artifactRoot: join(root, 'artifacts'),
    pythonExecutable: process.execPath,
    assetRoot: join(root, 'assets'),
    signal: new AbortController().signal,
  }
}

function maskFromLocalIndex(
  width: number,
  height: number,
  coords: readonly (readonly [number, number])[],
): H6ProposalCandidate[] {
  return coords.map(([x, y], ordinal) => candidate('D', ordinal, pack(width, height, [[x, y]])))
}

function returnedView(callIndex: number): H8aNativeGenerationOutput {
  if (callIndex === 0) {
    const full = pack(7, 5, [[3, 1]])
    return {
      recipeId: H8A_TILE_PROBE_RECIPE_ID,
      detectorPrompt: 'a small target on screen',
      families: {
        D: [
          candidate('D', 0, full),
          candidate('D', 1, pack(7, 5, [[3, 1]])),
          candidate('D', 2, pack(7, 5, [])),
        ],
        U: [candidate('U', 0, pack(7, 5, [[5, 1]]))],
      },
    }
  }
  const dims = { width: 5, height: 3 }
  if (callIndex === 1) {
    const d = [
      [4, 1], // right seam is internal in NW and must reject the proposal.
      [3, 1], // duplicate of the full D mask after projection.
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1], // sixth eligible unique mask must not backfill the NW quota.
    ] as const
    return {
      recipeId: H8A_TILE_PROBE_RECIPE_ID,
      detectorPrompt: 'a small target on screen',
      families: { D: maskFromLocalIndex(dims.width, dims.height, d), U: [] },
    }
  }
  if (callIndex === 2) {
    return {
      recipeId: H8A_TILE_PROBE_RECIPE_ID,
      detectorPrompt: 'a small target on screen',
      families: {
        D: maskFromLocalIndex(5, 3, [
          [1, 1],
          [2, 0],
          [3, 0],
          [4, 0],
          [2, 1],
        ]),
        U: [candidate('U', 0, pack(5, 3, [[3, 1]]))],
      },
    }
  }
  if (callIndex === 3) {
    return {
      recipeId: H8A_TILE_PROBE_RECIPE_ID,
      detectorPrompt: 'a small target on screen',
      families: {
        D: maskFromLocalIndex(5, 3, [
          [0, 1],
          [1, 1],
          [2, 1],
          [3, 1],
          [0, 2],
        ]),
        U: [candidate('U', 0, pack(5, 3, [[2, 1]]))],
      },
    }
  }
  return {
    recipeId: H8A_TILE_PROBE_RECIPE_ID,
    detectorPrompt: 'a small target on screen',
    families: {
      D: maskFromLocalIndex(5, 3, [
        [1, 1],
        [2, 1],
        [3, 1],
        [4, 1],
        [1, 2],
      ]),
      U: [candidate('U', 0, pack(5, 3, [[2, 1]]))],
    },
  }
}

function bit(mask: Uint8Array, index: number): boolean {
  return ((mask[index >> 3] ?? 0) & (1 << (index & 7))) !== 0
}

function repackCrop(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  region: { left: number; top: number; width: number; height: number },
): Uint8Array {
  const result = new Uint8Array(Math.ceil((region.width * region.height) / 8))
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const sourceIndex = (region.top + y) * sourceWidth + region.left + x
      if (!bit(source, sourceIndex)) continue
      const localIndex = y * region.width + x
      result[localIndex >> 3] = (result[localIndex >> 3] ?? 0) | (1 << (localIndex & 7))
    }
  }
  return result
}

await test('odd-frame tile projection preserves LSB0 pixels and permits only true outer edges', () => {
  const [northWest, northEast, southWest, southEast] = zoomTileRegions({
    left: 0,
    top: 0,
    width: 7,
    height: 5,
  })
  assert.deepEqual(
    [northWest, northEast, southWest, southEast],
    [
      { left: 0, top: 0, width: 5, height: 3 },
      { left: 2, top: 0, width: 5, height: 3 },
      { left: 0, top: 2, width: 5, height: 3 },
      { left: 2, top: 2, width: 5, height: 3 },
    ],
  )
  assert.ok(northWest && northEast && southEast)
  const local = pack(5, 3, [
    [1, 1],
    [3, 1],
  ])
  const projected = projectTileMaskToSource(local, northEast, 7, 5)
  assert.equal(projected.data.byteLength, 5)
  assert.equal(bit(projected.data, 1 * 7 + 3), true)
  assert.equal(bit(projected.data, 1 * 7 + 5), true)
  assert.equal(bit(projected.data, 0), false)
  assert.equal(bit(projected.data, 4 * 7 + 6), false)
  assert.equal(maskTouchesInternalTileEdge(pack(5, 3, [[0, 0]]), northWest, 7, 5), false)
  assert.equal(maskTouchesInternalTileEdge(pack(5, 3, [[4, 1]]), northWest, 7, 5), true)
  assert.equal(maskTouchesInternalTileEdge(pack(5, 3, [[1, 2]]), northWest, 7, 5), true)
  assert.equal(maskTouchesInternalTileEdge(pack(5, 3, [[4, 2]]), southEast, 7, 5), false)
  projected.data.fill(0)
})

await test('probe retains native-order full baseline and deterministic deduplicated source-frame candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-tiled-probe-'))
  try {
    const bytes = await sourcePng()
    const input = probeInput(root, bytes)
    await mkdir(input.artifactRoot, { recursive: false })
    await mkdir(input.assetRoot, { recursive: false })
    let callIndex = 0
    let disposed = false
    let sharedDeadline: number | undefined
    const nativeCalls: H8aNativeGenerationInput[] = []
    const dependencies: TiledProposalProbeDependencies = {
      createNative(options) {
        assert.equal(options.recipeId, H8A_TILE_PROBE_RECIPE_ID)
        assert.equal(options.artifactRoot, input.artifactRoot)
        assert.equal(options.assetRoot, input.assetRoot)
        return {
          async generate(nativeInput) {
            assert.equal(nativeInput.authoredTarget, input.targetTaskText)
            if (sharedDeadline === undefined) sharedDeadline = nativeInput.deadlineAt
            assert.equal(nativeInput.deadlineAt, sharedDeadline)
            assert.ok(nativeInput.deadlineAt - performance.now() <= H8A_FULL_CASE_DEADLINE_MS)
            assert.ok(
              nativeInput.sourcePath.startsWith(join(input.outputDir, 'h8a-full-runs') + sep),
            )
            assert.equal(basename(nativeInput.sourcePath), 'oriented-source.png')
            const encoded = await readFile(nativeInput.sourcePath)
            assert.equal(digest(encoded), nativeInput.sourceSha256)
            const info = await sharp(encoded).metadata()
            assert.equal(info.width, nativeInput.width)
            assert.equal(info.height, nativeInput.height)
            nativeCalls.push(nativeInput)
            return returnedView(callIndex++)
          },
          async dispose() {
            disposed = true
          },
        }
      },
    }
    const evidence: TiledProposalProbeEvidence = await runTiledProposalAvailabilityProbe(
      input,
      dependencies,
    )
    assert.equal(disposed, true)
    assert.equal(callIndex, 5)
    assert.deepEqual(
      nativeCalls.map((call) => [call.width, call.height]),
      [
        [7, 5],
        [5, 3],
        [5, 3],
        [5, 3],
        [5, 3],
      ],
    )
    assert.deepEqual(evidence.viewOrder, ['full', 'NW', 'NE', 'SW', 'SE'])
    assert.deepEqual(
      evidence.views.map((view) => view.view),
      ['full', 'NW', 'NE', 'SW', 'SE'],
    )
    assert.equal(evidence.baseline.entries.length, 4)
    assert.equal(evidence.baseline.entries.filter((entry) => entry.sourceBounds === null).length, 1)
    assert.equal(evidence.baseline.entries[0]?.origin.nativeCandidateId, 'D00')
    assert.equal(evidence.baseline.entries[1]?.origin.nativeCandidateId, 'D01')
    assert.equal(
      evidence.candidate.entries.filter(
        (entry) => entry.family === 'D' && entry.origin.view === 'full',
      ).length,
      1,
    )
    assert.equal(
      evidence.candidate.entries.filter(
        (entry) => entry.family === 'D' && entry.origin.view === 'NW',
      ).length,
      5,
    )
    assert.equal(
      evidence.candidate.entries.some(
        (entry) => entry.origin.nativeCandidateId === 'D00' && entry.origin.view === 'NW',
      ),
      false,
    )
    assert.equal(
      evidence.candidate.entries.filter(
        (entry) => entry.family === 'D' && entry.origin.view === 'NE',
      ).length,
      4,
    )
    assert.equal(
      evidence.candidate.packedBytesTotal,
      evidence.candidate.entries.reduce((sum, row) => sum + row.packedMask.packedBytes, 0),
    )
    assert.equal(
      evidence.baseline.packedBytesTotal,
      evidence.baseline.entries.reduce((sum, row) => sum + row.packedMask.packedBytes, 0),
    )
    const { evidenceSha256, ...body } = evidence
    assert.equal(evidenceSha256, digestText(JSON.stringify(body)))
    assert.deepEqual(tiledProposalProbeEvidenceSchema.parse(evidence), evidence)

    const manifestPath = join(input.outputDir, 'manifest.json')
    const persisted = tiledProposalProbeEvidenceSchema.parse(
      JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
    )
    assert.deepEqual(persisted, evidence)
    await assert.rejects(access(join(input.outputDir, 'h8a-full-runs')))
    for (const entry of evidence.candidate.entries) {
      const maskPath = join(input.outputDir, ...entry.packedMask.relativePath.split('/'))
      const projected = new Uint8Array(await readFile(maskPath))
      assert.equal(digest(projected), entry.packedMask.sha256)
      if (entry.origin.view !== 'full') {
        const { tileRegion } = entry.origin
        for (let y = 0; y < 5; y++) {
          for (let x = 0; x < 7; x++) {
            if (
              x >= tileRegion.left &&
              x < tileRegion.left + tileRegion.width &&
              y >= tileRegion.top &&
              y < tileRegion.top + tileRegion.height
            )
              continue
            assert.equal(bit(projected, y * 7 + x), false)
          }
        }
        const local = repackCrop(projected, 7, 5, tileRegion)
        assert.equal(digest(local), entry.origin.localPackedMaskSha256)
      } else {
        assert.equal(entry.origin.localPackedMaskSha256, entry.packedMask.sha256)
      }
      projected.fill(0)
    }
    for (const entry of evidence.baseline.entries) {
      const maskPath = join(input.outputDir, ...entry.packedMask.relativePath.split('/'))
      const packed = new Uint8Array(await readFile(maskPath))
      assert.equal(digest(packed), entry.packedMask.sha256)
      assert.equal(entry.origin.localPackedMaskSha256, entry.packedMask.sha256)
    }
    const outputFiles = await readdir(input.outputDir)
    assert.deepEqual(outputFiles.sort(), ['manifest.json', 'masks'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('probe rejects output reuse and over-cap native view without leaving owned files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-tiled-probe-limits-'))
  try {
    const bytes = await sourcePng(3, 3)
    const input = probeInput(root, bytes, 'existing-output')
    await mkdir(input.artifactRoot)
    await mkdir(input.outputDir)
    const sentinel = join(input.outputDir, 'owned-by-caller.txt')
    await writeFile(sentinel, 'retain')
    let factoryCalls = 0
    await assert.rejects(
      runTiledProposalAvailabilityProbe(input, {
        createNative() {
          factoryCalls++
          throw new Error('must not construct')
        },
      }),
      (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
    )
    assert.equal(factoryCalls, 0)
    assert.equal(await readFile(sentinel, 'utf8'), 'retain')
    await rm(input.outputDir, { recursive: true, force: false })

    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const projectOutput = join(projectRoot, 'benchmarks', 'v03', 'h8a-cpu', 'test-artifacts')
    let projectFactoryCalls = 0
    await assert.rejects(
      runTiledProposalAvailabilityProbe(
        {
          ...input,
          outputDir: join(projectOutput, 'must-not-be-created'),
          artifactRoot: projectOutput,
        },
        {
          createNative() {
            projectFactoryCalls++
            throw new Error('must not construct')
          },
        },
      ),
      (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
    )
    assert.equal(projectFactoryCalls, 0)
    await assert.rejects(access(join(projectOutput, 'must-not-be-created')))

    const escapedOutput = join(input.artifactRoot, '..', 'escaped-output')
    await assert.rejects(
      runTiledProposalAvailabilityProbe(
        { ...input, outputDir: escapedOutput },
        {
          createNative: () => {
            throw new Error('must not construct')
          },
        },
      ),
      (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
    )
    await assert.rejects(access(escapedOutput))

    const symlinkTarget = join(root, 'symlink-target')
    const symlinkParent = join(input.artifactRoot, 'linked-parent')
    await mkdir(symlinkTarget)
    await symlink(symlinkTarget, symlinkParent, 'dir')
    const symlinkOutput = join(symlinkParent, 'must-not-be-created')
    await assert.rejects(
      runTiledProposalAvailabilityProbe(
        { ...input, outputDir: symlinkOutput },
        {
          createNative: () => {
            throw new Error('must not construct')
          },
        },
      ),
      (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
    )
    await assert.rejects(access(join(symlinkTarget, 'must-not-be-created')))

    const tooManyInput = probeInput(root, bytes, 'over-cap-output')
    await mkdir(tooManyInput.assetRoot)
    let disposed = false
    const tooMany: H6ProposalCandidate[] = Array.from({ length: 37 }, (_, ordinal) =>
      candidate('D', ordinal, pack(3, 3, [[ordinal % 3, Math.floor(ordinal / 3) % 3]])),
    )
    await assert.rejects(
      runTiledProposalAvailabilityProbe(tooManyInput, {
        createNative() {
          return {
            async generate() {
              return {
                recipeId: H8A_TILE_PROBE_RECIPE_ID,
                detectorPrompt: 'a small target on screen',
                families: { D: tooMany, U: [] },
              }
            },
            async dispose() {
              disposed = true
            },
          }
        },
      }),
      (error: unknown) => error instanceof ClassifierError && error.code === 'RESOURCE_LIMIT',
    )
    assert.equal(disposed, true)
    await assert.rejects(access(tooManyInput.outputDir))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('caller cancellation waits for native physical settlement before cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-tiled-probe-cancel-'))
  try {
    const bytes = await sourcePng()
    const controller = new AbortController()
    const input = { ...probeInput(root, bytes), signal: controller.signal }
    await mkdir(input.artifactRoot)
    await mkdir(input.assetRoot)
    let calls = 0
    let settled = false
    let disposedAfterSettlement = false
    await assert.rejects(
      runTiledProposalAvailabilityProbe(input, {
        createNative() {
          return {
            async generate(nativeInput) {
              calls++
              if (calls === 1) return returnedView(0)
              return await new Promise<H8aNativeGenerationOutput>((_resolve, reject) => {
                nativeInput.signal.addEventListener(
                  'abort',
                  () => {
                    setTimeout(() => {
                      settled = true
                      reject(new ClassifierError('ABORTED', 'synthetic physical work closed'))
                    }, 5)
                  },
                  { once: true },
                )
                controller.abort(new Error('caller cancellation'))
              })
            },
            async dispose() {
              disposedAfterSettlement = settled
            },
          }
        },
      }),
      (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
    )
    assert.equal(calls, 2)
    assert.equal(settled, true)
    assert.equal(disposedAfterSettlement, true)
    await assert.rejects(access(input.outputDir))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
