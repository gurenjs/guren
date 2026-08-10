import { beforeAll, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

// Boots the real src/app.ts so tests share its configuration.
describe('app', () => {
  let http: TestApp

  beforeAll(async () => {
    await app.boot()
    http = TestApp.fromFetch((request) => app.fetch(request))
  })

  it('serves the translated home page', async () => {
    const response = await http.get('/').assertOk()
    await response.assertBodyContains('Welcome to')
  })

  it('answers the health check', async () => {
    await http.get('/health').assertOk()
  })
})
