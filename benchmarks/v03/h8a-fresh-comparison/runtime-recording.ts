import type { DecisionPort } from '../../../src/entities/contracts.js'
import { RunBudget } from '../../v02/budget.js'
import { recordProvider } from '../../v02/recording.js'
import type { Recorder } from '../../v02/recording.js'

interface FixedRuntimeRoute {
  model: string
  provider: string
  providerName: string
  apiEndpoint: '/api/v1/chat/completions' | '/api/alpha/decisions'
  allowFallbacks: false
}

/** Create one immutable route recorder with a route-local cap. */
export function createFixedRouteRecorder(input: {
  createPort(fetcher: typeof globalThis.fetch): DecisionPort
  maxPhysicalCalls: number
  reservedUsdPerPhysicalCall: number
  receiptDirectory: string
  route: FixedRuntimeRoute
  dispatchFetch: typeof globalThis.fetch
}): Recorder {
  const budget = new RunBudget(
    input.maxPhysicalCalls,
    input.reservedUsdPerPhysicalCall * input.maxPhysicalCalls,
    input.reservedUsdPerPhysicalCall,
  )
  return recordProvider(
    (fetch) => input.createPort(fetch),
    budget,
    input.receiptDirectory,
    input.route,
    input.dispatchFetch,
  )
}
