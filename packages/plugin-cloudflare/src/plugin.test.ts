import { afterEach, describe, test, expect } from 'bun:test'
import { createApp, resetDefaultApplication } from '@guren/core'
import { cloudflarePlugin } from './index'

afterEach(() => {
  resetDefaultApplication()
})

describe('cloudflarePlugin', () => {
  test('should return an independent provider class per call', () => {
    const first = cloudflarePlugin()
    const second = cloudflarePlugin({})

    expect(typeof first).toBe('function')
    expect(first).not.toBe(second)
    expect(first.name).toBe('cloudflarePluginProvider')
  })

  test('should introspect through its hook instead of register()', async () => {
    const app = createApp({ providers: [cloudflarePlugin()] })

    const manifest = await app.introspect()

    const entry = manifest.providers.find((provider) => provider.name === 'cloudflarePluginProvider')
    expect(entry).toMatchObject({ source: 'options.providers', register: 'introspect-hook' })
  })
})
