export interface ControllerContext {
  req: {
    raw: Request
    path: string
    url: string
    method: string
    query: (key?: string) => string | undefined | Record<string, string>
    header: (name: string) => string | undefined
  }
  get: (key: string) => unknown
  set: (key: string, value: unknown) => void
  header: (name: string, value: string) => void
  status: (code: number) => void
}

export interface InertiaPayload {
  component: string
  props: Record<string, unknown>
  url: string
  version?: string
}

export function createControllerContext(
  url: string,
  init: RequestInit = {},
): ControllerContext {
  const request = new Request(url, init)
  const parsedUrl = new URL(request.url)
  const searchParams = parsedUrl.searchParams

  const req = {
    raw: request,
    path: parsedUrl.pathname,
    url: request.url,
    method: request.method,
    query: (key?: string) => {
      if (!key) {
        return Object.fromEntries(searchParams.entries())
      }

      return searchParams.get(key) ?? undefined
    },
    header: (name: string) => request.headers.get(name) ?? undefined,
  }

  return {
    req,
    get: () => undefined,
    set: () => {},
    header: () => {},
    status: () => {},
  }
}

export function createGurenControllerModule() {
  class Controller {
    public context: ControllerContext | undefined

    setContext(context: ControllerContext): void {
      this.context = context
    }

    public get ctx(): ControllerContext {
      if (!this.context) {
        throw new Error('Controller context has not been set.')
      }

      return this.context
    }

    inertia(
      component: string,
      props: Record<string, unknown>,
      options: Record<string, unknown> = {},
    ): Response {
      const ctx = this.ctx
      const request = ctx.req.raw
      const url =
        (options.url as string | undefined) ??
        ctx.req.path ??
        new URL(request.url).pathname
      const payload: InertiaPayload = {
        component,
        props,
        url,
        version: options.version as string | undefined,
      }

      const prefersJson =
        request.headers.get('X-Inertia') === 'true' ||
        (request.headers.get('Accept') ?? '').toLowerCase().includes('json')

      if (prefersJson) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Inertia': 'true',
          },
        })
      }

      const serialized = JSON.stringify(payload).replace(
        /[<>&"]/gu,
        (char): string => {
          switch (char) {
            case '<':
              return '\\u003c'
            case '>':
              return '\\u003e'
            case '&':
              return '&amp;'
            case '"':
              return '&quot;'
            default:
              return char
          }
        },
      )

      return new Response(`<div id="app" data-page="${serialized}"></div>`, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Inertia': 'true',
        },
      })
    }
  }

  return {
    Controller,
    parseRequestPayload: async () => {
      throw new Error('parseRequestPayload should not be invoked in this mock.')
    },
    formatValidationErrors: () => ({}),
  }
}

export async function readInertiaResponse(response: Response): Promise<{
  format: 'json' | 'html'
  payload: InertiaPayload
  body?: string
}> {
  const contentType = response.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    return {
      format: 'json',
      payload: (await response.json()) as InertiaPayload,
    }
  }

  const body = await response.text()
  const match = body.match(/data-page="([^"]+)"/)

  if (!match) {
    throw new Error('Unable to find Inertia payload in HTML response.')
  }

  const decoded = decodeHtml(match[1])
  const payload = JSON.parse(decoded) as InertiaPayload

  return {
    format: 'html',
    payload,
    body,
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
