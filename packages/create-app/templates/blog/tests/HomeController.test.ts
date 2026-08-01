import { describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import { registerWebRoutes } from '../routes/web.js'

// The blog home page reads posts from the database, so exercising it here
// would need migrations and fixtures — the golden-path flow already covers
// it end to end. This starter test keeps `bun test` green out of the box;
// replace it with real feature tests as you build.
describe('app', () => {
  it('answers the health check', async () => {
    const app = await TestApp.create({
      routes: registerWebRoutes,
      providers: [DatabaseProvider],
    })

    await app.get('/health').assertOk()
  })
})
