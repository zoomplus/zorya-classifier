import { z } from 'zod'
import { IpAccessPolicy } from './ip-access.js'

const cidr = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[0-9a-fA-F:.]+\/(?:0|[1-9][0-9]{0,2})$/u)
const exactHost = z
  .string()
  .min(1)
  .max(260)
  .regex(/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::[0-9]{1,5})?$/u)
const origin = z
  .string()
  .url()
  .refine((value) => {
    try {
      const parsed = new URL(value)
      return (
        parsed.protocol === 'https:' &&
        parsed.origin === value &&
        parsed.pathname === '/' &&
        !parsed.search &&
        !parsed.hash &&
        !parsed.username &&
        !parsed.password
      )
    } catch {
      return false
    }
  }, 'Allowed origins must be exact HTTPS origins.')

const ipHttpConfigSchema = z.strictObject({
  accessMode: z.literal('ip'),
  bindHost: z.string().min(1).max(253),
  port: z.number().int().min(0).max(65_535),
  mcpPath: z
    .string()
    .regex(/^\/[a-zA-Z0-9/_-]{1,127}$/u)
    .default('/mcp'),
  allowedCidrs: z.array(cidr).min(1).max(4096),
  trustedProxyCidrs: z.array(cidr).max(4096).default([]),
  allowedHosts: z.array(exactHost).min(1).max(128),
  allowedOrigins: z.array(origin).max(128).default([]),
  maxSessions: z.number().int().min(1).max(100_000).default(10_000),
  sessionTtlMs: z.number().int().min(60_000).max(86_400_000).default(14_400_000),
  maxJobsPerSessionPerDay: z.number().int().min(1).max(10_000).default(20),
  maxJobsPerDay: z.number().int().min(1).max(1_000_000).default(2_000),
  maxRequestsPerMinute: z.number().int().min(1).max(10_000).default(60),
  maxConcurrentRequests: z.number().int().min(1).max(1024).default(32),
  maxRequestBodyBytes: z.number().int().min(1_024).max(32_000_000).default(32_000_000),
  requestTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
})

export type IpHttpConfig = Readonly<z.output<typeof ipHttpConfigSchema>>

export function parseIpHttpConfig(value: unknown): IpHttpConfig {
  const parsed = ipHttpConfigSchema.parse(value)
  new IpAccessPolicy(parsed)
  return parsed
}
