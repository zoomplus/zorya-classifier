import {
  UI_STATE_DEV40_EXECUTION_V2_DEADLINE_ISO,
  UI_STATE_DEV40_EXECUTION_V2_ID,
  UI_STATE_DEV40_FREEZE_ID,
  UI_STATE_DEV40_PARENT_REGISTRATION_SHA256,
  UI_STATE_DEV40_STUDY_ID,
} from './ui-state-dev40-policy.js'

const syntheticDigest = 'd'.repeat(64)

function ref(path: string, sha256 = syntheticDigest) {
  return { path, sha256 }
}

// This value exercises protocol schema and identity binding only. It is not an
// audit record and does not represent or copy any external evidence bytes.
export function createSyntheticZeroQueryExecutionV2Protocol(): unknown {
  return {
    schema: 'h8a-zero-query-execution-v2-protocol-v1',
    executionId: UI_STATE_DEV40_EXECUTION_V2_ID,
    studyId: UI_STATE_DEV40_STUDY_ID,
    freezeId: UI_STATE_DEV40_FREEZE_ID,
    parentRegistrationSha256: UI_STATE_DEV40_PARENT_REGISTRATION_SHA256,
    canonicalDeadlineIso: UI_STATE_DEV40_EXECUTION_V2_DEADLINE_ISO,
    priorAuthority: {
      ...ref(
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/independent-dev40-v2-preparation.json',
        '3f37626cb763f32f264c90fe61f6c5487691f344143787e63311bb570d2d6c28',
      ),
      sourceClosure: ref('synthetic/source-closure.json'),
      sourceRoster: ref('synthetic/source-roster.json'),
      sourceGroupSplit: ref('synthetic/source-group-split.json'),
      sourceUnionAudit: ref('synthetic/source-union-audit.json'),
      registeredSources: ref('synthetic/registered-sources.json'),
      sourceStateProof: ref('synthetic/source-state-proof.json'),
    },
    priorFreeze: {
      ...ref(
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/freeze-v2/phase-freeze.json',
        '9046fc15a9fc0a13a1d499bad7fa59147f78febaefd2755fde192c9d7030f02b',
      ),
      commitmentSha256: syntheticDigest,
      deadlineIso: '2026-11-02T12:11:51.738058Z',
      cohortCommitmentSha256: syntheticDigest,
      sourceBytesManifestSha256: syntheticDigest,
      producerClosureSha256: syntheticDigest,
      recipeIdentities: [
        {
          profileId: 'synthetic-candidate',
          recipeIdentitySha256: syntheticDigest,
          requestPolicyIdentitySha256: syntheticDigest,
        },
        {
          profileId: 'synthetic-control',
          recipeIdentitySha256: syntheticDigest,
          requestPolicyIdentitySha256: syntheticDigest,
        },
      ],
    },
    priorExecution: {
      audit: ref(
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/main/zero-query-first-execution-audit.json',
        '8c32ec2266e59d3fa81212c5236cbd1cb7713e3d70d045daca41d6e4ab302ad5',
      ),
      registration: ref(
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-campaign-v1/registration.json',
        'ef6a800145e7f8bf87be499726eee6180119845e66321ceef6d024c4e12b6650',
      ),
      terminalStop: ref(
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-campaign-v1/terminal-stop.json',
        '80bce9ddeecfae1ff7b88d0ac4f66f14db9e61a7b4d9625753cf78b564079b11',
      ),
      campaignLedger: ref(
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-campaign-v1/campaign-ledger.json',
        '1bb4600fa99280501251eed53d7ec00581b2fce7160ddeda314ea3e8757e0782',
      ),
      launchIntent: ref(
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-campaign-v1/launch-intents/dev8-launch.json',
        'f5ba83becd4bc5286a2ceaab2a01125f7a4a4c0d815f70d598436fa1e6dda1b6',
      ),
      candidateCloseout: ref(
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-campaign-v1/closeouts/dev40-candidate-closeout.json',
        '99d87afc37cb03cbaf6c310cffc7b47a2c22c2fc6f343badb897dcaacaac9601',
      ),
      controlCloseout: ref(
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-campaign-v1/closeouts/dev40-control-closeout.json',
        '9f1102d347b61a2f4d7a25af10751049178851951d41758fc337ab6daec6e20b',
      ),
      studyCloseout: ref(
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-campaign-v1/closeouts/successor-study-closeout.json',
        '4a7ca14ab2e7190043f09b4505f177a37bd8fe27db7ec6219f1b6632e43f7a76',
      ),
      studyBinding: ref(
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/successor-study-binding.json',
        '9a5b7d3f0c591ade4bc7d9f83b28072ae42619889713f2a84e98314f4e28e9c7',
      ),
      counters: {
        inheritedLogicalAttempts: 32,
        inheritedPhysicalDispatches: 100,
        inheritedKnownCostUsd: 0.059908515,
        inheritedUnknownReserveUsd: 0.12,
        newLogicalCaseAttempts: 0,
        newPhysicalCalls: 0,
        newKnownCostUsd: 0,
        newUnknownReserveUsd: 0,
        dev40KnownCostUsd: 0,
        dev40UnknownReserveUsd: 0,
        dev40ConfirmedPhysicalCalls: 0,
        dev40UncertainPhysicalCalls: 0,
        inFlightReservations: 0,
        nativeSourceCasesExecuted: 0,
      },
      closeout: {
        candidateRows: 40,
        controlRows: 40,
        allRowsUnstarted: true,
        logicalReceipts: 0,
        physicalReceipts: 0,
        qualificationResult: null,
        qual120Eligible: false,
      },
      terminalErrorCode: 'RangeError',
      terminalScreen: 'dev8',
    },
    constraints: {
      sameSourceClaims: true,
      deadlineMayNotBeExtended: true,
      paidRetries: 0,
      globalPhysicalCallLimit: 2000,
      dev40PhysicalCallLimit: 400,
      candidateCallsPerCase: 4,
      controlCallsPerCase: 6,
      candidateMaxUsdPerDispatch: 0.55,
      controlMaxUsdPerDispatch: 0.12,
    },
  }
}
