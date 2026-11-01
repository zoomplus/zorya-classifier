import type { CaseExecutionPortResult } from './paired-runner.js'

interface NativePresenceEvidenceSource {
  sourceId: 'native-presence' | 'vision'
  logicalReceipts: CaseExecutionPortResult['logicalReceipts']
  physicalReceipts: CaseExecutionPortResult['physicalReceipts']
}

interface NativePresenceLogicalMapping {
  sourceId: NativePresenceEvidenceSource['sourceId']
  localLogicalId: number
  combinedLogicalId: number
}

interface AssembledNativePresenceEvidence {
  logicalReceipts: CaseExecutionPortResult['logicalReceipts']
  physicalReceipts: CaseExecutionPortResult['physicalReceipts']
  mappings: NativePresenceLogicalMapping[]
}

/**
 * Combine the two route-local recorder namespaces without changing either raw recorder.
 * The caller supplies sources in pipeline invocation order: native presence, then vision.
 */
export function assembleNativePresenceEvidence(
  sources: readonly NativePresenceEvidenceSource[],
): AssembledNativePresenceEvidence {
  const mappings: NativePresenceLogicalMapping[] = []
  const logicalReceipts: CaseExecutionPortResult['logicalReceipts'] = []
  const physicalReceipts: CaseExecutionPortResult['physicalReceipts'] = []
  const combinedBySourceAndLocalId = new Map<string, number>()
  const seenGlobalReceiptIds = new Set<number>()
  const seenGlobalPhysicalIds = new Set<number>()
  let nextLogicalId = 1

  for (const source of sources) {
    const sourceLocalIds = new Set<number>()
    for (const receipt of source.logicalReceipts) {
      if (sourceLocalIds.has(receipt.logicalId))
        throw new RangeError('A route recorder emitted a duplicate local logical ID')
      sourceLocalIds.add(receipt.logicalId)
      const combinedLogicalId = nextLogicalId++
      const key = `${source.sourceId}:${receipt.logicalId}`
      if (combinedBySourceAndLocalId.has(key))
        throw new RangeError('Route logical ID mapping is not one-to-one')
      combinedBySourceAndLocalId.set(key, combinedLogicalId)
      mappings.push({
        sourceId: source.sourceId,
        localLogicalId: receipt.logicalId,
        combinedLogicalId,
      })
      logicalReceipts.push({ ...receipt, logicalId: combinedLogicalId })
    }
    for (const receipt of source.physicalReceipts) {
      if (seenGlobalReceiptIds.has(receipt.receiptId))
        throw new RangeError('Global physical reservation IDs must remain unique across routes')
      seenGlobalReceiptIds.add(receipt.receiptId)
      if (receipt.physicalId !== null) {
        if (seenGlobalPhysicalIds.has(receipt.physicalId))
          throw new RangeError('Global physical dispatch IDs must remain unique across routes')
        seenGlobalPhysicalIds.add(receipt.physicalId)
      }
      const mapping = combinedBySourceAndLocalId.get(`${source.sourceId}:${receipt.logicalId}`)
      if (mapping === undefined)
        throw new RangeError('Physical evidence references an unknown route-local logical ID')
      physicalReceipts.push({ ...receipt, logicalId: mapping })
    }
  }

  if (mappings.length !== logicalReceipts.length)
    throw new RangeError('Combined route evidence lost a logical receipt mapping')
  return { logicalReceipts, physicalReceipts, mappings }
}
