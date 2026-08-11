import { beforeAll, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

// Boots the real src/app.ts so tests share its configuration. The blog
// home page reads posts from the database, so exercising it here would
// need migrations and fixtures — the golden-path flow already covers it
// end to end. This starter test keeps `bun test` green out of the box;
// replace it with real feature tests as you build.
describe('app', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  it('answers the health check', async () => {
    await http.get('/health').assertOk()
  })
})
