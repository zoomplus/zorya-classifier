import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { wholeObjectMatch } from '../v02/metrics.js'
import type { Box } from '../v02/metrics.js'
import { loadFreshCorpus } from '../v02/fresh-corpus.js'
import { loadV03PilotTruth } from './evaluate-pilot.js'
import { v03PilotManifests } from './pilot-manifest.js'

const H5A_RUN_ROOT =
  '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h5a-native-proposals-v2'
const H5A_RUN_SHA256 = '86d0aab4f7fad3ce0fae182b840ddd540275309471b27cb091dc4e85866d56f0'
const H5A_FREEZE_SHA256 = 'b808985a17b150c1adbc2467bd0df4797a3a6b242db2ba99b174c2fb0f9e6566'
const H3_NATIVE_RUN_ROOT = '/root/work/zorya-classifier/.run/v03/grounded-proposals-h3-run-02'
const H3_NATIVE_RUN_SHA256 = 'df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401'
const H3_SEALED_RUN_SHA256 = '1dd6408dc1b584ddd884c79ee5c0afea17f85ca3c607e4d3fc2fc6fa602e89d5'
const H4E_RUN_ROOT =
  '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h4e-sam2-context-prompt-v1'
const H4E_RUN_SHA256 = 'dab327f4ee13af4b5b742e681fd180bbc96372a4669833754f77a3c5f9ea55d4'
const H4E_FREEZE_SHA256 = 'ea905f6e2468b0776207056d51b6c96d0eed9e6c8a6b2626b388fb14974032a2'
const IMAGE_ROOT = '/root/work/zorya-classifier-worktrees/v02/corpus'
const GATE_IOU = 0.5
const GATE_COVERAGE = 0.9

type Receipt = { path: string; sha256: string; bytes?: number }
type NativeCandidate = {
  id: string
  mask_path: string
  mask_sha256: string
  mask_box_xyxy: number[] | null
}
type NativeCase = {
  case_id: string
  source_sha256: string
  status: string
  mask_candidates: NativeCandidate[]
}
type H3FreezeCase = {
  case_id: string
  candidate_count: number
  mask_hashes: string[]
  row: Receipt
}
type H4eCandidate = {
  proposal_ordinal: number
  mask_path: string
  mask_sha256: string
  mask_box_xyxy: number[] | null
  mask_pixel_area: number
  empty: boolean
}
type H4eRun = {
  source: Receipt
  h4a_output: Receipt
  h4a_freeze: Receipt
  results: H4eCandidate[]
}
type SourceIntegrity = {
  source_sha256: string
  omni_masks?: Receipt[]
  h4e_masks?: Receipt[]
}
type H5aCase = {
  case_id: string
  status: string
  target: string
  source_sha256: string
  omni_source_result?: string | null
  dino_candidates: NativeCandidate[]
}
type H5aFreezeCase = { case_id: string; target: string; source: Receipt & { bytes: number } }
type H5aRun = {
  state: string
  hypothesis: string
  freeze: Receipt
  paid_calls: number
  candidate_semantics: string
  cases: H5aCase[]
  source_integrity_after: SourceIntegrity[]
}
type H5aFreeze = {
  state: string
  hypothesis: string
  producer: Receipt
  cases: H5aFreezeCase[]
  h3b: { cases: H3FreezeCase[]; run: Receipt; sealed_h3_run_sha256: string }
  h4e_ui_cache: {
    run: Receipt
    h4a_output: Receipt
    h4a_freeze: Receipt
  }
  source_freeze: Record<string, unknown>
}
type MaskGeometry = {
  bits: Uint8Array
  box: Box
  area: number
  width: number
  height: number
  sha256: string
  bytes: number
}
type Candidate = {
  family: 'h3-dino-sam2' | 'omni-sam2' | 'h4e-sam2' | 'union'
  id: string
  receipt: Receipt
  root: string
  dimensions: { width: number; height: number }
  descriptor?: { box?: number[] | null; area?: number; empty?: boolean }
}
type GateScore = { iou: number; coverage: number; pass: boolean }
type FamilyCandidate = {
  family: string
  id: string
  score: GateScore | null
  geometry: MaskGeometry
}
type FamilySummary = {
  candidateCount: number
  sameCandidateGatePasses: number
  available: boolean
  bestCandidate: { family: string | null; id: string | null; iou: number; coverage: number }
  passingCandidateShortlist: Array<{
    family: string
    id: string
    maskSha256: string
    box: Box
    iou: number
    coverage: number
  }>
  candidateReceipts: Array<{
    family: string
    id: string
    maskSha256: string
    bytes: number
    box: Box
    area: number
    score: GateScore | null
  }>
}
type CaseSummary = {
  caseId: string
  stratum: 'photo' | 'ui' | 'map'
  presence: 'present' | 'absent'
  sourceSha256: string
  sourceDimensions: { width: number; height: number }
  families: Record<string, FamilySummary>
  negativeInterpretation?: string
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fileSha256(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { sha256: hash.digest('hex'), bytes }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function verifyReceipt(receipt: Receipt, name: string) {
  const actual = await fileSha256(receipt.path)
  assert(actual.sha256 === receipt.sha256, `${name}-hash-mismatch`)
  if (receipt.bytes !== undefined)
    assert(actual.bytes === receipt.bytes, `${name}-byte-size-mismatch`)
  return actual
}

function boxFromXyxy(value: number[] | null | undefined): Box | null {
  if (!value) return null
  const [left, top, right, bottom] = value
  if (
    left === undefined ||
    top === undefined ||
    right === undefined ||
    bottom === undefined ||
    ![left, top, right, bottom].every(Number.isFinite) ||
    right <= left ||
    bottom <= top
  )
    throw new Error('invalid-box-descriptor')
  return { left, top, width: right - left, height: bottom - top }
}

function sameBox(left: Box, right: Box): boolean {
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  )
}

async function decodeCandidate(candidate: Candidate): Promise<MaskGeometry> {
  const root = await realpath(candidate.root)
  const path = isAbsolute(candidate.receipt.path)
    ? resolve(candidate.receipt.path)
    : resolve(root, candidate.receipt.path)
  const lexicalRelative = relative(root, path)
  if (!lexicalRelative || lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`))
    throw new Error('mask-path-outside-frozen-root')
  const actualPath = await realpath(path)
  const actualRelative = relative(root, actualPath)
  if (!actualRelative || actualRelative === '..' || actualRelative.startsWith(`..${sep}`))
    throw new Error('mask-symlink-escape')
  const encoded = await readFile(actualPath)
  const digest = sha256(encoded)
  if (digest !== candidate.receipt.sha256) throw new Error('mask-hash-mismatch')
  if (candidate.receipt.bytes !== undefined && encoded.byteLength !== candidate.receipt.bytes)
    throw new Error('mask-byte-size-mismatch')
  const metadata = await sharp(encoded, { failOn: 'error' }).metadata()
  const { width, height } = candidate.dimensions
  if (
    metadata.format !== 'png' ||
    metadata.width !== width ||
    metadata.height !== height ||
    (metadata.channels !== 1 && metadata.channels !== 3) ||
    (metadata.pages ?? 1) !== 1
  )
    throw new Error('mask-source-canvas-mismatch')
  const raw = await sharp(encoded, { failOn: 'error' }).raw().toBuffer({ resolveWithObject: true })
  if (
    raw.info.width !== width ||
    raw.info.height !== height ||
    raw.info.channels !== 3 ||
    raw.data.byteLength !== width * height * 3
  )
    throw new Error('mask-pixel-buffer-geometry-mismatch')
  const bits = new Uint8Array(width * height)
  let area = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let index = 0; index < bits.length; index++) {
    const offset = index * 3
    const value = raw.data[offset]
    if (value !== 0 && value !== 255) throw new Error('mask-not-binary')
    for (let channel = 1; channel < 3; channel++)
      if (raw.data[offset + channel] !== value) throw new Error('mask-not-grayscale')
    if (value === 0) continue
    bits[index] = 1
    area++
    const x = index % width
    const y = Math.floor(index / width)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  if (area === 0) throw new Error('mask-empty')
  const box = { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
  if (candidate.descriptor?.box) {
    const descriptorBox = boxFromXyxy(candidate.descriptor.box)
    if (!descriptorBox || !sameBox(descriptorBox, box))
      throw new Error('mask-box-descriptor-mismatch')
  }
  if (candidate.descriptor?.area !== undefined && candidate.descriptor.area !== area)
    throw new Error('mask-area-descriptor-mismatch')
  if (candidate.descriptor?.empty === true) throw new Error('mask-empty-descriptor-mismatch')
  return { bits, box, area, width, height, sha256: digest, bytes: encoded.byteLength }
}

export function scoreCandidate(box: Box, references: Box[]): GateScore {
  const instances = wholeObjectMatch(box, references).instances
  const best =
    instances.find((item) => item.matched) ??
    instances.reduce(
      (acc, item) =>
        item.iou > acc.iou || (item.iou === acc.iou && item.coverage > acc.coverage) ? item : acc,
      { iou: 0, coverage: 0, matched: false, index: -1 },
    )
  return {
    iou: best.iou,
    coverage: Math.min(1, best.coverage),
    pass: best.matched,
  }
}

async function evaluate() {
  const h5aRoot = await realpath(H5A_RUN_ROOT)
  const runBytes = await readFile(resolve(h5aRoot, 'run.json'))
  const freezeBytes = await readFile(resolve(h5aRoot, 'freeze.json'))
  assert(sha256(runBytes) === H5A_RUN_SHA256, 'H5a-run-lock-mismatch')
  assert(sha256(freezeBytes) === H5A_FREEZE_SHA256, 'H5a-freeze-lock-mismatch')
  const run = JSON.parse(runBytes.toString('utf8')) as H5aRun
  const freeze = JSON.parse(freezeBytes.toString('utf8')) as H5aFreeze
  assert(
    run.state === 'complete' && freeze.state === 'frozen-before-generation',
    'H5a-run-not-closed',
  )
  assert(
    run.hypothesis === 'H5a-native-proposals-v1' && freeze.hypothesis === run.hypothesis,
    'H5a-profile-mismatch',
  )
  assert(run.freeze?.sha256 === H5A_FREEZE_SHA256, 'H5a-run-freeze-reference-mismatch')
  assert(run.paid_calls === 0, 'H5a-unexpected-paid-calls')
  assert(run.cases.length === 12 && freeze.cases.length === 12, 'H5a-cohort-size-mismatch')
  assert(
    run.candidate_semantics ===
      'availability evidence only; no candidate is selected and no truth/evaluator artifacts were read',
    'H5a-producer-scope-mismatch',
  )

  const corpus = await loadFreshCorpus(
    { manifests: [...v03PilotManifests], imageRoot: IMAGE_ROOT },
    new AbortController().signal,
  )
  const truth = await loadV03PilotTruth()
  const truthById = new Map(truth.map((item) => [item.caseId, item]))
  assert(corpus.cases.length === 12 && truth.length === 12, 'unexpected-evaluator-cohort')

  const freezeProducer = freeze.producer as Receipt
  const sourceClosureRecords: Receipt[] = [freezeProducer]
  for (const value of Object.values(freeze.source_freeze as Record<string, unknown>)) {
    if (Array.isArray(value)) sourceClosureRecords.push(...(value as Receipt[]))
    else if (value && typeof value === 'object' && 'path' in value && 'sha256' in value)
      sourceClosureRecords.push(value as Receipt)
  }
  const producerClosure = []
  for (const record of sourceClosureRecords) {
    const actual = await verifyReceipt(record, 'producer-closure')
    producerClosure.push({ bytes: actual.bytes, sha256: actual.sha256 })
  }
  const h3RunBytes = await readFile(resolve(H3_NATIVE_RUN_ROOT, 'run.json'))
  assert(sha256(h3RunBytes) === H3_NATIVE_RUN_SHA256, 'H3-native-run-lock-mismatch')
  assert(freeze.h3b.run.sha256 === H3_NATIVE_RUN_SHA256, 'H5a-H3-native-lock-mismatch')
  assert(freeze.h3b.sealed_h3_run_sha256 === H3_SEALED_RUN_SHA256, 'H3b-sealed-run-lock-mismatch')
  const h4eRunBytes = await readFile(resolve(H4E_RUN_ROOT, 'run.json'))
  const h4eFreezeBytes = await readFile(resolve(H4E_RUN_ROOT, 'freeze.json'))
  assert(sha256(h4eRunBytes) === H4E_RUN_SHA256, 'H4e-run-lock-mismatch')
  assert(sha256(h4eFreezeBytes) === H4E_FREEZE_SHA256, 'H4e-freeze-lock-mismatch')
  assert(freeze.h4e_ui_cache.run.sha256 === H4E_RUN_SHA256, 'H5a-H4e-cache-lock-mismatch')
  const h3Run = JSON.parse(h3RunBytes.toString('utf8')) as { status: string }
  const h4eRun = JSON.parse(h4eRunBytes.toString('utf8')) as H4eRun
  const h4eFreeze = JSON.parse(h4eFreezeBytes.toString('utf8')) as {
    h4a_output: Receipt
    h4a_freeze: Receipt
  }
  assert(
    h4eRun.source.sha256 === '0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09',
    'H4e-source-lock-mismatch',
  )
  assert(
    h4eRun.h4a_output.sha256 === freeze.h4e_ui_cache.h4a_output.sha256 &&
      h4eRun.h4a_freeze.sha256 === freeze.h4e_ui_cache.h4a_freeze.sha256 &&
      h4eFreeze.h4a_output.sha256 === freeze.h4e_ui_cache.h4a_output.sha256 &&
      h4eFreeze.h4a_freeze.sha256 === freeze.h4e_ui_cache.h4a_freeze.sha256,
    'H4e-H4a-cache-identity-mismatch',
  )
  await verifyReceipt(h4eRun.h4a_output, 'H4a-output')
  await verifyReceipt(h4eRun.h4a_freeze, 'H4a-freeze')
  const h3FreezeRows = new Map(freeze.h3b.cases.map((row) => [row.case_id, row]))
  const h3Rows = new Map<string, NativeCase>()
  for (const caseId of corpus.cases.map((item) => item.caseId)) {
    const row = JSON.parse(
      await readFile(resolve(H3_NATIVE_RUN_ROOT, 'cases', `${caseId}.json`), 'utf8'),
    ) as NativeCase
    const frozen = h3FreezeRows.get(caseId)
    const actual = await fileSha256(resolve(H3_NATIVE_RUN_ROOT, 'cases', `${caseId}.json`))
    assert(
      frozen?.row?.sha256 === actual.sha256 && frozen?.row?.bytes === actual.bytes,
      `H3-row-freeze-mismatch-${caseId}`,
    )
    assert(row.case_id === caseId && row.status === 'complete', `H3-row-incomplete-${caseId}`)
    assert(
      row.mask_candidates.length === frozen.candidate_count,
      `H3-candidate-count-mismatch-${caseId}`,
    )
    assert(
      JSON.stringify(row.mask_candidates.map((item) => item.mask_sha256)) ===
        JSON.stringify(frozen.mask_hashes),
      `H3-candidate-hash-list-mismatch-${caseId}`,
    )
    h3Rows.set(caseId, row)
  }
  assert(h3Run.status === 'complete', 'H3-native-run-incomplete')

  const integrityBySource = new Map<string, SourceIntegrity>(
    run.source_integrity_after.map((item) => [item.source_sha256, item]),
  )
  assert(integrityBySource.size === 9, 'H5a-source-cache-cardinality-mismatch')
  const h4eByOrdinal = new Map(h4eRun.results.map((row) => [row.proposal_ordinal, row]))
  const decodedCache = new Map<string, Promise<MaskGeometry>>()
  const decodedMasks: Array<{
    family: string
    sha256: string
    bytes: number
    area: number
    box: Box
  }> = []
  const unpinnedMetadata: Array<{
    caseId: string
    bytes: number
    observedSha256: string
    frozenReceipt: false
  }> = []
  async function candidateGeometry(candidate: Candidate) {
    const cacheKey = `${candidate.root}\u0000${candidate.receipt.path}\u0000${candidate.receipt.sha256}`
    let decoded = decodedCache.get(cacheKey)
    if (!decoded) {
      decoded = decodeCandidate(candidate)
      decodedCache.set(cacheKey, decoded)
    }
    const geometry = await decoded
    decodedMasks.push({
      family: candidate.family,
      sha256: geometry.sha256,
      bytes: geometry.bytes,
      area: geometry.area,
      box: geometry.box,
    })
    return geometry
  }

  const perCase: CaseSummary[] = []
  for (const manifestCase of corpus.cases) {
    const caseId = manifestCase.caseId
    const source = manifestCase.image
    const truthRow = truthById.get(caseId)
    const runCase = run.cases.find((item) => item.case_id === caseId)
    const freezeCase = freeze.cases.find((item) => item.case_id === caseId)
    assert(truthRow && runCase && freezeCase, `case-join-missing-${caseId}`)
    assert(
      runCase.status === 'complete' && runCase.source_sha256 === source.sha256,
      `H5a-case-source-mismatch-${caseId}`,
    )
    assert(freezeCase.source.sha256 === source.sha256, `H5a-freeze-source-mismatch-${caseId}`)
    assert(truthRow.imageSha256 === source.sha256, `truth-source-mismatch-${caseId}`)
    const sourceReceipt = {
      path: freezeCase.source.path,
      sha256: freezeCase.source.sha256,
      bytes: freezeCase.source.bytes,
    }
    const sourceActual = await verifyReceipt(sourceReceipt, `source-${caseId}`)
    assert(
      sourceActual.sha256 === source.sha256 && sourceActual.bytes === freezeCase.source.bytes,
      `source-corpus-mismatch-${caseId}`,
    )
    assert(freezeCase.target === runCase.target, `target-mismatch-${caseId}`)
    const integrity = integrityBySource.get(source.sha256)
    assert(integrity, `source-integrity-row-missing-${caseId}`)
    const dimensions = { width: source.width, height: source.height }
    const refs: Box[] = truthRow.presence === 'present' ? truthRow.boxes : []
    const families: Record<string, FamilyCandidate[]> = {
      'h3-dino-sam2': [],
      'omni-sam2': [],
      'h4e-sam2': [],
    }

    const h3Row = h3Rows.get(caseId)
    assert(h3Row, `H3-row-missing-${caseId}`)
    assert(h3Row.source_sha256 === source.sha256, `H3-source-mismatch-${caseId}`)
    assert(
      runCase.dino_candidates.length === h3Row.mask_candidates.length,
      `H5a-H3-count-mismatch-${caseId}`,
    )
    for (let index = 0; index < h3Row.mask_candidates.length; index++) {
      const original = h3Row.mask_candidates[index]!
      const reused = runCase.dino_candidates[index]!
      assert(
        original.id === reused.id && original.mask_sha256 === reused.mask_sha256,
        `H5a-H3-candidate-mismatch-${caseId}-${index}`,
      )
      const candidate: Candidate = {
        family: 'h3-dino-sam2',
        id: original.id,
        receipt: { path: original.mask_path, sha256: original.mask_sha256 },
        root: H3_NATIVE_RUN_ROOT,
        dimensions,
        descriptor: { box: original.mask_box_xyxy },
      }
      const geometry = await candidateGeometry(candidate)
      families[candidate.family]!.push({
        family: candidate.family,
        id: candidate.id,
        geometry,
        score: refs.length > 0 ? scoreCandidate(geometry.box, refs) : null,
      })
    }

    const omniReceipts = integrity.omni_masks
    if (runCase.omni_source_result) {
      assert(!caseId.startsWith('pilot-v03-ui-'), `unexpected-omni-result-for-ui-${caseId}`)
      const metadataPath = resolve(runCase.omni_source_result)
      const metadataRelative = relative(h5aRoot, metadataPath)
      assert(
        metadataRelative && metadataRelative !== '..' && !metadataRelative.startsWith(`..${sep}`),
        `omni-metadata-outside-run-${caseId}`,
      )
      const metadataRealPath = await realpath(metadataPath)
      const metadataRealRelative = relative(h5aRoot, metadataRealPath)
      assert(
        metadataRealRelative &&
          metadataRealRelative !== '..' &&
          !metadataRealRelative.startsWith(`..${sep}`),
        `omni-metadata-symlink-escape-${caseId}`,
      )
      assert(
        metadataRealPath.endsWith(`/cases/source-${source.sha256}.json`),
        `omni-metadata-source-name-mismatch-${caseId}`,
      )
      const metadataActual = await fileSha256(metadataRealPath)
      unpinnedMetadata.push({
        caseId,
        bytes: metadataActual.bytes,
        observedSha256: metadataActual.sha256,
        frozenReceipt: false,
      })
      assert(
        omniReceipts?.length === 0 || omniReceipts?.length === 36,
        `omni-proposal-count-mismatch-${caseId}`,
      )
      for (let index = 0; index < (omniReceipts?.length ?? 0); index++) {
        const receipt = omniReceipts![index]!
        const id = `U${String(index).padStart(2, '0')}`
        assert(
          receipt.path.endsWith(`/masks/${source.sha256}/${id}.png`),
          `omni-mask-link-mismatch-${caseId}-${id}`,
        )
        const candidate: Candidate = {
          family: 'omni-sam2',
          id,
          receipt,
          root: h5aRoot,
          dimensions,
        }
        const geometry = await candidateGeometry(candidate)
        families[candidate.family]!.push({
          family: candidate.family,
          id,
          geometry,
          score: refs.length > 0 ? scoreCandidate(geometry.box, refs) : null,
        })
      }
    } else {
      assert(!omniReceipts?.length, `omni-mask-receipt-without-result-${caseId}`)
    }

    const h4eReceipts = integrity.h4e_masks
    if (h4eReceipts?.length) {
      assert(
        caseId.startsWith('pilot-v03-ui-') && h4eReceipts.length === 36,
        `unexpected-h4e-mask-scope-${caseId}`,
      )
      for (let ordinal = 0; ordinal < h4eReceipts.length; ordinal++) {
        const receipt = h4eReceipts[ordinal]!
        const row = h4eByOrdinal.get(ordinal)
        assert(
          row &&
            row.mask_sha256 === receipt.sha256 &&
            resolve(H4E_RUN_ROOT, row.mask_path) === resolve(receipt.path),
          `H4e-cache-mask-link-mismatch-${ordinal}`,
        )
        const candidate: Candidate = {
          family: 'h4e-sam2',
          id: `candidate-${String(ordinal).padStart(3, '0')}`,
          receipt,
          root: H4E_RUN_ROOT,
          dimensions,
          descriptor: { box: row.mask_box_xyxy, area: row.mask_pixel_area, empty: row.empty },
        }
        const geometry = await candidateGeometry(candidate)
        families[candidate.family]!.push({
          family: candidate.family,
          id: candidate.id,
          geometry,
          score: refs.length > 0 ? scoreCandidate(geometry.box, refs) : null,
        })
      }
    }

    const union = [
      ...families['h3-dino-sam2']!,
      ...families['omni-sam2']!,
      ...families['h4e-sam2']!,
    ]
    const familySummaries = Object.fromEntries(
      [...Object.entries(families), ['union', union]].map(([name, candidates]) => {
        const entries = candidates as FamilyCandidate[]
        const passing = entries.filter((item) => item.score?.pass)
        const best = entries.reduce(
          (value, candidate) => {
            if (!candidate.score) return value
            if (
              candidate.score.iou > value.iou ||
              (candidate.score.iou === value.iou && candidate.score.coverage > value.coverage)
            )
              return {
                family: candidate.family,
                id: candidate.id,
                iou: candidate.score.iou,
                coverage: candidate.score.coverage,
              }
            return value
          },
          { family: null as string | null, id: null as string | null, iou: 0, coverage: 0 },
        )
        return [
          name,
          {
            candidateCount: entries.length,
            sameCandidateGatePasses: passing.length,
            available: passing.length > 0,
            bestCandidate: best,
            passingCandidateShortlist: passing.map((item) => ({
              family: item.family,
              id: item.id,
              maskSha256: item.geometry.sha256,
              box: item.geometry.box,
              iou: item.score!.iou,
              coverage: item.score!.coverage,
            })),
            candidateReceipts: entries.map((item) => ({
              family: item.family,
              id: item.id,
              maskSha256: item.geometry.sha256,
              bytes: item.geometry.bytes,
              box: item.geometry.box,
              area: item.geometry.area,
              score: item.score,
            })),
          },
        ]
      }),
    )
    const caseSummary: CaseSummary = {
      caseId,
      stratum: truthRow.stratum,
      presence: truthRow.presence,
      sourceSha256: source.sha256,
      sourceDimensions: dimensions,
      families: familySummaries as Record<string, FamilySummary>,
      ...(truthRow.presence === 'absent'
        ? {
            negativeInterpretation:
              'candidate availability only; no false-positive or selection claim',
          }
        : {}),
    }
    perCase.push(caseSummary)
  }

  const familyNames = ['h3-dino-sam2', 'omni-sam2', 'h4e-sam2', 'union'] as const
  const summaryByFamily = Object.fromEntries(
    familyNames.map((family) => [
      family,
      Object.fromEntries(
        (['photo', 'ui', 'map'] as const).map((stratum) => {
          const rows = perCase.filter(
            (item) => item.stratum === stratum && item.presence === 'present',
          )
          return [
            stratum,
            {
              positiveQueries: rows.length,
              available: rows.filter((row) => row.families[family]!.available).length,
            },
          ]
        }),
      ),
    ]),
  )
  const negatives = perCase
    .filter((item) => item.presence === 'absent')
    .map((item) => ({
      caseId: item.caseId,
      stratum: item.stratum,
      candidatesByFamily: Object.fromEntries(
        familyNames.map((family) => [family, item.families[family]!.candidateCount]),
      ),
    }))
  const maskValidation = Object.fromEntries(
    ['h3-dino-sam2', 'omni-sam2', 'h4e-sam2'].map((family) => {
      const unique = new Map<string, (typeof decodedMasks)[number]>()
      for (const mask of decodedMasks) if (mask.family === family) unique.set(mask.sha256, mask)
      return [
        family,
        {
          uniqueMasks: unique.size,
          allNonemptyBinaryPngs: true,
          allHashesAndPixelGeometryMatched: true,
        },
      ]
    }),
  )
  return {
    schema: 'v03-h5a-native-proposal-availability-evaluation-v1',
    hypothesis: run.hypothesis,
    runSha256: H5A_RUN_SHA256,
    freezeSha256: H5A_FREEZE_SHA256,
    upstreamLocks: {
      h3NativeRunSha256: H3_NATIVE_RUN_SHA256,
      h3SealedRunSha256: H3_SEALED_RUN_SHA256,
      h4eRunSha256: H4E_RUN_SHA256,
      h4eFreezeSha256: H4E_FREEZE_SHA256,
    },
    production: {
      status: run.state,
      paidCalls: run.paid_calls,
      uniqueSources: run.source_integrity_after.length,
    },
    gate: {
      iouAtLeast: GATE_IOU,
      referenceCoverageAtLeast: GATE_COVERAGE,
      sameCandidateAndReference: true,
    },
    provenance: {
      truthSource: 'benchmarks/v03/evaluator-data/pilot-truth.json',
      candidateSemantics:
        'mask availability only; no candidate selected; no false-positive claim for negatives',
      producerClosureRecordsVerified: producerClosure.length,
      sourceImagesVerified: new Set(perCase.map((row) => row.sourceSha256)).size,
      maskValidation,
      candidateMasksValidated: decodedCache.size,
      unpinnedSourceResultMetadata: unpinnedMetadata,
      sourceResultMetadataUse:
        'observed hashes only; metadata JSON was not used to score proposal boxes or masks because H5a run/freeze does not provide file SHA-256 receipts for these files',
    },
    positiveAvailabilityByFamilyAndStratum: summaryByFamily,
    negativeCandidateAvailability: negatives,
    perCase,
  }
}

async function main() {
  const output = resolve(process.argv[2] ?? '/tmp/v03-h5a-native-proposals-evaluation.json')
  const result = await evaluate()
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(
    `${JSON.stringify({ output, status: 'complete', positiveAvailabilityByFamilyAndStratum: result.positiveAvailabilityByFamilyAndStratum, negativeCandidateAvailability: result.negativeCandidateAvailability })}\n`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : 'H5a evaluation failed'}\n`,
    )
    process.exitCode = 1
  })
}
