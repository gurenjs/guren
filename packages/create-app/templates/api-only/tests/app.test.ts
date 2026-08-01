import { describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import { registerApiRoutes } from '../routes/api.js'

describe('api', () => {
  it('answers the health check', async () => {
    const app = await TestApp.create({
      routes: registerApiRoutes,
      providers: [DatabaseProvider],
    })

    await app.get('/health').assertOk()
  })

  it('serves the API root', async () => {
    const app = await TestApp.create({
      routes: registerApiRoutes,
      providers: [DatabaseProvider],
    })

    await app.get('/api/v1').assertOk()
  })
})
