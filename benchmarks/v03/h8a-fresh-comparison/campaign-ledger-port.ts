import type { H8aFreshProfileId } from './profiles.js'

export interface LedgerPhysicalCallContext {
  profileId: H8aFreshProfileId
  opaqueCaseId: string
}

export type LedgerLogicalAttemptContext = LedgerPhysicalCallContext

export interface CampaignLedgerSnapshotPort {
  physicalDispatchCount: number
  logicalAttemptCount: number
  knownCostUsd: number
  unknownReserveUsd: number
  inFlightReservations: readonly { reservationId: number; reservedUsd: number }[]
  resumeBlocked: boolean
}

export interface CampaignLedgerPort {
  snapshot(): CampaignLedgerSnapshotPort
  assertResumeAllowed(): void
  recordLogicalAttempt(context?: LedgerLogicalAttemptContext): Promise<void>
  admitPhysical(reservedUsd: number, context?: LedgerPhysicalCallContext): Promise<number>
  recordDispatchIntent(reservationId: number): Promise<void>
  markDispatched(reservationId: number): Promise<number>
  cancelBeforeFetch(reservationId: number): Promise<void>
  settle(reservationId: number, costUsd: number | null): Promise<void>
  markCrashWithPendingDispatch(): Promise<void>
  assertCanAdmitPhysicalReservedUsd(
    reservedUsd: number,
    context?: LedgerPhysicalCallContext,
  ): Promise<void>
  assertExposureAllowsAdditionalUsd(additionalUsd: number): Promise<void>
}

export interface SuccessorCampaignAdmissionPort extends CampaignLedgerPort {
  assertStudyScopeCanAdmitPhysicalReservedUsd(
    profileId: H8aFreshProfileId,
    reservedUsd: number,
  ): Promise<void>
}
