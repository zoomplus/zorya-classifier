import { BOOTSTRAP_REPLICATES, BOOTSTRAP_SEED } from './constants.js'
import type { H8aFreshStratum } from './constants.js'

interface ClusteredPairedRow {
  opaqueCaseId: string
  stratum: H8aFreshStratum
  sourceGroup: string
  candidateSuccess: boolean
  controlSuccess: boolean
}

interface ClusteredBootstrapResult {
  replicates: number
  seed: number
  observedMeanGain: number
  lower95: number
  upper95: number
  passesStrictlyPositiveLower: boolean
}

type BootstrapRandom = () => number

function mulberry32(seed: number): BootstrapRandom {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

const STRATUM_ORDER = ['photo', 'ui', 'map'] as const

function indexRowsByStratumAndGroup(
  rows: readonly ClusteredPairedRow[],
): Map<H8aFreshStratum, Map<string, ClusteredPairedRow[]>> {
  const byStratum = new Map<H8aFreshStratum, ClusteredPairedRow[]>()
  for (const row of rows) {
    const bucket = byStratum.get(row.stratum) ?? []
    bucket.push(row)
    byStratum.set(row.stratum, bucket)
  }
  for (const stratum of STRATUM_ORDER) {
    const bucket = byStratum.get(stratum)
    if (!bucket || bucket.length === 0) throw new RangeError(`Missing bootstrap stratum ${stratum}`)
  }

  const groupsByStratum = new Map<H8aFreshStratum, Map<string, ClusteredPairedRow[]>>()
  for (const [stratum, bucket] of byStratum) {
    const groups = new Map<string, ClusteredPairedRow[]>()
    for (const row of bucket) {
      const list = groups.get(row.sourceGroup) ?? []
      list.push(row)
      groups.set(row.sourceGroup, list)
    }
    groupsByStratum.set(stratum, groups)
  }
  return groupsByStratum
}

function equalWeightStratumMean(
  groupsByStratum: Map<H8aFreshStratum, Map<string, ClusteredPairedRow[]>>,
  random: BootstrapRandom,
): number {
  let stratumMeanSum = 0
  for (const stratum of STRATUM_ORDER) {
    const groups = groupsByStratum.get(stratum)!
    const groupIds = [...groups.keys()]
    const drawCount = groupIds.length
    let stratumDiffSum = 0
    let stratumRowCount = 0
    for (let draw = 0; draw < drawCount; draw++) {
      const chosenGroupId = groupIds[Math.floor(random() * groupIds.length)]!
      for (const row of groups.get(chosenGroupId)!) {
        stratumDiffSum += Number(row.candidateSuccess) - Number(row.controlSuccess)
        stratumRowCount++
      }
    }
    if (stratumRowCount === 0) throw new RangeError(`Bootstrap stratum ${stratum} produced no rows`)
    stratumMeanSum += stratumDiffSum / stratumRowCount
  }
  return stratumMeanSum / STRATUM_ORDER.length
}

function observedEqualWeightMean(
  groupsByStratum: Map<H8aFreshStratum, Map<string, ClusteredPairedRow[]>>,
): number {
  let stratumMeanSum = 0
  for (const stratum of STRATUM_ORDER) {
    const groups = groupsByStratum.get(stratum)!
    let diffSum = 0
    let rowCount = 0
    for (const groupRows of groups.values()) {
      for (const row of groupRows) {
        diffSum += Number(row.candidateSuccess) - Number(row.controlSuccess)
        rowCount++
      }
    }
    if (rowCount === 0) throw new RangeError(`Observed stratum ${stratum} has no rows`)
    stratumMeanSum += diffSum / rowCount
  }
  return stratumMeanSum / STRATUM_ORDER.length
}

export function bootstrapGroupDrawCountPerStratum(
  rows: readonly ClusteredPairedRow[],
): Record<H8aFreshStratum, number> {
  const groupsByStratum = indexRowsByStratumAndGroup(rows)
  return {
    photo: groupsByStratum.get('photo')!.size,
    ui: groupsByStratum.get('ui')!.size,
    map: groupsByStratum.get('map')!.size,
  }
}

export function clusteredSourceGroupBootstrap(
  rows: readonly ClusteredPairedRow[],
): ClusteredBootstrapResult {
  if (rows.length === 0) throw new RangeError('Bootstrap requires paired rows')
  const groupsByStratum = indexRowsByStratumAndGroup(rows)
  const random = mulberry32(BOOTSTRAP_SEED)

  const observedMeanGain = observedEqualWeightMean(groupsByStratum)

  const replicateMeans: number[] = []
  for (let replicate = 0; replicate < BOOTSTRAP_REPLICATES; replicate++) {
    replicateMeans.push(equalWeightStratumMean(groupsByStratum, random))
  }
  replicateMeans.sort((left, right) => left - right)
  const lower95 = replicateMeans[Math.floor(0.025 * BOOTSTRAP_REPLICATES)]!
  const upper95 = replicateMeans[Math.floor(0.975 * BOOTSTRAP_REPLICATES)]!
  return {
    replicates: BOOTSTRAP_REPLICATES,
    seed: BOOTSTRAP_SEED,
    observedMeanGain,
    lower95,
    upper95,
    passesStrictlyPositiveLower: lower95 > 0,
  }
}

export function sampleBootstrapReplicateRows(
  rows: readonly ClusteredPairedRow[],
  random: BootstrapRandom,
): ClusteredPairedRow[] {
  const groupsByStratum = indexRowsByStratumAndGroup(rows)
  const sampled: ClusteredPairedRow[] = []
  for (const stratum of STRATUM_ORDER) {
    const groups = groupsByStratum.get(stratum)!
    const groupIds = [...groups.keys()]
    for (let draw = 0; draw < groupIds.length; draw++) {
      const chosenGroupId = groupIds[Math.floor(random() * groupIds.length)]!
      sampled.push(...groups.get(chosenGroupId)!)
    }
  }
  return sampled
}
