import { randomBytes } from 'node:crypto'
import type { ArtifactDescriptor, JsonValue, Principal } from '../contracts.js'

export interface ViewerDocument {
  readonly ownerId: string
  readonly jobId: string
  readonly title: string
  readonly source: ArtifactDescriptor
  readonly cutout?: ArtifactDescriptor
  readonly mask?: ArtifactDescriptor
  readonly geometryKind?: 'coarse-region' | 'whole-object'
  readonly box?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  readonly maskRegion?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  readonly result: JsonValue
}

export type ViewerDocumentReader = (input: {
  readonly principal: Principal
  readonly jobId: string
  readonly signal: AbortSignal
  readonly deadlineAt: number
}) => Promise<ViewerDocument | undefined>

export type ViewerArtifactReader = (input: {
  readonly principal: Principal
  readonly artifactId: string
  readonly signal: AbortSignal
  readonly deadlineAt: number
  readonly maxBytes: number
}) => Promise<{ readonly bytes: Uint8Array; readonly mediaType: string } | undefined>

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

function jsonForHtml(value: JsonValue): string {
  return JSON.stringify(value, null, 2).replace(/[<>&\u2028\u2029]/gu, (character) => {
    switch (character) {
      case '<':
        return '\\u003c'
      case '>':
        return '\\u003e'
      case '&':
        return '\\u0026'
      case '\u2028':
        return '\\u2028'
      case '\u2029':
        return '\\u2029'
      default:
        return character
    }
  })
}

function boxOverlay(document: ViewerDocument): string {
  if (!document.box || !document.source.width || !document.source.height) return ''
  const { x, y, width, height } = document.box
  const sourceWidth = document.source.width
  const sourceHeight = document.source.height
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > sourceWidth ||
    y + height > sourceHeight
  )
    return ''
  const label = document.geometryKind === 'whole-object' ? 'Whole object box' : 'Coarse region box'
  return `<svg class="overlay" viewBox="0 0 ${sourceWidth} ${sourceHeight}" role="img" aria-label="${label}" preserveAspectRatio="none"><rect x="${x}" y="${y}" width="${width}" height="${height}"/></svg>`
}

function maskOverlay(
  document: ViewerDocument,
  artifactPath: string,
  sourceWidth: number,
  sourceHeight: number,
): string {
  const mask = document.mask
  const region = document.maskRegion
  if (
    !mask ||
    !region ||
    mask.role !== 'mask' ||
    mask.encoding !== 'binary-lsb0' ||
    mask.width === undefined ||
    mask.height === undefined
  )
    return ''
  if (
    ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width <= 0 ||
    region.height <= 0
  )
    return ''
  if (
    region.x + region.width > sourceWidth ||
    region.y + region.height > sourceHeight ||
    region.width !== mask.width ||
    region.height !== mask.height
  )
    return ''
  const src = `/${artifactPath.split('/').filter(Boolean).map(encodeURIComponent).join('/')}/${encodeURIComponent(mask.id)}`
  return `<canvas class="mask" data-mask-src="${src}" data-width="${mask.width}" data-height="${mask.height}" width="${mask.width}" height="${mask.height}" aria-label="Visible foreground mask" style="left:${(region.x / sourceWidth) * 100}%;top:${(region.y / sourceHeight) * 100}%;width:${(region.width / sourceWidth) * 100}%;height:${(region.height / sourceHeight) * 100}%"></canvas>`
}

export function renderViewerDocument(
  document: ViewerDocument,
  artifactPath = '/artifacts',
): Response {
  const width = document.source.width
  const height = document.source.height
  if (!width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    return new Response('Viewer source dimensions are unavailable.', { status: 422 })
  }
  const basePath = `/${artifactPath.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`
  const sourcePath = `${basePath}/${encodeURIComponent(document.source.id)}`
  const cutoutSection = document.cutout
    ? `<section><h2>Visible cutout</h2><img class="cutout" src="${basePath}/${encodeURIComponent(document.cutout.id)}" alt="Visible cutout"></section>`
    : ''
  const mask = maskOverlay(document, artifactPath, width, height)
  const maskStatus =
    mask.length > 0
      ? '<p id="mask-status" role="status" aria-live="polite">Loading visible mask.</p>'
      : ''
  const maskScriptNonce = mask.length > 0 ? randomBytes(18).toString('base64url') : undefined
  const maskScript =
    maskScriptNonce === undefined
      ? ''
      : `<script nonce="${maskScriptNonce}">for(const canvas of document.querySelectorAll('canvas[data-mask-src]')){void(async()=>{const status=document.querySelector('#mask-status');const width=Number(canvas.dataset.width);const height=Number(canvas.dataset.height);if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width*height>16777216){status.textContent='Mask preview unavailable.';return}try{const response=await fetch(canvas.dataset.maskSrc,{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw new Error('artifact_read_failed');const packed=new Uint8Array(await response.arrayBuffer());if(packed.byteLength!==Math.ceil(width*height/8))throw new Error('mask_size_mismatch');const context=canvas.getContext('2d');if(!context)throw new Error('canvas_unavailable');const image=context.createImageData(width,height);for(let pixel=0;pixel<width*height;pixel++){if((packed[pixel>>3]&(1<<(pixel&7)))!==0){const offset=pixel*4;image.data[offset]=22;image.data[offset+1]=163;image.data[offset+2]=74;image.data[offset+3]=145}}context.putImageData(image,0,0);status.textContent='Visible foreground mask.'}catch{status.textContent='Mask preview unavailable.'}})()}</script>`
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(document.title)}</title><style>
body{font:16px system-ui,sans-serif;margin:0 auto;padding:1rem;max-width:72rem;color:#17202a}h1,h2{font-size:1.2rem}.stage{position:relative;width:min(100%,${width}px);aspect-ratio:${width}/${height};background:#eee}.stage img,.overlay{position:absolute;inset:0;width:100%;height:100%}.stage img{object-fit:fill}.overlay{pointer-events:none}.overlay rect{fill:#22c55e22;stroke:#16a34a;stroke-width:${Math.max(2, Math.min(width, height) / 300)}}.mask{position:absolute;image-rendering:pixelated;pointer-events:none}.cutout{max-width:100%;max-height:65vh;object-fit:contain;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 50%/16px 16px}pre{max-height:30rem;overflow:auto;padding:1rem;background:#f3f4f6;white-space:pre-wrap;overflow-wrap:anywhere}
</style></head><body><main><h1>${escapeHtml(document.title)}</h1><section><h2>${document.geometryKind === 'whole-object' ? 'Whole object box' : document.geometryKind === 'coarse-region' ? 'Coarse region box' : 'Source image'}</h2><div class="stage"><img src="${sourcePath}" width="${width}" height="${height}" alt="Original source image">${mask}${boxOverlay(document)}</div>${maskStatus}<p>Original source dimensions: ${width} × ${height} pixels.</p></section>${cutoutSection}<section><h2>Operation result</h2><pre>${escapeHtml(jsonForHtml(document.result))}</pre></section></main>${maskScript}</body></html>`
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; img-src 'self'; script-src ${maskScriptNonce === undefined ? "'none'" : `'nonce-${maskScriptNonce}'`}; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  })
}

export function viewerDocumentOwnedBy(document: ViewerDocument, principal: Principal): boolean {
  return document.ownerId === principal.ownerId
}
