import type { MiddlewareHandler } from 'hono'
import { matchingOpenParen } from '../support/stack-frames'

/** Development-only error page: exposes the stack trace and request details. */
export function renderDebugPage(error: Error, request?: Request): string {
  const errorName = error.name || 'Error'
  const errorMessage = escapeHtml(error.message || 'An unknown error occurred')
  const stackFrames = parseStackTrace(error.stack ?? '')
  const statusCode = getStatusCode(error)

  const requestSection = request ? renderRequestSection(request) : ''
  const stackSection = renderStackSection(stackFrames)
  const environmentSection = renderEnvironmentSection()

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(errorName)}: ${errorMessage}</title>
<style>
  /* Guren UI's tokens (github.com/gurenjs/guren-ui), following the OS theme. */
  :root {
    color-scheme: light;
    --g-font-sans: 'Noto Sans JP', ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --g-font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --g-page: #ffffff; --g-panel: #ffffff; --g-raised: #fffafa; --g-line: #e5e7eb; --g-line-strong: #d1d5db;
    --g-heading: #111827; --g-text: #1f2937; --g-text-2: #4b5563; --g-muted: #9ca3af;
    --g-danger: #b91c1c; --g-danger-chip: #f23a3a; --g-danger-tint: #fff1f2; --g-accent: #db1b1b;
    --g-shadow-card: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --g-page: #1a1a2e; --g-panel: #1e1e34; --g-raised: #232340; --g-line: #2e2e4a; --g-line-strong: #3d3d5c;
      --g-heading: #e0def4; --g-text: #e0def4; --g-text-2: #908caa; --g-muted: #6e6a86;
      --g-danger: #ffa5a5; --g-danger-tint: rgba(242, 58, 58, 0.12);
      --g-shadow-card: 0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -1px rgba(0, 0, 0, 0.2);
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--g-font-sans); background: var(--g-page); color: var(--g-text); line-height: 1.6; min-height: 100vh; -webkit-font-smoothing: antialiased; }
  code, .mono { font-family: var(--g-font-mono); }
  .container { max-width: 960px; margin: 0 auto; padding: 2rem 1.5rem; }

  .error-header { display: flex; align-items: flex-start; gap: 1.5rem; margin-bottom: 2rem; padding: 2rem; background: var(--g-panel); border: 1px solid var(--g-line); border-radius: 12px; border-left: 4px solid var(--g-danger-chip); box-shadow: var(--g-shadow-card); }
  .status-badge { flex-shrink: 0; display: flex; align-items: center; justify-content: center; width: 64px; height: 64px; background: var(--g-danger-tint); color: var(--g-danger); font: 700 1.25rem/1 var(--g-font-mono); border-radius: 12px; }
  .error-info { min-width: 0; }
  .error-class { font-size: 1.5rem; font-weight: 700; color: var(--g-danger); letter-spacing: -0.01em; margin-bottom: 0.25rem; word-break: break-word; }
  .error-message { font-size: 1.1rem; color: var(--g-heading); word-break: break-word; }

  .section { margin-bottom: 1rem; background: var(--g-panel); border: 1px solid var(--g-line); border-radius: 12px; box-shadow: var(--g-shadow-card); overflow: hidden; }
  .section-toggle { display: flex; align-items: center; gap: 0.75rem; width: 100%; padding: 1rem 1.25rem; background: none; border: none; cursor: pointer; color: var(--g-heading); text-align: left; font-family: inherit; }
  .section-toggle:hover { background: var(--g-raised); }
  .section-toggle:focus-visible { outline: 2px solid var(--g-accent); outline-offset: -2px; }
  .section-toggle h2 { font-size: 15px; font-weight: 700; }
  .toggle-icon { font-size: 0.7rem; color: var(--g-muted); flex-shrink: 0; width: 1rem; text-align: center; }
  .badge { font: 500 12px/1.6 var(--g-font-mono); color: var(--g-text-2); background: var(--g-raised); box-shadow: inset 0 0 0 1px var(--g-line); padding: 2px 9px; border-radius: 999px; margin-left: auto; }
  .section-content { padding: 0 1.25rem 1.25rem; }

  .stack-frames { display: flex; flex-direction: column; gap: 2px; }
  .frame { padding: 0.6rem 0.75rem; border-radius: 8px; cursor: default; transition: background 0.15s; }
  .frame:hover { background: var(--g-raised); }
  .frame.vendor { opacity: 0.5; }
  .frame.vendor:hover { opacity: 0.75; }
  .frame-header { display: flex; align-items: center; gap: 0.75rem; font-size: 0.875rem; }
  .frame-index { color: var(--g-muted); font: 500 0.75rem var(--g-font-mono); min-width: 2rem; flex-shrink: 0; }
  .frame-method { color: var(--g-heading); font-family: var(--g-font-mono); font-weight: 500; }
  .frame-location { color: var(--g-text-2); font-family: var(--g-font-mono); font-size: 0.8rem; margin-left: auto; text-align: right; word-break: break-all; }

  .request-summary { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; }
  .method-badge { display: inline-block; padding: 2px 9px; color: var(--g-text-2); background: var(--g-raised); box-shadow: inset 0 0 0 1px var(--g-line); font: 500 12px/1.6 var(--g-font-mono); border-radius: 999px; }
  .request-url { font-family: var(--g-font-mono); font-size: 0.9rem; word-break: break-all; }

  .subsection { margin-top: 1rem; }
  .subsection h3 { font: 500 11.5px/1.6 var(--g-font-mono); color: var(--g-muted); margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.06em; }

  .details-table { width: 100%; border-collapse: collapse; }
  .details-table tr { border-bottom: 1px solid var(--g-line); }
  .details-table tr:last-child { border-bottom: none; }
  .details-table td { padding: 0.4rem 0; font-size: 0.85rem; vertical-align: top; }
  .details-table td.key { color: var(--g-text-2); font-weight: 500; width: 200px; padding-right: 1rem; font-family: var(--g-font-mono); font-size: 0.8rem; }
  .details-table td.value { color: var(--g-text); word-break: break-all; font-family: var(--g-font-mono); font-size: 0.8rem; }

  .muted { color: var(--g-muted); font-style: italic; }
  .footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--g-line); text-align: center; color: var(--g-muted); font-size: 0.8rem; }
</style>
</head>
<body>
<div class="container">
  <header class="error-header">
    <div class="status-badge">${statusCode}</div>
    <div class="error-info">
      <h1 class="error-class">${escapeHtml(errorName)}</h1>
      <p class="error-message">${errorMessage}</p>
    </div>
  </header>

  ${stackSection}
  ${requestSection}
  ${environmentSection}

  <footer class="footer">
    <p>Guren Framework &mdash; Debug Error Page</p>
  </footer>
</div>

<script>
function toggleSection(button) {
  var section = button.closest('.section');
  var content = section.querySelector('.section-content');
  var icon = button.querySelector('.toggle-icon');
  if (content.style.display === 'none') {
    content.style.display = 'block';
    icon.innerHTML = '\\u25BC';
    section.classList.remove('collapsed');
  } else {
    content.style.display = 'none';
    icon.innerHTML = '\\u25B6';
    section.classList.add('collapsed');
  }
}
</script>
</body>
</html>`
}

/**
 * Renders a debug page in development; in production the error is re-thrown for
 * the ExceptionHandler.
 */
export function debugErrorMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next()
    } catch (err) {
      // No optional chaining, on purpose: the deploy plugins bundle with
      // `--define 'process.env.NODE_ENV="production"'`, which substitutes that
      // one exact expression. An optional chain is a different expression, so
      // the gate becomes a runtime read that answers "not production" on hosts
      // where platform vars never reach the environment.
      const isProduction =
        typeof process !== 'undefined' && process.env.NODE_ENV === 'production'

      if (isProduction) {
        throw err
      }

      const error = err instanceof Error ? err : new Error(String(err))
      const statusCode = getStatusCode(error)
      const html = renderDebugPage(error, c.req.raw)

      return new Response(html, {
        status: statusCode,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }
  }
}

interface StackFrame {
  func: string
  file: string
  line: string
  col: string
}

/**
 * Split a `file:line:col` suffix off a location string, scanning from the
 * right so drive letters and URLs with colons stay part of the file path.
 */
function splitLocation(location: string): { file: string; line: string; col: string } | null {
  const lastColon = location.lastIndexOf(':')
  if (lastColon <= 0) return null
  const prevColon = location.lastIndexOf(':', lastColon - 1)
  if (prevColon <= 0) return null

  const line = location.slice(prevColon + 1, lastColon)
  const col = location.slice(lastColon + 1)
  if (!/^\d+$/.test(line) || !/^\d+$/.test(col)) return null

  return { file: location.slice(0, prevColon), line, col }
}

// String operations rather than `/\s+at\s+(.+?)\s+\((.+?):…/`, whose lazy
// groups backtrack polynomially over the request-derived text a stack can
// embed. The parenthesized shape is read first because its parentheses bound
// the path; only the bare shape falls back to whitespace, which truncates a
// path containing any.
function parseStackTrace(stack: string): StackFrame[] {
  const lines = stack.split('\n').slice(1)
  return lines
    .map((line): StackFrame | null => {
      const trimmed = line.trim()
      if (!/^at\s/u.test(trimmed)) return null
      const rest = trimmed.slice(2).trim()

      // Format: at functionName (file:line:col)
      if (rest.endsWith(')')) {
        const open = matchingOpenParen(rest, rest.length - 1)
        // `open === 0` leaves no room for a function name, so that frame falls
        // through to the bare shape below.
        if (open !== undefined && open > 0) {
          const location = splitLocation(rest.slice(open + 1, -1))
          if (location) {
            return { func: rest.slice(0, open).trim(), ...location }
          }
        }
      }

      // Format: at file:line:col
      const location = splitLocation(rest)
      if (location) {
        return { func: '<anonymous>', ...location }
      }
      return null
    })
    .filter((frame): frame is StackFrame => frame !== null)
}

function getStatusCode(error: Error): number {
  if ('statusCode' in error && typeof (error as Record<string, unknown>).statusCode === 'number') {
    return (error as Record<string, unknown>).statusCode as number
  }
  return 500
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderStackSection(frames: StackFrame[]): string {
  if (frames.length === 0) {
    return `
  <section class="section">
    <button class="section-toggle" onclick="toggleSection(this)">
      <span class="toggle-icon">&#9660;</span>
      <h2>Stack Trace</h2>
    </button>
    <div class="section-content">
      <p class="muted">No stack trace available.</p>
    </div>
  </section>`
  }

  const frameRows = frames
    .map((frame, index) => {
      const isVendor =
        frame.file.includes('node_modules') || frame.file.includes('bun:')
      const vendorClass = isVendor ? ' vendor' : ''

      return `
      <div class="frame${vendorClass}">
        <div class="frame-header">
          <span class="frame-index">#${index}</span>
          <span class="frame-method">${escapeHtml(frame.func)}</span>
          <span class="frame-location">${escapeHtml(frame.file)}:${frame.line}:${frame.col}</span>
        </div>
      </div>`
    })
    .join('')

  return `
  <section class="section">
    <button class="section-toggle" onclick="toggleSection(this)">
      <span class="toggle-icon">&#9660;</span>
      <h2>Stack Trace</h2>
      <span class="badge">${frames.length} frames</span>
    </button>
    <div class="section-content">
      <div class="stack-frames">
        ${frameRows}
      </div>
    </div>
  </section>`
}

function renderRequestSection(request: Request): string {
  const url = new URL(request.url)
  const headers: string[] = []

  request.headers.forEach((value, key) => {
    headers.push(
      `<tr><td class="key">${escapeHtml(key)}</td><td class="value">${escapeHtml(value)}</td></tr>`,
    )
  })

  const headersTable =
    headers.length > 0
      ? `<table class="details-table">${headers.join('\n')}</table>`
      : '<p class="muted">No headers.</p>'

  return `
  <section class="section">
    <button class="section-toggle" onclick="toggleSection(this)">
      <span class="toggle-icon">&#9660;</span>
      <h2>Request</h2>
    </button>
    <div class="section-content">
      <div class="request-summary">
        <span class="method-badge">${escapeHtml(request.method)}</span>
        <span class="request-url">${escapeHtml(url.pathname + url.search)}</span>
      </div>
      <div class="subsection">
        <h3>Headers</h3>
        ${headersTable}
      </div>
    </div>
  </section>`
}

function renderEnvironmentSection(): string {
  const nodeEnv =
    // oxlint-disable-next-line guren/no-nullish-env-default -- a blank NODE_ENV is a state this page reports, not a missing one
    typeof process !== 'undefined' ? process.env.NODE_ENV ?? 'undefined' : 'undefined'
  const bunVersion =
    typeof process !== 'undefined' ? process.versions?.bun ?? 'N/A' : 'N/A'
  const platform =
    typeof process !== 'undefined' ? process.platform ?? 'unknown' : 'unknown'

  return `
  <section class="section collapsed">
    <button class="section-toggle" onclick="toggleSection(this)">
      <span class="toggle-icon">&#9654;</span>
      <h2>Environment</h2>
    </button>
    <div class="section-content" style="display:none;">
      <table class="details-table">
        <tr><td class="key">NODE_ENV</td><td class="value">${escapeHtml(nodeEnv)}</td></tr>
        <tr><td class="key">Bun Version</td><td class="value">${escapeHtml(bunVersion)}</td></tr>
        <tr><td class="key">Platform</td><td class="value">${escapeHtml(platform)}</td></tr>
      </table>
    </div>
  </section>`
}
