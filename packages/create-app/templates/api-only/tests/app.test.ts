import { describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

// Built from the app entry, so the test exercises the config definitions
// createApp() wires rather than a second app that never sees them.
describe('api', () => {
  it('answers the health check', async () => {
    const http = await TestApp.fromApp(app)

    await http.get('/health').assertOk()
  })

  it('serves the API root', async () => {
    const http = await TestApp.fromApp(app)

    await http.get('/api/v1').assertOk()
  })
})
