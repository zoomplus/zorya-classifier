import { randomBytes } from 'node:crypto'
import type { HttpConfig } from '../http/config.js'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case "'":
        return '&#39;'
      default:
        return character
    }
  })
}

export function renderSettingsPage(config: HttpConfig, openRouterEnabled: boolean): Response {
  const nonce = randomBytes(18).toString('base64url')
  const forms = config.credentialProfileIds
    .map(
      (profileId) =>
        `<form class="credential" data-profile="${escapeHtml(profileId)}"><label>Provider profile <code>${escapeHtml(profileId)}</code><input name="apiKey" type="password" autocomplete="new-password" maxlength="8192" required></label><button type="submit">Save provider key</button><button type="button" data-remove>Remove provider key</button><output aria-live="polite"></output></form>`,
    )
    .join('\n')
  const openRouter = openRouterEnabled
    ? '<button id="openrouter" type="button">Connect OpenRouter</button><output id="openrouter-result" aria-live="polite"></output>'
    : ''
  const csrfCookie =
    new URL(config.publicOrigin).protocol === 'https:' ? '__Host-zorya-csrf' : 'zorya-csrf'
  const script = `const csrfCookie=${JSON.stringify(csrfCookie)};const csrf=()=>{const item=document.cookie.split(';').map((part)=>part.trim()).find((part)=>part.startsWith(csrfCookie+'='));return item?decodeURIComponent(item.slice(csrfCookie.length+1)):''};for(const form of document.querySelectorAll('form.credential')){form.addEventListener('submit',async(event)=>{event.preventDefault();const field=form.elements.namedItem('apiKey');const output=form.querySelector('output');try{const response=await fetch(${JSON.stringify(config.credentialPath)},{method:'POST',headers:{'content-type':'application/json','x-zorya-csrf':csrf()},body:JSON.stringify({profileId:form.dataset.profile,apiKey:field.value}),credentials:'same-origin'});field.value='';output.textContent=response.ok?'Saved.': 'Could not save this key.'}catch{field.value='';output.textContent='Could not save this key.'}});form.querySelector('[data-remove]').addEventListener('click',async()=>{const output=form.querySelector('output');try{const response=await fetch(${JSON.stringify(config.credentialPath)},{method:'DELETE',headers:{'content-type':'application/json','x-zorya-csrf':csrf()},body:JSON.stringify({profileId:form.dataset.profile}),credentials:'same-origin'});output.textContent=response.ok?'Removed.':'Could not remove this key.'}catch{output.textContent='Could not remove this key.'}})}${openRouterEnabled ? `document.querySelector('#openrouter').addEventListener('click',async()=>{const output=document.querySelector('#openrouter-result');try{const response=await fetch(${JSON.stringify(config.openRouterConnectPath)},{method:'POST',headers:{'x-zorya-csrf':csrf()},credentials:'same-origin'});const result=await response.json();const authorization=new URL(result.authorizationUrl,window.location.href);if(!response.ok||authorization.origin!=='https://openrouter.ai'||authorization.pathname!=='/auth')throw new Error('openrouter_start_failed');window.location.assign(authorization.href)}catch{output.textContent='Could not start OpenRouter connection.'}})` : ''}`
  const logout = `<button id="logout" type="button">Sign out</button><output id="logout-result" aria-live="polite"></output>`
  const logoutScript = `document.querySelector('#logout').addEventListener('click',async()=>{try{await fetch(${JSON.stringify(config.logoutPath)},{method:'POST',headers:{'x-zorya-csrf':csrf()},credentials:'same-origin'});window.location.assign('/login')}catch{document.querySelector('#logout-result').textContent='Could not sign out.'}})`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Provider settings</title></head><body><main><h1>Provider settings</h1><p>Keys are saved for your signed-in account and selected profile.</p>${forms}${openRouter}${logout}</main><script nonce="${nonce}">${script}${logoutScript}</script></body></html>`
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  })
}
