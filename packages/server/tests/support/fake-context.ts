import type { Context } from 'hono'

/** Minimal Map-backed Hono context double: header lookup plus get/set storage. */
export function fakeContext(
  options: { headers?: Record<string, string>; values?: Record<string, unknown>; raw?: Request } = {},
): Context {
  const { headers = {}, values = {}, raw = new Request('http://localhost/') } = options
  const store = new Map<string, unknown>(Object.entries(values))
  return {
    req: {
      raw,
      url: raw.url,
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
    },
    set: (key: string, value: unknown) => {
      store.set(key, value)
    },
    get: (key: string) => store.get(key),
  } as unknown as Context
}
