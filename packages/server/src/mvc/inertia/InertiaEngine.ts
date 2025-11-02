export interface InertiaOptions {
  readonly url?: string
  readonly version?: string
  readonly status?: number
  readonly headers?: HeadersInit
  readonly request?: Request
  readonly title?: string
  readonly entry?: string
  readonly importMap?: Record<string, string>
  readonly styles?: string[]
}

export interface InertiaPagePayload {
  component: string
  props: Record<string, unknown>
  url: string
  version?: string
}

const DEFAULT_TITLE = 'Guren'
const DEFAULT_IMPORT_MAP: Record<string, string> = {
  react: 'https://esm.sh/react@19.0.0?dev',
  'react/jsx-runtime': 'https://esm.sh/react@19.0.0/jsx-runtime?dev',
  'react/jsx-dev-runtime': 'https://esm.sh/react@19.0.0/jsx-dev-runtime?dev',
  'react-dom/client': 'https://esm.sh/react-dom@19.0.0/client?dev',
  '@inertiajs/react': 'https://esm.sh/@inertiajs/react@2.2.15?dev&external=react,react-dom/client',
  '@guren/inertia-client': '/vendor/inertia-client.tsx',
}

export function inertia(component: string, props: Record<string, unknown>, options: InertiaOptions = {}): Response {
  const page: InertiaPagePayload = {
    component,
    props,
    url: options.url ?? '',
    version: options.version,
  }

  const request = options.request
  const isInertiaVisit = Boolean(request?.headers.get('X-Inertia'))
  const prefersJson = request ? acceptsJson(request) : false

  if (isInertiaVisit || prefersJson) {
    return new Response(serializePage(page), {
      status: options.status ?? 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Inertia': 'true',
        'Vary': 'Accept',
        ...(options.version ? { 'X-Inertia-Version': options.version } : {}),
        ...options.headers,
      },
    })
  }

  const html = renderDocument(page, options)

  return new Response(html, {
    status: options.status ?? 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Inertia': 'true',
      'Vary': 'Accept',
      ...(options.version ? { 'X-Inertia-Version': options.version } : {}),
      ...options.headers,
    },
  })
}

function renderDocument(page: InertiaPagePayload, options: InertiaOptions): string {
  const defaultEntry = process.env.GUREN_INERTIA_ENTRY ?? '/resources/js/app.tsx'
  const entry = options.entry ?? defaultEntry
  const title = escapeHtml(options.title ?? DEFAULT_TITLE)
  const styles = options.styles ?? parseStylesEnv(process.env.GUREN_INERTIA_STYLES)
  const importMap = JSON.stringify(
    {
      imports: {
        ...DEFAULT_IMPORT_MAP,
        ...(options.importMap ?? {}),
      },
    },
    null,
    2,
  )
  const serializedPage = serializePage(page)
  const stylesheetLinks = renderStyles(styles)

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    ${stylesheetLinks}
    <script type="importmap">${importMap}</script>
    <script>window.__INERTIA_PAGE__ = ${serializedPage};</script>
  </head>
  <body>
    <div id="app" data-page="${escapeAttribute(serializedPage)}"></div>
    <script type="module" src="${entry}"></script>
  </body>
</html>`
}

function renderStyles(styles: string[]): string {
  if (!styles.length) {
    return ''
  }

  return styles
    .map((href) => `<link rel="stylesheet" href="${escapeAttribute(href)}" />`)
    .join('\n    ')
}

function serializePage(page: InertiaPagePayload): string {
  return JSON.stringify(page).replace(/[<\u2028\u2029]/gu, (char) => {
    switch (char) {
      case '<':
        return '\\u003c'
      case '\u2028':
        return '\\u2028'
      case '\u2029':
        return '\\u2029'
      default:
        return char
    }
  })
}

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get('accept')?.toLowerCase() ?? ''

  if (!accept || accept === '*/*') {
    return false
  }

  if (accept.includes('text/html')) {
    return false
  }

  return accept.includes('application/json') || accept.includes('json')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => {
    switch (char) {
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
        return char
    }
  })
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"]/gu, (char) => {
    if (char === '&') {
      return '&amp;'
    }

    return '&quot;'
  })
}

function parseStylesEnv(value: string | undefined): string[] {
  if (!value) {
    return []
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}
