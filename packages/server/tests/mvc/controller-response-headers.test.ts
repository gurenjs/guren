import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Controller } from '../../src/mvc/Controller'

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
}

type Action = 'feed' | 'report' | 'made' | 'away'

async function respond(action: Action, headers: HeadersInit): Promise<Response> {
  const app = new Hono()
  app.get('/', (c) => {
    const controller = new HeadersController()
    controller.setContext(c)
    return controller[action](headers)
  })
  return app.request('/')
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

    test(`text() keeps other headers passed as ${label}`, async () => {
      const res = await respond('feed', build('Cache-Control', 'no-store'))
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    })
  }

  test('json() keeps its default content type when the caller sets none', async () => {
    const res = await respond('report', {})
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
  })
})
