import { describe, expect, test } from 'bun:test'

import { examine, pageComponent, type DoctorIo } from '../src/browser-doctor'
import type { BrowserFeature, BrowserMap } from '../src/browser-map'
import type { RuntimeErrorQuery, RuntimeErrorResult } from '../src/runtime-errors'

const ORIGIN = 'http://127.0.0.1:4317'

function feature(name: string, path: string, page: string, extra: Partial<BrowserFeature> = {}): BrowserFeature {
  const route = { method: 'GET', path, name: `${name}.index`, middleware: [], pages: [page] }
  return { name, file: `docs/browser/${name}.md`, pages: [page], routes: [route], landmark: route, entities: [], acceptance: [], views: [], ...extra }
}

function map(features: BrowserFeature[], complete = true): BrowserMap {
  return {
    complete, gaps: complete ? [] : [{ section: 'handles', reasons: ['partial'] }], features,
    unreached: [], unassigned: [], unresolvedRenders: [], unplaced: [], plans: [], unreadablePlans: [],
  }
}

function page(component: string): Response {
  return new Response(`<html><script>document.querySelector('script[data-page="app"][type="application/json"]')</script><script data-page="app" type="application/json">${JSON.stringify({ component, props: {} })}</script></html>`, { status: 200 })
}

type Event = Extract<RuntimeErrorResult, { status: 'available' }>['events'][number]

function event(sequence: number, pattern: string, sessionId = 's1'): Event {
  return { sessionId, sequence, occurredAt: '2026-10-16T00:00:00.000Z', method: 'GET', route: { method: 'GET', pattern }, correlation: 'matched', status: 500, category: 'server-error', frames: [] }
}

/** A collector whose events the requests themselves add, read with the server's cursor rules. */
function io(responses: Record<string, () => Response>, options: { onRequest?: Record<string, Event>; sessionAfter?: string; droppedAfter?: number; unavailable?: boolean } = {}): DoctorIo {
  const events: Event[] = [event(1, '/old')]
  let requested = false
  return {
    async fetch(url) {
      requested = true
      const path = new URL(url).pathname
      const added = options.onRequest?.[path]
      if (added) events.push(added)
      const respond = responses[path]
      if (!respond) throw new Error('Unable to connect.')
      return respond()
    },
    async readErrors(_origin, query: RuntimeErrorQuery) {
      if (options.unavailable) return { schemaVersion: 1, status: 'unavailable', reason: 'offline' }
      const sessionId = requested && options.sessionAfter ? options.sessionAfter : 's1'
      const visible = events.filter((entry) => entry.sessionId === sessionId)
      const different = query.sessionId !== undefined && query.sessionId !== sessionId
      const after = different ? 0 : query.after ?? 0
      const page = visible.filter((entry) => entry.sequence > after).slice(0, query.limit ?? 20)
      const head = visible.at(-1)?.sequence ?? 0
      return {
        schemaVersion: 1, status: 'available', sessionId, startedAt: '2026-10-16T00:00:00.000Z', events: page,
        nextCursor: { sessionId, after: page.at(-1)?.sequence ?? head },
        dropped: requested ? options.droppedAfter ?? 0 : 0, cursorExpired: different,
      }
    },
  }
}

describe('pageComponent', () => {
  test('reads the script element, not the shim that names it', () => {
    const html = `<script>document.querySelector('script[data-page="app"][type="application/json"]')</script><script data-page="app" type="application/json">{"component":"posts/Index"}</script>`
    expect(pageComponent(html)).toBe('posts/Index')
  })

  test('reads a legacy data-page attribute and nothing from a page without one', () => {
    expect(pageComponent('<div id="app" data-page="{&quot;component&quot;:&quot;Home&quot;}"></div>')).toBe('Home')
    expect(pageComponent('<html><body>plain</body></html>')).toBeUndefined()
  })

  test('reads a payload whose text changes length when lowercased, and an SSR payload escaping slashes', () => {
    const turkish = `<title>\u0130stanbul</title><script data-page="app" type="application/json">{"component":"posts/Index","props":{"city":"\u0130stanbul"}}</script>`
    expect(pageComponent(turkish)).toBe('posts/Index')
    expect(pageComponent('<script data-page="app" type="application/json">{"component":"posts\\/Index"}</script>')).toBe('posts/Index')
  })
})

describe('examine', () => {
  test('passes when every landmark renders its page and no error lands', async () => {
    const report = await examine(map([feature('posts', '/posts', 'posts/Index')]), ORIGIN, io({ '/posts': () => page('posts/Index') }))
    expect(report.result).toBe('pass')
    expect(report.window.status).toBe('conclusive')
    expect(report.features[0]!.status).toBe('pass')
  })

  test('fails a feature whose route recorded a server error, even when the landmark answered 200', async () => {
    const report = await examine(
      map([feature('posts', '/posts', 'posts/Index')]), ORIGIN,
      io({ '/posts': () => page('posts/Index') }, { onRequest: { '/posts': event(2, '/posts') } }),
    )
    expect(report.result).toBe('fail')
    expect(report.features[0]!.events.map((entry) => entry.sequence)).toEqual([2])
  })

  test('fails the run on an error no mapped route accounts for, and ignores errors from before the run', async () => {
    const report = await examine(
      map([feature('posts', '/posts', 'posts/Index')]), ORIGIN,
      io({ '/posts': () => page('posts/Index') }, { onRequest: { '/posts': event(2, '/elsewhere') } }),
    )
    expect(report.result).toBe('fail')
    expect(report.uncorrelated.map((entry) => entry.sequence)).toEqual([2])
    expect(report.features[0]!.status).toBe('pass')
  })

  test('fails a landmark that renders another page or answers with an error status', async () => {
    const report = await examine(
      map([feature('posts', '/posts', 'posts/Index'), feature('admin', '/admin', 'admin/Index')]), ORIGIN,
      io({ '/posts': () => page('Error'), '/admin': () => new Response('boom', { status: 500 }) }),
    )
    expect(report.features.map((check) => [check.feature, check.status, check.reason])).toEqual([
      ['posts', 'fail', 'Rendered Error, where the graph says posts/Index.'],
      ['admin', 'fail', 'HTTP 500.'],
    ])
  })

  test('reports a sign-in redirect on a route requiring a user, and never passes over it', async () => {
    const dashboard = feature('dashboard', '/dashboard', 'dashboard/Index')
    const guarded = { ...dashboard.landmark!, authentication: 'required' as const }
    const report = await examine(
      map([feature('posts', '/posts', 'posts/Index'), { ...dashboard, routes: [guarded], landmark: guarded }]), ORIGIN,
      io({ '/posts': () => page('posts/Index'), '/dashboard': () => new Response(null, { status: 302, headers: { location: '/login' } }) }),
    )
    expect(report.features[1]).toMatchObject({ status: 'auth-required', location: '/login' })
    expect(report.result).toBe('inconclusive')
  })

  test('fails a redirect on a route that requires no signed-in user', async () => {
    const report = await examine(
      map([feature('posts', '/posts', 'posts/Index'), feature('about', '/about', 'About')]), ORIGIN,
      io({ '/posts': () => page('posts/Index'), '/about': () => new Response(null, { status: 302, headers: { location: '/' } }) }),
    )
    expect(report.features[1]).toMatchObject({ status: 'fail', reason: 'Redirected to /, though its middleware requires no signed-in user.' })
    expect(report.result).toBe('fail')
  })

  test('fails a landmark whose body cannot be read, keeping the report', async () => {
    const broken = () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('reset')) } }), { status: 200 })
    const report = await examine(map([feature('posts', '/posts', 'posts/Index')]), ORIGIN, io({ '/posts': broken }))
    expect(report.features[0]).toMatchObject({ status: 'fail' })
    expect(report.features[0]!.reason).toContain('The body could not be read')
  })

  test('never reads an unavailable collector, a restarted app or dropped errors as zero errors', async () => {
    const routes = { '/posts': () => page('posts/Index') }
    const features = map([feature('posts', '/posts', 'posts/Index')])
    expect((await examine(features, ORIGIN, io(routes, { unavailable: true }))).window.status).toBe('unavailable')
    const restarted = await examine(features, ORIGIN, io(routes, { sessionAfter: 's2' }))
    expect(restarted.window.status).toBe('inconclusive')
    expect(restarted.result).toBe('inconclusive')
    expect((await examine(features, ORIGIN, io(routes, { droppedAfter: 1 }))).window.status).toBe('inconclusive')
  })

  test('is inconclusive on an incomplete map however the landmarks did', async () => {
    const report = await examine(map([feature('posts', '/posts', 'posts/Index')], false), ORIGIN, io({ '/posts': () => page('posts/Index') }))
    expect(report.result).toBe('inconclusive')
    expect(report.reasons[0]).toContain('The map is incomplete (handles)')
  })

  test('skips a feature whose every route takes a parameter', async () => {
    const posts = feature('posts', '/posts/:id', 'posts/Show')
    const report = await examine(map([{ ...posts, landmark: undefined }]), ORIGIN, io({}))
    expect(report.features[0]!.status).toBe('skipped')
  })
})
