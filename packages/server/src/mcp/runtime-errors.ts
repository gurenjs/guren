import { realpathSync, statSync } from 'node:fs'
import { routePath } from 'hono/route'
import type { Context } from 'hono'

import { isMcpEndpointEnabled } from './endpoint'
import { tryGetRequestContainer } from '../http/request-container'
import type { Router } from '../mvc/Router'

export const RUNTIME_ERRORS_BINDING = 'dev.runtimeErrors'
export const RUNTIME_ERRORS_PATH = '/_guren/runtime/errors'
export interface RuntimeErrorQuery { sessionId?: string; after?: number; limit?: number }
export interface RuntimeErrorEvent {
  sessionId: string
  sequence: number
  occurredAt: string
  method: string
  route?: { method: string; pattern: string; name?: string }
  correlation: 'matched' | 'ambiguous' | 'unavailable'
  status: number
  category: 'server-error'
  frames: Array<{ file: string; line?: number; column?: number }>
}
export interface RuntimeErrorResult {
  schemaVersion: 1
  status: 'available'
  sessionId: string
  startedAt: string
  events: RuntimeErrorEvent[]
  nextCursor: { sessionId: string; after: number }
  dropped: number
  cursorExpired: boolean
}

export class RuntimeErrorBuffer {
  private sessionId = crypto.randomUUID()
  private startedAt: string
  private sequence = 0
  private dropped = 0
  private bytes = 0
  private events: Array<{ event: RuntimeErrorEvent; at: number; bytes: number }> = []

  constructor(private readonly root: string, private readonly now: () => number = Date.now) {
    this.startedAt = new Date(now()).toISOString()
  }

  reset(): void {
    this.sessionId = crypto.randomUUID()
    this.startedAt = new Date(this.now()).toISOString()
    this.sequence = this.dropped = this.bytes = 0
    this.events = []
  }

  record(error: Error, detail: Pick<RuntimeErrorEvent, 'method' | 'route' | 'correlation' | 'status'>): void {
    const at = this.now()
    this.expire(at)
    const event: RuntimeErrorEvent = {
      sessionId: this.sessionId, sequence: ++this.sequence, occurredAt: new Date(at).toISOString(),
      method: /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE|QUERY)$/.test(detail.method) ? detail.method : 'UNKNOWN',
      ...(detail.route ? { route: detail.route } : {}), correlation: detail.correlation,
      status: detail.status, category: 'server-error', frames: this.frames(error.stack),
    }
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length
    if (bytes > 8 * 1024) { this.dropped++; return }
    this.events.push({ event, at, bytes })
    this.bytes += bytes
    while (this.events.length > 100 || this.bytes > 256 * 1024) this.evict()
  }

  read(query: RuntimeErrorQuery = {}): RuntimeErrorResult {
    const after = query.after ?? 0
    const limit = query.limit ?? 20
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || (query.sessionId !== undefined && typeof query.sessionId !== 'string')) throw new Error('Invalid runtime error cursor or limit.')
    this.expire(this.now())
    const different = query.sessionId !== undefined && query.sessionId !== this.sessionId
    const start = different ? 0 : after
    const events = this.events.filter(({ event }) => event.sequence > start).slice(0, limit).map(({ event }) => structuredClone(event))
    const earliest = this.events[0]?.event.sequence ?? this.sequence + 1
    return {
      schemaVersion: 1, status: 'available', sessionId: this.sessionId, startedAt: this.startedAt, events,
      nextCursor: { sessionId: this.sessionId, after: events.at(-1)?.sequence ?? this.sequence },
      dropped: this.dropped, cursorExpired: different || start < earliest - 1 || start > this.sequence,
    }
  }

  private evict(): void {
    const removed = this.events.shift()
    if (removed) { this.bytes -= removed.bytes; this.dropped++ }
  }

  private expire(at: number): void {
    while (this.events[0] && at - this.events[0].at >= 15 * 60_000) this.evict()
  }

  private frames(stack: string | undefined): RuntimeErrorEvent['frames'] {
    const root = this.root.replace(/\\/g, '/').replace(/\/$/, '') + '/'
    const frames: RuntimeErrorEvent['frames'] = []
    let actualRoot: string
    try { actualRoot = realpathSync(this.root).replace(/\\/g, '/').replace(/\/$/, '') + '/' } catch { return frames }
    for (const line of (stack ?? '').slice(0, 32 * 1024).split('\n').slice(1, 41)) {
      const match = line.match(/(?:\(|\s)((?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])[^\n]*):([0-9]+):([0-9]+)\)?$/)
      if (!match) continue
      const path = match[1]!.replace(/^file:\/\//, '').replace(/\\/g, '/')
      if (!path.startsWith(root)) continue
      const file = path.slice(root.length)
      if (!/^[\w./@ -]+\.(?:[cm]?[jt]sx?)$/.test(file) || file.split('/').some((part) => part === '..' || part === 'node_modules' || part.startsWith('.'))) continue
      try {
        const actual = realpathSync(path).replace(/\\/g, '/')
        if (!actual.startsWith(actualRoot) || !statSync(actual).isFile()) continue
      } catch { continue }
      frames.push({ file, line: Number(match[2]), column: Number(match[3]) })
      if (frames.length === 10) break
    }
    return frames
  }
}

/** Only ExceptionHandler calls this, after applying its dontReport policy. */
export function captureRuntimeError(error: Error, ctx: Context, status: number): void {
  if (!isMcpEndpointEnabled() || status < 500 || status > 599 || !Number.isInteger(status)) return
  try {
    const container = tryGetRequestContainer(ctx)
    const buffer = container?.makeOptional<RuntimeErrorBuffer>(RUNTIME_ERRORS_BINDING)
    if (!buffer) return
    const pattern = routePath(ctx)
    const definitions = container?.makeOptional<Router>('router')?.definitions() ?? []
    const matches = definitions.filter((entry) => entry.path === pattern && (entry.method === ctx.req.method || entry.method === 'ALL'))
    const route = matches.length === 1 ? matches[0] : undefined
    buffer.record(error, {
      method: ctx.req.method, status, correlation: matches.length === 1 ? 'matched' : matches.length > 1 ? 'ambiguous' : 'unavailable',
      ...(route ? { route: { method: route.method, pattern: route.path, ...(route.name ? { name: route.name } : {}) } } : {}),
    })
  } catch {
    // Development instrumentation must never replace the application exception.
  }
}
