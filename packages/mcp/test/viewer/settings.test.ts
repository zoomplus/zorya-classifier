import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHttpConfig } from '../../src/http/config.js'
import { renderSettingsPage } from '../../src/viewer/settings.js'

await test('settings page uses nonce CSP and posts secrets only to the same-origin credential route', async () => {
  const config = parseHttpConfig({
    bindHost: '127.0.0.1',
    port: 0,
    publicOrigin: 'https://mcp.example.test',
    resourceUrl: 'https://mcp.example.test/mcp',
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    issuer: 'https://issuer.example.test',
    audience: 'https://mcp.example.test/mcp',
    requiredScopes: ['classify'],
    allowedHosts: ['mcp.example.test'],
    allowedOrigins: ['https://mcp.example.test'],
    credentialProfileIds: ['primary<profile>'],
  })
  const response = renderSettingsPage(config, true)
  const html = await response.text()
  const csp = response.headers.get('content-security-policy') ?? ''
  const nonce = csp.match(/script-src 'nonce-([^']+)'/u)?.[1]
  assert.ok(nonce)
  assert.match(html, new RegExp(`<script nonce="${nonce}"`, 'u'))
  assert.match(html, /primary&lt;profile&gt;/u)
  assert.match(html, /type="password"/u)
  assert.match(html, /fetch\("\/settings\/provider-key"/u)
  assert.match(html, /x-zorya-csrf/u)
  assert.match(html, /Connect OpenRouter/u)
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/u)
})
