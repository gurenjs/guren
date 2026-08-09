import { beforeAll, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

// Boot the real application so tests exercise the same configuration
// (routes, providers, i18n, security defaults) the server runs with.
describe('app', () => {
  let http: TestApp

  beforeAll(async () => {
    await app.boot()
    http = TestApp.fromFetch((request) => app.fetch(request))
  })

  it('serves the home page', async () => {
    const response = await http.get('/')
    response.assertOk()
    // The message comes from lang/en/messages.json via this.t() — this
    // catches a broken catalog or interpolation, not just a 200.
    await response.assertBodyContains('Welcome to')
  })

  it('answers the health check', async () => {
    await http.get('/health').assertOk()
  })
})
