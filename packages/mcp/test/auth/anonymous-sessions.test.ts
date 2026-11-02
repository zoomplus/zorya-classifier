import assert from 'node:assert/strict'
import test from 'node:test'
import { AnonymousSessionStore } from '../../src/auth/anonymous-sessions.js'

await test('anonymous sessions keep opaque owners, expire, and enforce bounded capacity', () => {
  let now = 1_800_000_000_000
  let index = 0
  const tokens = ['A'.repeat(43), 'B'.repeat(43)]
  const sessions = new AnonymousSessionStore({
    maxSessions: 1,
    ttlMs: 60_000,
    maxJobsPerSessionPerDay: 2,
    maxJobsGloballyPerDay: 3,
    now: () => now,
    token: () => tokens[index++] ?? 'C'.repeat(43),
  })
  const first = sessions.open()
  const principalA = sessions.resolve(first.token)
  if (principalA.transport !== 'http' || principalA.access !== 'anonymous-capability')
    throw new Error('Expected anonymous capability principal.')
  assert.equal(first.expiresAt, now + 60_000)
  assert.throws(() => sessions.open(), /capacity/u)
  sessions.recordSubmission(first.token)
  sessions.recordSubmission(first.token)
  assert.throws(() => sessions.recordSubmission(first.token), /job limit/u)
  now += 60_001
  assert.throws(() => sessions.resolve(first.token), /unavailable/u)
  const second = sessions.open()
  const principalB = sessions.resolve(second.token)
  if (principalB.transport !== 'http' || principalB.access !== 'anonymous-capability')
    throw new Error('Expected anonymous capability principal.')
  assert.notEqual(principalB.ownerId, principalA.ownerId)
  sessions.close()
  assert.throws(() => sessions.resolve(second.token), /unavailable/u)
})
