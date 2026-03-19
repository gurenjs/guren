const HTML_ENTITIES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '&amp;',
  '"': '&quot;',
}

const HTML_DECODE_ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
}

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
      const status = (options.status as number | undefined) ?? 200
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
          status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Inertia': 'true',
          },
        })
      }

      const serialized = JSON.stringify(payload).replace(
        /[<>&"]/gu,
        (char) => HTML_ENTITIES[char] ?? char,
      )

      return new Response(`<div id="app" data-page="${serialized}"></div>`, {
        status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Inertia': 'true',
        },
      })
    }
  }

  return {
    Controller,
    parseRequestPayload: async (ctx: ControllerContext) => {
      const request = ctx.req.raw
      const contentType = request.headers.get('Content-Type') ?? ''

      if (contentType.includes('application/json')) {
        return request.json()
      }

      if (contentType.includes('application/x-www-form-urlencoded')) {
        const text = await request.text()
        return Object.fromEntries(new URLSearchParams(text))
      }

      if (contentType.includes('multipart/form-data')) {
        const formData = await request.formData()
        const result: Record<string, unknown> = {}
        formData.forEach((value, key) => {
          result[key] = value
        })
        return result
      }

      return {}
    },
    formatValidationErrors: (error: { issues?: Array<{ path: (string | number)[]; message: string }> }) => {
      const errors: Record<string, string> = {}
      if (error?.issues) {
        for (const issue of error.issues) {
          const key = issue.path.join('.')
          if (!errors[key]) {
            errors[key] = issue.message
          }
        }
      }
      return errors
    },
  }
}

export function createControllerModuleMock() {
  const module = createGurenControllerModule()

  class TestController extends module.Controller {
    public get request(): ControllerContext['req'] {
      return this.ctx.req
    }

    public json(data: unknown, init: ResponseInit = {}): Response {
      return new Response(JSON.stringify(data), {
        ...init,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(init.headers ?? {}),
        },
      })
    }

    public redirect(url: string, options: { status?: number } = {}): Response {
      const defaultStatus = this.ctx.req.method !== 'GET' ? 303 : 302
      const status = options.status ?? defaultStatus

      return new Response(null, {
        status,
        headers: {
          Location: url,
        },
      })
    }
  }

  class Event {}
  class Listener {}
  class Job {}
  class AuthenticatableModel {
    static table: unknown = null
    static recordType: unknown = {}
    static relationTypes: unknown = {}

    static async find(): Promise<unknown> {
      return null
    }

    static async where(): Promise<unknown[]> {
      return []
    }

    static async update(): Promise<void> {}
  }
  class Resource<T = Record<string, unknown>> {
    public resource: T
    public additionalData: Record<string, unknown> = {}

    constructor(resource: T) {
      this.resource = resource
    }

    toArray(): Record<string, unknown> {
      return { ...(this.resource as Record<string, unknown>) }
    }

    toJSON(): Record<string, unknown> {
      return {
        ...this.toArray(),
        ...this.additionalData,
      }
    }

    additional(data: Record<string, unknown>): this {
      this.additionalData = { ...this.additionalData, ...data }
      return this
    }

    when<V>(condition: boolean, value: V | (() => V)): V | undefined {
      if (!condition) {
        return undefined
      }
      return typeof value === 'function' ? (value as () => V)() : value
    }

    whenLoaded<V>(relation: string, value: V | (() => V), defaultValue?: V): V | undefined {
      const resource = this.resource as Record<string, unknown>
      const isLoaded = relation in resource && resource[relation] !== undefined

      if (!isLoaded) {
        return defaultValue
      }

      return typeof value === 'function' ? (value as () => V)() : value
    }

    static make<TResource, R extends Resource<TResource>>(
      this: new (resource: TResource) => R,
      resource: TResource,
    ): R {
      return new this(resource)
    }

    static collection<TResource, R extends Resource<TResource>>(
      this: new (resource: TResource) => R,
      resources: TResource[],
    ): Record<string, unknown>[] {
      return resources.map((resource) => new this(resource).toJSON())
    }
  }

  class JsonResource<T extends Record<string, unknown>> extends Resource<T> {
    toArray(): Record<string, unknown> {
      return { ...this.resource }
    }
  }

  const collect = <TResource, R extends Resource<TResource>>(
    resources: TResource[],
    resourceClass: new (resource: TResource) => R,
  ): Record<string, unknown>[] => {
    return resources.map((resource) => new resourceClass(resource).toJSON())
  }
  class MemoryApiTokenStore {
    clear(): void {}
  }

  const createApiToken = async (
    _store: unknown,
    options: { name: string; userId: number | string; abilities: string[]; expiresIn?: number | null },
  ): Promise<{
    plainTextToken: string
    token: {
      id: string
      name: string
      userId: number | string
      abilities: string[]
      createdAt: Date
      lastUsedAt: Date | null
      expiresAt: Date | null
    }
  }> => {
    const expiresAt =
      typeof options.expiresIn === 'number' ? new Date(Date.now() + options.expiresIn) : null

    return {
      plainTextToken: 'test-token',
      token: {
        id: 'token-id',
        name: options.name,
        userId: options.userId,
        abilities: options.abilities,
        createdAt: new Date(),
        lastUsedAt: null,
        expiresAt,
      },
    }
  }

  const revokeApiToken = async (): Promise<void> => {}

  const getUserApiTokens = async (): Promise<
    Array<{
      id: string
      name: string
      abilities: string[]
      createdAt: Date
      lastUsedAt: Date | null
      expiresAt: Date | null
    }>
  > => {
    return []
  }

  const getApiToken = (): { userId: number | string; abilities: string[] } | null => {
    return null
  }
  const createEventManager = () => ({
    on: () => {},
    emit: async () => {},
  })
  const createMailManager = () => ({})
  const setMailManager = () => {}
  const setQueueDriver = () => {}
  const registerJob = () => {}
  class MemoryDriver {}
  const createCacheManager = () => ({
    store: () => ({
      remember: async (_key: string, _ttl: number, callback: () => Promise<unknown>) => callback(),
      delete: async () => {},
      clear: async () => {},
    }),
  })

  return {
    ...module,
    Controller: TestController,
    Event,
    Listener,
    Job,
    AuthenticatableModel,
    Resource,
    JsonResource,
    collect,
    MemoryApiTokenStore,
    createApiToken,
    revokeApiToken,
    getUserApiTokens,
    getApiToken,
    createEventManager,
    createMailManager,
    setMailManager,
    setQueueDriver,
    registerJob,
    MemoryDriver,
    createCacheManager,
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
  return value.replace(/&(?:quot|amp|lt|gt);/g, (entity) => HTML_DECODE_ENTITIES[entity] ?? entity)
}
