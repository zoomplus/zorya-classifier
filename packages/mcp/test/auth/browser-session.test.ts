import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { exportJWK, SignJWT } from 'jose'
import test from 'node:test'
import { createBrowserLoginService } from '../../src/auth/browser-session.js'
import { createOidcAuthenticator } from '../../src/auth/oidc.js'

let expectedChallenge = ''

await test('browser login binds single-use PKCE state, verified identity, secure cookies and CSRF', async (context) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: 'ephemeral-browser-key',
    alg: 'RS256',
    use: 'sig',
  }
  let issuer = ''
  let idTokenIssuer = ''
  let includeIdTokenExpiry = true
  let nonce = ''
  const setLoginProof = (nextNonce: string, challenge: string): void => {
    nonce = nextNonce
    expectedChallenge = challenge
  }
  const pendingRequests = new Set<Promise<void>>()
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname === '/tenant/.well-known/openid-configuration') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: new URL('authorize', issuer).href,
          token_endpoint: new URL('token', issuer).href,
          jwks_uri: new URL('keys', issuer).href,
        }),
      )
      return
    }
    if (pathname === '/tenant/keys') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ keys: [jwk] }))
      return
    }
    if (pathname === '/tenant/token' && request.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      assert.equal(form.get('grant_type'), 'authorization_code')
      assert.equal(form.get('client_id'), 'viewer-client')
      assert.equal(
        form.get('code_verifier') &&
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url'),
        expectedChallenge,
      )
      const idTokenBuilder = new SignJWT({ nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'ephemeral-browser-key' })
        .setIssuer(idTokenIssuer || issuer)
        .setSubject('browser-user')
        .setAudience('viewer-client')
        .setIssuedAt()
      const identityJwt = includeIdTokenExpiry
        ? await idTokenBuilder.setExpirationTime('2m').sign(privateKey)
        : await idTokenBuilder.sign(privateKey)
      const accessToken = await new SignJWT({ scope: 'viewer read', client_id: 'viewer-client' })
        .setProtectedHeader({ alg: 'RS256', kid: 'ephemeral-browser-key' })
        .setIssuer(issuer)
        .setSubject('browser-user')
        .setAudience('https://mcp.example.test/resource')
        .setIssuedAt()
        .setExpirationTime('2m')
        .sign(privateKey)
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          access_token: accessToken,
          id_token: identityJwt,
          token_type: 'Bearer',
          expires_in: 120,
        }),
      )
      return
    }
    response.writeHead(404).end()
  }
  const server: Server = createServer((request, response) => {
    const tracked = handleRequest(request, response)
      .catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
      .then(() => {
        pendingRequests.delete(tracked)
      })
    pendingRequests.add(tracked)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(async () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ).then(async () => Promise.all(pendingRequests)),
  )
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  issuer = `http://127.0.0.1:${address.port}/tenant/`
  idTokenIssuer = issuer
  const resource = 'https://mcp.example.test/resource'
  const authenticator = await createOidcAuthenticator({
    issuer,
    audience: resource,
    resourceUrl: resource,
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/resource',
    requiredScopes: ['viewer'],
  })
  const browser = await createBrowserLoginService(
    {
      issuer,
      clientId: 'viewer-client',
      redirectUri: `http://127.0.0.1:${address.port}/login/callback`,
      publicOrigin: `http://127.0.0.1:${address.port}`,
      resource,
      scopes: ['viewer', 'read'],
      allowInsecureLoopbackCookies: true,
    },
    authenticator,
  )
  const begin = browser.begin('/viewer/jobs/job-1')
  assert.equal(begin.status, 302)
  const authorization = new URL(begin.headers.get('location') ?? '')
  assert.equal(authorization.origin, new URL(issuer).origin)
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorization.searchParams.get('resource'), resource)
  assert.equal(
    authorization.searchParams.get('redirect_uri'),
    `http://127.0.0.1:${address.port}/login/callback`,
  )
  setLoginProof(
    authorization.searchParams.get('nonce') ?? '',
    authorization.searchParams.get('code_challenge') ?? '',
  )
  assert.ok(nonce)
  assert.ok(expectedChallenge)
  const loginCookie = begin.headers.getSetCookie().find((value) => value.startsWith('zorya-login='))
  assert.ok(loginCookie)
  const binding = loginCookie.split(';', 1)[0] ?? ''
  const callback = new Request(
    `${issuer}/login/callback?code=fake-code&state=${encodeURIComponent(authorization.searchParams.get('state') ?? '')}`,
    { headers: { cookie: binding } },
  )
  const completed = await browser.complete(callback)
  assert.equal(completed.status, 303)
  assert.equal(completed.headers.get('location'), '/viewer/jobs/job-1')
  const cookies = completed.headers.getSetCookie()
  const sessionCookie = cookies.find((value) => value.startsWith('zorya-session='))
  const csrfCookie = cookies.find((value) => value.startsWith('zorya-csrf='))
  assert.ok(sessionCookie)
  assert.ok(csrfCookie)
  const sessionPair = sessionCookie.split(';', 1)[0] ?? ''
  const csrfPair = csrfCookie.split(';', 1)[0] ?? ''
  const csrfToken = csrfPair.slice('zorya-csrf='.length)
  const request = new Request(`${issuer}/logout`, {
    method: 'POST',
    headers: {
      cookie: `${sessionPair}; ${csrfPair}`,
      origin: `http://127.0.0.1:${address.port}`,
      'x-zorya-csrf': csrfToken,
    },
  })
  assert.equal(browser.authenticate(request)?.identity.subject, 'browser-user')
  assert.equal(browser.requireCsrf(request), true)
  assert.equal(
    browser.requireCsrf(
      new Request(request.url, {
        method: 'POST',
        headers: {
          cookie: `${sessionPair}; ${csrfPair}`,
          origin: 'https://attacker.example.test',
          'x-zorya-csrf': csrfToken,
        },
      }),
    ),
    false,
  )
  assert.equal(
    browser.requireCsrf(
      new Request(request.url, {
        method: 'POST',
        headers: {
          cookie: `${sessionPair}; ${csrfPair}`,
          origin: `http://127.0.0.1:${address.port}`,
          'x-zorya-csrf': 'wrong',
        },
      }),
    ),
    false,
  )
  const reused = await browser.complete(callback)
  assert.equal(reused.status, 400)
  const logout = browser.clear(request)
  assert.equal(logout.status, 303)
  assert.equal(browser.authenticate(request), undefined)
  const nearMatchBegin = browser.begin()
  const nearMatchAuthorization = new URL(nearMatchBegin.headers.get('location') ?? '')
  setLoginProof(
    nearMatchAuthorization.searchParams.get('nonce') ?? '',
    nearMatchAuthorization.searchParams.get('code_challenge') ?? '',
  )
  idTokenIssuer = issuer.slice(0, -1)
  const nearMatchCookie =
    nearMatchBegin.headers
      .getSetCookie()
      .find((value) => value.startsWith('zorya-login='))
      ?.split(';', 1)[0] ?? ''
  const nearMatchCallback = new Request(
    `${issuer}login/callback?code=fake-code&state=${encodeURIComponent(nearMatchAuthorization.searchParams.get('state') ?? '')}`,
    { headers: { cookie: nearMatchCookie } },
  )
  assert.equal((await browser.complete(nearMatchCallback)).status, 401)
  idTokenIssuer = issuer
  includeIdTokenExpiry = false
  const noExpiryBegin = browser.begin()
  const noExpiryAuthorization = new URL(noExpiryBegin.headers.get('location') ?? '')
  setLoginProof(
    noExpiryAuthorization.searchParams.get('nonce') ?? '',
    noExpiryAuthorization.searchParams.get('code_challenge') ?? '',
  )
  const noExpiryCookie =
    noExpiryBegin.headers
      .getSetCookie()
      .find((value) => value.startsWith('zorya-login='))
      ?.split(';', 1)[0] ?? ''
  const noExpiryCallback = new Request(
    `${issuer}login/callback?code=fake-code&state=${encodeURIComponent(noExpiryAuthorization.searchParams.get('state') ?? '')}`,
    { headers: { cookie: noExpiryCookie } },
  )
  assert.equal((await browser.complete(noExpiryCallback)).status, 401)
})
