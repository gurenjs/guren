import type { Context } from 'hono'

/** Minimal Map-backed Hono context double: header lookup plus get/set storage. */
export function fakeContext(
  options: { headers?: Record<string, string>; values?: Record<string, unknown> } = {},
): Context {
  const { headers = {}, values = {} } = options
  const store = new Map<string, unknown>(Object.entries(values))
  return {
    req: {
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
    },
    set: (key: string, value: unknown) => {
      store.set(key, value)
    },
    get: (key: string) => store.get(key),
  } as unknown as Context
}
