/**
 * The sandbox proxy of the Dev Center's MCP Apps preview (RFC 0038 §8): the outer frame the
 * specification requires a web host to load a view through, on another origin than the host
 * page. It answers only on `127.0.0.1` and only for a page on `localhost` at the same port, so
 * opening the Dev Center on `127.0.0.1` cannot make the proxy same-origin with its host.
 */
import { mcpAppsPageOrigin } from './dev-center-links'

/** `_meta.ui.csp` of a UI resource, as the specification names its fields. */
export interface McpAppsSandboxCsp {
  connectDomains?: string[]
  resourceDomains?: string[]
  frameDomains?: string[]
  baseUriDomains?: string[]
}

/** The `?csp=` query is the host page's own JSON; anything past this is refused, never truncated. */
const MAX_CSP_QUERY = 8192

/** A source expression is an origin or a host pattern; a quote, space or `;` would add a keyword or a directive. */
const SOURCE = /^(?:(?:https?|wss?):\/\/)?(?:\*\.)?[a-z0-9.-]+(?::(?:\d{1,5}|\*))?$/i

/** The dev server's own hosts: a view a real host serves could never reach them, so the preview does not either. */
const LOOPBACK = /^(?:(?:https?|wss?):\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)(?::|$)/i

function sources(domains: unknown): string[] {
  if (!Array.isArray(domains)) return []
  return domains.filter((domain): domain is string => typeof domain === 'string' && SOURCE.test(domain) && !LOOPBACK.test(domain))
}

/**
 * The view's CSP, set on the proxy and inherited by the view `document.write()` puts in its
 * frame. Nothing names `'self'`: the proxy's origin is the application itself on `127.0.0.1`,
 * so `'self'` would let a view reach the app's routes, which a real host's sandbox never allows.
 */
export function mcpAppsSandboxCsp(csp: McpAppsSandboxCsp | undefined, pageOrigin: string): string {
  const resource = sources(csp?.resourceDomains).join(' ')
  const connect = sources(csp?.connectDomains).join(' ')
  const frame = sources(csp?.frameDomains).join(' ')
  const base = sources(csp?.baseUriDomains).join(' ')
  const withResource = (head: string) => `${head}${resource ? ` ${resource}` : ''}`
  return [
    "default-src 'none'",
    withResource("script-src 'unsafe-inline'"),
    withResource("style-src 'unsafe-inline'"),
    withResource('img-src data: blob:'),
    withResource('font-src data:'),
    withResource('media-src data: blob:'),
    `connect-src ${connect || "'none'"}`,
    `frame-src ${frame || "'none'"}`,
    `base-uri ${base || "'none'"}`,
    "object-src 'none'",
    "form-action 'none'",
    `frame-ancestors ${pageOrigin}`,
  ].join('; ')
}

function readCsp(raw: string | null): McpAppsSandboxCsp | undefined | 'invalid' {
  if (raw === null || raw === '') return undefined
  if (raw.length > MAX_CSP_QUERY) return 'invalid'
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as McpAppsSandboxCsp : 'invalid'
  } catch {
    return 'invalid'
  }
}

/**
 * The specification's relay: the first `sandbox-resource-ready` loads the view, `sandbox-*` is never
 * forwarded, and the host origin is the server's, not the referrer's. The view keeps the proxy's
 * origin and URL, as in a real host: Inertia needs `sessionStorage` (opaque origins refuse it) and a
 * `location.href` to resolve visits against (`srcdoc` gives `about:srcdoc`). That origin is the app
 * on 127.0.0.1, so the frame isolates the view from the Dev Center page and token, not from the app.
 */
export function sandboxScript(pageOrigin: string): string {
  const host = JSON.stringify(pageOrigin).replaceAll('<', '\\u003c')
  return `(() => {
  const HOST = ${host};
  const RESERVED = 'ui/notifications/sandbox-';
  if (window.self === window.top) { document.body.textContent = 'This page is the Guren Dev Center\\'s sandbox for MCP App views.'; return; }
  const inner = document.createElement('iframe');
  inner.title = 'MCP App view';
  inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  document.body.appendChild(inner);
  let loaded = false;
  const method = (data) => data !== null && typeof data === 'object' && typeof data.method === 'string' ? data.method : undefined;
  window.addEventListener('message', (event) => {
    const name = method(event.data);
    if (event.source === window.parent) {
      if (event.origin !== HOST) return;
      if (name === RESERVED + 'resource-ready') {
        const html = event.data.params && event.data.params.html;
        if (loaded || typeof html !== 'string') return;
        loaded = true;
        const doc = inner.contentDocument;
        doc.open();
        doc.write(html);
        doc.close();
        return;
      }
      if (name !== undefined && name.startsWith(RESERVED)) return;
      if (inner.contentWindow) inner.contentWindow.postMessage(event.data, location.origin);
      return;
    }
    if (event.source !== inner.contentWindow || event.origin !== location.origin) return;
    if (name !== undefined && name.startsWith(RESERVED)) return;
    window.parent.postMessage(event.data, HOST);
  });
  window.parent.postMessage({ jsonrpc: '2.0', method: RESERVED + 'proxy-ready', params: {} }, HOST);
})();`
}

function sandboxHtml(pageOrigin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MCP App sandbox</title>
<style>html,body{margin:0;height:100%;background:transparent}iframe{display:block;width:100%;height:100%;border:0}</style>
</head>
<body>
<script>${sandboxScript(pageOrigin)}</script>
</body>
</html>
`
}

/** `GET /_guren/mcp-apps/sandbox?csp=<json>`, reached through the Dev MCP endpoint's guard. */
export function serveMcpAppsSandbox(request: Request): Response {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  const url = new URL(request.url)
  const pageOrigin = mcpAppsPageOrigin(url.origin)
  if (!pageOrigin) {
    return new Response('The MCP Apps sandbox is served on 127.0.0.1, for the Dev Center opened on localhost.', { status: 404, headers })
  }
  const csp = readCsp(url.searchParams.get('csp'))
  if (csp === 'invalid') return new Response('The csp parameter is not a JSON object.', { status: 400, headers })
  return new Response(sandboxHtml(pageOrigin), {
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': mcpAppsSandboxCsp(csp, pageOrigin) },
  })
}
