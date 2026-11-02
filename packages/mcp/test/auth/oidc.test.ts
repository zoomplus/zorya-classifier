import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { exportJWK, SignJWT } from 'jose'
import test from 'node:test'
import { createOidcAuthenticator } from '../../src/auth/oidc.js'

await test('OIDC authentication binds stable owner to verified issuer and subject', async (context) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const { privateKey: otherPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = await exportJWK(publicKey)
  jwk['kid'] = 'ephemeral-test-key'
  jwk['alg'] = 'RS256'
  jwk['use'] = 'sig'
  let issuer = ''
  const server: Server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname === '/tenant/.well-known/openid-configuration') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ issuer, jwks_uri: new URL('keys', issuer).href }))
      return
    }
    if (pathname === '/tenant/keys') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ keys: [jwk] }))
      return
    }
    response.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(
    async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  )
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  issuer = `http://127.0.0.1:${address.port}/tenant/`
  const audience = 'https://mcp.example.test/resource'
  const authenticator = await createOidcAuthenticator({
    issuer,
    audience,
    resourceUrl: audience,
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource',
    requiredScopes: ['classify'],
    timeoutMs: 1_000,
  })
  const token = (
    overrides: {
      readonly sub?: string
      readonly aud?: string
      readonly exp?: number
      readonly scope?: string
      readonly clientId?: string
      readonly iss?: string
    } = {},
  ) =>
    new SignJWT({
      scope: overrides.scope ?? 'classify read',
      client_id: overrides.clientId ?? 'client-one',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'ephemeral-test-key' })
      .setIssuer(overrides.iss ?? issuer)
      .setSubject(overrides.sub ?? 'same-person')
      .setAudience(overrides.aud ?? audience)
      .setIssuedAt()
      .setExpirationTime(overrides.exp ?? '2m')
      .sign(privateKey)

  const firstToken = await token()
  const refreshedToken = await token({ clientId: 'client-two' })
  const otherUserToken = await token({ sub: 'different-person', clientId: 'client-one' })
  const invalidSignatureToken = await new SignJWT({
    scope: 'classify read',
    client_id: 'client-one',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'ephemeral-test-key' })
    .setIssuer(issuer)
    .setSubject('same-person')
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(otherPrivateKey)
  const first = await authenticator.authenticate(
    new Request(audience, { headers: { authorization: `Bearer ${firstToken}` } }),
  )
  const refreshed = await authenticator.authenticate(
    new Request(audience, { headers: { authorization: `Bearer ${refreshedToken}` } }),
  )
  const otherUser = await authenticator.authenticate(
    new Request(audience, { headers: { authorization: `Bearer ${otherUserToken}` } }),
  )
  assert.ok(first)
  assert.ok(refreshed)
  assert.equal(first.ownerId, refreshed.ownerId)
  assert.equal(first.identity.issuer, issuer)
  assert.notEqual(first.authInfo.clientId, refreshed.authInfo.clientId)
  assert.equal(first.identity.subject, 'same-person')
  assert.ok(otherUser)
  assert.notEqual(first.ownerId, otherUser.ownerId)
  assert.equal(otherUser.authInfo.clientId, first.authInfo.clientId)
  assert.equal(
    await authenticator.authenticate(
      new Request(audience, {
        headers: {
          authorization: `Bearer ${await token({ sub: 'same-person', aud: 'wrong-resource' })}`,
        },
      }),
    ),
    undefined,
  )
  assert.equal(
    await authenticator.authenticate(
      new Request(audience, {
        headers: {
          authorization: `Bearer ${await token({ exp: Math.floor(Date.now() / 1_000) - 30 })}`,
        },
      }),
    ),
    undefined,
  )
  assert.equal(
    await authenticator.authenticate(
      new Request(audience, { headers: { authorization: `Bearer ${invalidSignatureToken}` } }),
    ),
    undefined,
  )
  assert.equal(
    await authenticator.authenticate(
      new Request(audience, {
        headers: { authorization: `Bearer ${await token({ scope: 'read' })}` },
      }),
    ),
    undefined,
  )
  assert.equal(
    await authenticator.authenticate(
      new Request(audience, {
        headers: { authorization: `Bearer ${await token({ iss: issuer.slice(0, -1) })}` },
      }),
    ),
    undefined,
  )
  const challenge = authenticator.challenge()
  assert.equal(challenge.status, 401)
  assert.match(challenge.headers.get('www-authenticate') ?? '', /resource_metadata=/u)
})
