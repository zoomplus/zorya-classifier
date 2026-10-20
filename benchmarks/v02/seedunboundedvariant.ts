import { hashCanonical } from './protocol.js'

export const seedUnboundedRoutes = Object.freeze([
  {
    id: 'native-luna-axis-seed-unbounded-v1',
    adapter: 'native-decisions',
    model: 'openai/gpt-6-luna-decisions',
    provider: 'openai',
    providerName: 'OpenAI',
    apiEndpoint: '/api/alpha/decisions',
    boundaryPresentation: 'axis-rulers-v1',
  },
  {
    id: 'ordinary-luna-axis-seed-unbounded-v1',
    adapter: 'ordinary-vision',
    model: 'openai/gpt-6-luna',
    provider: 'openai',
    providerName: 'OpenAI',
    apiEndpoint: '/api/v1/chat/completions',
    boundaryPresentation: 'axis-rulers-v1',
    responseFormat: 'json-schema',
    reasoningEffort: 'none',
    maxOutputTokens: 1024,
  },
] as const)

export const seedUnboundedPolicy = Object.freeze({
  promptId: 'seed-unbounded-v1',
  prompt:
    'The target means the entire visible physical target in ORIGINAL. SEED is only an interior witness for identifying the same instance; the SEED crop boundaries do not limit the target extent. Include every visible part of that same target outside SEED, subject only to HARD_ROI.',
  boxTolerancePx: 8,
  maxExtentPasses: 3,
  timeoutMs: 45000,
  retries: 0,
  allowFallbacks: false,
  latencyEnvironment: 'concurrent-with-linux-native-soak',
  latencyRankingEligible: false,
})

export function seedUnboundedVariantHash(sourceHashes: Record<string, string>): string {
  const entries = Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b))
  if (!entries.length || entries.some(([, hash]) => !/^[a-f0-9]{64}$/u.test(hash)))
    throw new TypeError('seed-unbounded-v1 requires frozen SHA-256 source digests')
  return hashCanonical({
    routes: seedUnboundedRoutes,
    policy: seedUnboundedPolicy,
    sourceHashes: entries,
  })
}
