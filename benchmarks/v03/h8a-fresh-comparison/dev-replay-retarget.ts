import {
  PHASE_FLAT_DEV40_ID,
  PHASE_SCOPE_DEV40_ID,
  PHASE_NATIVE_PRESENCE_DEV40_ID,
} from './constants.js'
import {
  AUTHORED_SCOPE_STUDY_ID,
  NATIVE_PRESENCE_STUDY_ID,
  replayStudyPolicy,
} from './dev-replay-study-policy.js'

/** Checks the only permitted parent/child phase edge for a closed replay study. */
export function assertClosedReplayRetargetIdentity(
  studyId: typeof AUTHORED_SCOPE_STUDY_ID | typeof NATIVE_PRESENCE_STUDY_ID,
  parentPhaseId: string,
  nextFreezeId: string,
  nextPhaseId: string,
): void {
  if (studyId !== AUTHORED_SCOPE_STUDY_ID && studyId !== NATIVE_PRESENCE_STUDY_ID)
    throw new RangeError('Replay retarget study is outside the closed successor set')
  const policy = replayStudyPolicy(studyId)
  const expectedParentPhase =
    studyId === NATIVE_PRESENCE_STUDY_ID ? PHASE_SCOPE_DEV40_ID : PHASE_FLAT_DEV40_ID
  const expectedChildPhase =
    studyId === NATIVE_PRESENCE_STUDY_ID ? PHASE_NATIVE_PRESENCE_DEV40_ID : PHASE_SCOPE_DEV40_ID
  if (parentPhaseId !== expectedParentPhase)
    throw new RangeError('Replay parent freeze is outside its closed phase lineage')
  if (nextFreezeId !== policy.freezeId || nextPhaseId !== expectedChildPhase)
    throw new RangeError('Replay child freeze differs from its registered study identity')
}
