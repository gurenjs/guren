import { z } from 'zod'

export const runtimeErrorQuerySchema = z.object({
  sessionId: z.string().max(100).optional(), after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})
export type RuntimeErrorQuery = z.infer<typeof runtimeErrorQuerySchema>
export const runtimeErrorResultSchema = z.union([
  z.object({ schemaVersion: z.literal(1), status: z.literal('unavailable'), reason: z.string() }),
  z.object({
    schemaVersion: z.literal(1), status: z.literal('available'), sessionId: z.string(), startedAt: z.string(),
    events: z.array(z.object({
      sessionId: z.string(), sequence: z.number().int(), occurredAt: z.string(), method: z.string(),
      route: z.object({ method: z.string(), pattern: z.string(), name: z.string().optional() }).optional(),
      correlation: z.enum(['matched', 'ambiguous', 'unavailable']), status: z.number().int(), category: z.literal('server-error'),
      frames: z.array(z.object({ file: z.string(), line: z.number().optional(), column: z.number().optional() })),
    })).max(100),
    nextCursor: z.object({ sessionId: z.string(), after: z.number().int() }), dropped: z.number().int(), cursorExpired: z.boolean(),
  }),
])
export type RuntimeErrorResult = z.infer<typeof runtimeErrorResultSchema>
export type RuntimeErrorReader = (query: RuntimeErrorQuery) => unknown
export const unavailableRuntimeErrors = (reason: string): RuntimeErrorResult => ({ schemaVersion: 1, status: 'unavailable', reason })

export function runtimeOrigin(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !(url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Expected an HTTP loopback origin without credentials, path, query or fragment.')
  return url
}

export async function fetchRuntimeErrors(origin: string, query: RuntimeErrorQuery = {}): Promise<RuntimeErrorResult> {
  const base = runtimeOrigin(origin)
  const parsed = runtimeErrorQuerySchema.parse(query)
  const url = new URL('/_guren/runtime/errors', base)
  for (const [key, value] of Object.entries(parsed)) if (value !== undefined) url.searchParams.set(key, String(value))
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (!response.ok) { await response.body?.cancel(); return unavailableRuntimeErrors(`Runtime endpoint returned HTTP ${response.status}.`) }
    const reader = response.body?.getReader()
    if (!reader) return unavailableRuntimeErrors('Runtime endpoint returned no body.')
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 1024 * 1024) { await reader.cancel(); return unavailableRuntimeErrors('Runtime response exceeded its output limit.') }
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return runtimeErrorResultSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
  } catch { return unavailableRuntimeErrors('Runtime endpoint is offline, unsupported or returned invalid data.') }
}
