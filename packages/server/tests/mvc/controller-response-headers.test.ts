import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Controller } from '../../src/mvc/Controller'
import { INERTIA_VARY } from '../../src/mvc/inertia/InertiaEngine'

class HeadersController extends Controller {
  feed(headers: HeadersInit) {
    return this.text('<rss/>', { headers })
  }

  report(headers: HeadersInit) {
    return this.json({ ok: true }, { headers })
  }

  made(headers: HeadersInit) {
    return this.created({ ok: true }, { headers })
  }

  away(headers: HeadersInit) {
    return this.redirect('/default', { headers })
  }

  page(headers: HeadersInit) {
    return this.inertia('Feed', {}, { headers })
  }
}

type Action = 'feed' | 'report' | 'made' | 'away' | 'page'

async function respond(action: Action, headers: HeadersInit, requestHeaders: HeadersInit = {}): Promise<Response> {
  const app = new Hono()
  app.get('/', (c) => {
    const controller = new HeadersController()
    controller.setContext(c)
    return controller[action](headers)
  })
  return app.request('/', { headers: requestHeaders })
}

const INERTIA_VISIT = { 'X-Inertia': 'true', Accept: 'application/json' }

function varyTokens(source: Response | string): string[] {
  const vary = typeof source === 'string' ? source : source.headers.get('vary') ?? ''
  return vary.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean)
}

const RSS = 'application/rss+xml; charset=utf-8'

const forms: Array<[string, (name: string, value: string) => HeadersInit]> = [
  ['a lowercase object key', (name, value) => ({ [name.toLowerCase()]: value })],
  ['a Headers instance', (name, value) => new Headers({ [name]: value })],
  ['a tuple list', (name, value) => [[name, value]]],
]

describe('Controller response helpers merge headers case-insensitively', () => {
  for (const [label, build] of forms) {
    test(`text() lets ${label} replace the default content type`, async () => {
      const res = await respond('feed', build('Content-Type', RSS))
      expect(res.headers.get('content-type')).toBe(RSS)
      expect(await res.text()).toBe('<rss/>')
    })

    test(`json() lets ${label} replace the default content type`, async () => {
      const res = await respond('report', build('Content-Type', 'application/vnd.api+json'))
      expect(res.headers.get('content-type')).toBe('application/vnd.api+json')
    })

    test(`created() lets ${label} replace the default content type`, async () => {
      const res = await respond('made', build('Content-Type', 'application/problem+json'))
      expect(res.status).toBe(201)
      expect(res.headers.get('content-type')).toBe('application/problem+json')
    })

    test(`redirect() lets ${label} replace the location`, async () => {
      const res = await respond('away', build('Location', '/elsewhere'))
      expect(res.headers.get('location')).toBe('/elsewhere')
    })

    test(`inertia() lets ${label} replace the engine's content type`, async () => {
      const res = await respond('page', build('Content-Type', 'application/vnd.feed+json'), INERTIA_VISIT)
      expect(res.headers.get('content-type')).toBe('application/vnd.feed+json')
      expect(res.headers.get('x-inertia')).toBe('true')
      expect(((await res.json()) as { component: string }).component).toBe('Feed')
    })

    test(`inertia() keeps one X-Inertia when ${label} sets it again`, async () => {
      const res = await respond('page', build('X-Inertia', 'true'), INERTIA_VISIT)
      expect(res.headers.get('x-inertia')).toBe('true')
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    })

    test(`inertia() keeps other headers passed as ${label}`, async () => {
      const res = await respond('page', build('Cache-Control', 'no-store'), INERTIA_VISIT)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('vary')).toBe(INERTIA_VARY)
    })

    test(`inertia() adds every engine Vary token to a Vary passed as ${label}`, async () => {
      const res = await respond('page', build('Vary', 'Cookie, accept'), INERTIA_VISIT)
      const tokens = varyTokens(res)
      expect(tokens).toContain('cookie')
      for (const token of varyTokens(INERTIA_VARY)) {
        expect(tokens).toContain(token)
      }
      expect(tokens.filter((token) => token === 'accept')).toHaveLength(1)
    })

    test(`inertia() leaves a Vary of * passed as ${label} alone`, async () => {
      const res = await respond('page', build('Vary', '*'), INERTIA_VISIT)
      expect(res.headers.get('vary')).toBe('*')
    })

    test(`text() keeps other headers passed as ${label}`, async () => {
      const res = await respond('feed', build('Cache-Control', 'no-store'))
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    })
  }

  test('inertia() extends an exact-case Vary key rather than replacing the engine tokens', async () => {
    const res = await respond('page', { Vary: 'Cookie' }, INERTIA_VISIT)
    expect(res.headers.get('vary')).toBe(`Cookie, ${INERTIA_VARY}`)
  })

  test('json() keeps its default content type when the caller sets none', async () => {
    const res = await respond('report', {})
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
  })
})
