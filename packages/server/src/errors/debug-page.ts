import type { MiddlewareHandler } from 'hono'

/**
 * Render a rich HTML debug error page for development mode.
 *
 * When an error occurs and NODE_ENV is not 'production', this function
 * generates a helpful page displaying the error class, message, stack trace
 * with source context, and request details.
 */
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
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: #0f0f13; color: #e0e0e8; line-height: 1.6; min-height: 100vh; }
  code, .mono { font-family: ui-monospace, "SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace; }
  .container { max-width: 960px; margin: 0 auto; padding: 2rem 1.5rem; }

  .error-header { display: flex; align-items: flex-start; gap: 1.5rem; margin-bottom: 2rem; padding: 2rem; background: #1a1a24; border: 1px solid #2a2a3a; border-radius: 12px; border-left: 4px solid #ef4444; }
  .status-badge { flex-shrink: 0; display: flex; align-items: center; justify-content: center; width: 64px; height: 64px; background: #2d1b1b; color: #ef4444; font-size: 1.25rem; font-weight: 700; border-radius: 12px; }
  .error-info { min-width: 0; }
  .error-class { font-size: 1.5rem; font-weight: 700; color: #ef4444; margin-bottom: 0.25rem; word-break: break-word; }
  .error-message { font-size: 1.1rem; color: #c0c0cc; word-break: break-word; }

  .section { margin-bottom: 1rem; background: #1a1a24; border: 1px solid #2a2a3a; border-radius: 8px; overflow: hidden; }
  .section-toggle { display: flex; align-items: center; gap: 0.75rem; width: 100%; padding: 1rem 1.25rem; background: none; border: none; cursor: pointer; color: #e0e0e8; text-align: left; font-family: inherit; }
  .section-toggle:hover { background: #22222e; }
  .section-toggle h2 { font-size: 1rem; font-weight: 600; }
  .toggle-icon { font-size: 0.7rem; color: #888; flex-shrink: 0; width: 1rem; text-align: center; }
  .badge { font-size: 0.75rem; color: #888; background: #2a2a3a; padding: 0.15rem 0.5rem; border-radius: 999px; margin-left: auto; }
  .section-content { padding: 0 1.25rem 1.25rem; }

  .stack-frames { display: flex; flex-direction: column; gap: 2px; }
  .frame { padding: 0.6rem 0.75rem; border-radius: 6px; cursor: default; transition: background 0.15s; }
  .frame:hover { background: #22222e; }
  .frame.vendor { opacity: 0.45; }
  .frame.vendor:hover { opacity: 0.7; }
  .frame-header { display: flex; align-items: center; gap: 0.75rem; font-size: 0.875rem; }
  .frame-index { color: #555; font-size: 0.75rem; min-width: 2rem; flex-shrink: 0; }
  .frame-method { color: #a78bfa; font-family: ui-monospace, "SF Mono", "Fira Code", Menlo, Consolas, monospace; font-weight: 500; }
  .frame-location { color: #888; font-family: ui-monospace, "SF Mono", "Fira Code", Menlo, Consolas, monospace; font-size: 0.8rem; margin-left: auto; text-align: right; word-break: break-all; }

  .request-summary { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; }
  .method-badge { display: inline-block; padding: 0.2rem 0.6rem; background: #2d1b4e; color: #a78bfa; font-size: 0.8rem; font-weight: 700; border-radius: 4px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .request-url { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.9rem; word-break: break-all; }

  .subsection { margin-top: 1rem; }
  .subsection h3 { font-size: 0.85rem; font-weight: 600; color: #888; margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; }

  .details-table { width: 100%; border-collapse: collapse; }
  .details-table tr { border-bottom: 1px solid #22222e; }
  .details-table tr:last-child { border-bottom: none; }
  .details-table td { padding: 0.4rem 0; font-size: 0.85rem; vertical-align: top; }
  .details-table td.key { color: #a78bfa; font-weight: 500; width: 200px; padding-right: 1rem; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.8rem; }
  .details-table td.value { color: #c0c0cc; word-break: break-all; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.8rem; }

  .muted { color: #555; font-style: italic; }
  .footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #2a2a3a; text-align: center; color: #555; font-size: 0.8rem; }
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
 * Middleware that catches errors and renders a debug page in development.
 * In production (NODE_ENV === 'production'), errors are re-thrown so
 * downstream handlers or the ExceptionHandler can process them normally.
 *
 * @example
 * ```typescript
 * import { debugErrorMiddleware } from '@guren/server/errors/debug-page'
 *
 * app.use('*', debugErrorMiddleware())
 * ```
 */
export function debugErrorMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next()
    } catch (err) {
      const isProduction =
        typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'

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

// --- Internal helpers ---

interface StackFrame {
  func: string
  file: string
  line: string
  col: string
}

function parseStackTrace(stack: string): StackFrame[] {
  const lines = stack.split('\n').slice(1)
  return lines
    .map((line) => {
      // Match: at functionName (file:line:col)
      const match = line.match(/\s+at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/)
      if (match) {
        return { func: match[1], file: match[2], line: match[3], col: match[4] }
      }
      // Match: at file:line:col
      const match2 = line.match(/\s+at\s+(.+?):(\d+):(\d+)/)
      if (match2) {
        return { func: '<anonymous>', file: match2[1], line: match2[2], col: match2[3] }
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
    typeof process !== 'undefined' ? process.env?.NODE_ENV ?? 'undefined' : 'undefined'
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
