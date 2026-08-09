import { beforeAll, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

// Boot the real application so tests exercise the same configuration
// (routes, providers, auth, i18n) the server runs with. The blog home page
// reads posts from the database, so exercising it here would need
// migrations and fixtures — the golden-path flow already covers it end to
// end. This starter test keeps `bun test` green out of the box; replace it
// with real feature tests as you build.
describe('app', () => {
  let http: TestApp

  beforeAll(async () => {
    await app.boot()
    http = TestApp.fromFetch((request) => app.fetch(request))
  })

  it('answers the health check', async () => {
    await http.get('/health').assertOk()
  })
})
