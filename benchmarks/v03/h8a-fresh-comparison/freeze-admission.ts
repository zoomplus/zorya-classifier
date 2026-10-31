import {
  CAMPAIGN_MAX_COST_USD,
  DEV40_WORST_CASE_PHYSICAL_CALLS,
  PHASE_DEV40_ID,
  PHASE_QUAL120_ID,
  PROFILE_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
  QUAL120_WORST_CASE_PHYSICAL_CALLS,
} from './constants.js'
import type { CampaignLedger } from './campaign-ledger.js'
import { hashIdentity } from './hash-identity.js'
import { H8A_CANDIDATE_PROFILE, V02_CONTROL_PROFILE, profileById } from './profiles.js'
import type { PhaseFreeze } from './schemas.js'

export function validateProfileIdentities(freeze: PhaseFreeze): void {
  for (const binding of freeze.profileBindings) {
    const profile = profileById(binding.profileId)
    if (binding.requestPolicyIdentitySha256 !== profile.requestPolicyIdentitySha256)
      throw new RangeError(`Request policy identity mismatch for ${binding.profileId}`)
    const recipeIdentity = hashIdentity({
      profileId: profile.profileId,
      recipeKind: profile.recipeKind,
      requestPolicyIdentitySha256: profile.requestPolicyIdentitySha256,
    })
    if (binding.recipeIdentitySha256 !== recipeIdentity)
      throw new RangeError(`Recipe identity mismatch for ${binding.profileId}`)
  }
}

export function reservedUsdUpperBoundForProfile(
  freeze: PhaseFreeze,
  profileId: typeof PROFILE_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
): number {
  const entry = freeze.conservativeCostProof.profileDispatchUpperBounds.find(
    (item) => item.profileId === profileId,
  )
  if (!entry) throw new RangeError(`Missing dispatch upper bound for ${profileId}`)
  return entry.maxUsdPerPhysicalDispatch
}

function maxPairedCaseReservedUsd(freeze: PhaseFreeze): number {
  return (
    freeze.callLimits.candidateMaxPhysicalCallsPerCase *
      reservedUsdUpperBoundForProfile(freeze, PROFILE_CANDIDATE_ID) +
    freeze.callLimits.controlMaxPhysicalCallsPerCase *
      reservedUsdUpperBoundForProfile(freeze, PROFILE_CONTROL_ID)
  )
}

export function validateConservativeCostProof(freeze: PhaseFreeze): void {
  const proof = freeze.conservativeCostProof
  const recomputed = hashIdentity({
    schema: proof.schema,
    proofKind: proof.proofKind,
    maxUsdPerPhysicalDispatch: proof.maxUsdPerPhysicalDispatch,
    profileDispatchUpperBounds: proof.profileDispatchUpperBounds,
    derivedFrom: proof.derivedFrom,
  })
  if (recomputed !== proof.proofSha256)
    throw new RangeError('Conservative cost proof hash mismatch')
  const candidateBound = reservedUsdUpperBoundForProfile(freeze, PROFILE_CANDIDATE_ID)
  const controlBound = reservedUsdUpperBoundForProfile(freeze, PROFILE_CONTROL_ID)
  const aggregateMax = Math.max(candidateBound, controlBound)
  if (Math.abs(proof.maxUsdPerPhysicalDispatch - aggregateMax) > 1e-12)
    throw new RangeError('Conservative cost proof aggregate max mismatch')
}

function validateProfileDispatchUpperBoundBinding(freeze: PhaseFreeze): void {
  for (const binding of freeze.profileBindings) {
    reservedUsdUpperBoundForProfile(freeze, binding.profileId)
  }
  if (
    freeze.profileBindings[0]!.profileId !== H8A_CANDIDATE_PROFILE.profileId ||
    freeze.profileBindings[1]!.profileId !== V02_CONTROL_PROFILE.profileId
  )
    throw new RangeError('Profile binding order must be candidate then control')
}

function phaseWorstCasePhysicalCalls(phaseId: PhaseFreeze['phaseId']): number {
  if (phaseId === PHASE_DEV40_ID) return DEV40_WORST_CASE_PHYSICAL_CALLS
  return QUAL120_WORST_CASE_PHYSICAL_CALLS
}

export function validateQualificationSourceGroupSeparation(
  freeze: PhaseFreeze,
  groupIds: readonly string[],
): void {
  if (freeze.phaseId !== PHASE_QUAL120_ID) return
  if (!freeze.enforceQualificationSourceGroupSeparation)
    throw new RangeError('Qualification freeze must declare source-group separation')
  if (groupIds.length === 0) throw new RangeError('Qualification source groups required')
}

function validateFreezeAdmissionProofs(freeze: PhaseFreeze): void {
  validateProfileIdentities(freeze)
  validateConservativeCostProof(freeze)
  validateProfileDispatchUpperBoundBinding(freeze)
  if (freeze.callLimits.phaseWorstCasePhysicalCalls !== phaseWorstCasePhysicalCalls(freeze.phaseId))
    throw new RangeError('Phase worst-case physical call bound mismatch')
  const pairedCaseReserve = maxPairedCaseReservedUsd(freeze)
  if (pairedCaseReserve > CAMPAIGN_MAX_COST_USD + 1e-12)
    throw new RangeError('Current paired-case reserve envelope exceeds campaign cost ceiling')
}

export async function assertFreezeAdmissionAsync(
  freeze: PhaseFreeze,
  ledger: CampaignLedger,
): Promise<void> {
  validateFreezeAdmissionProofs(freeze)
  const pairedCaseReserve = maxPairedCaseReservedUsd(freeze)
  const highestSingleFetch = Math.max(
    reservedUsdUpperBoundForProfile(freeze, PROFILE_CANDIDATE_ID),
    reservedUsdUpperBoundForProfile(freeze, PROFILE_CONTROL_ID),
  )
  await ledger.assertCanAdmitPhysicalReservedUsd(highestSingleFetch)
  await ledger.assertExposureAllowsAdditionalUsd(pairedCaseReserve)
}
