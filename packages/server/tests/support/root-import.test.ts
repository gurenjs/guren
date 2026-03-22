import { describe, expect, test } from 'bun:test'

describe('@guren/server root import', () => {
  test('loads in a non-Bun-specific import path without exporting runtime helpers', async () => {
    const server = await import('../../src/index')

    expect(server.Controller).toBeDefined()
    expect(server.createApp).toBeDefined()
    expect('autoConfigureInertiaAssets' in server).toBe(false)
  })
})
