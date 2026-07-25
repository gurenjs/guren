import { describe, test, expect } from 'bun:test'
import { cloudflarePlugin } from './index'

describe('cloudflarePlugin', () => {
  test('should return an independent provider class per call', () => {
    const first = cloudflarePlugin()
    const second = cloudflarePlugin({})

    expect(typeof first).toBe('function')
    expect(first).not.toBe(second)
    expect(first.name).toBe('cloudflarePluginProvider')
  })
})
