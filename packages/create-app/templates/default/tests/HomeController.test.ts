import { describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import { registerWebRoutes } from '../routes/web.js'

describe('app', () => {
  it('serves the home page', async () => {
    const app = await TestApp.create({
      routes: registerWebRoutes,
      providers: [DatabaseProvider],
    })

    await app.get('/').assertOk()
  })

  it('answers the health check', async () => {
    const app = await TestApp.create({
      routes: registerWebRoutes,
      providers: [DatabaseProvider],
    })

    await app.get('/health').assertOk()
  })
})
