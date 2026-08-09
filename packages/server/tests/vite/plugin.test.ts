import { describe, expect, it } from 'bun:test'
import { gurenVitePlugin } from '../../src/vite/plugin'

describe('gurenVitePlugin', () => {
  it('applies default client build settings', () => {
    const plugin = gurenVitePlugin()
    const config: Record<string, any> = {}

    plugin.config?.(config, { command: 'build' })

    expect(config.resolve.alias).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ find: '@', replacement: process.cwd() }),
        expect.objectContaining({ find: '@resources' }),
      ]),
    )
    expect(config.server.host).toBeUndefined()
    expect(config.server.port).toBe(5173)
    expect(config.preview.host).toBe(true)
    expect(config.preview.port).toBe(4173)
    expect(config.build.outDir).toBe('public/assets')
    expect(config.build.manifest).toBe(true)
    expect(config.build.ssrManifest).toBe(true)
    expect(config.build.copyPublicDir).toBe(false)
    expect(config.publicDir).toBe(false)
    expect(typeof config.build.rollupOptions.output.manualChunks).toBe('function')
    expect(config.base).toBe('/public/assets/')
  })

  it('leaves an explicit server.host alone', () => {
    const plugin = gurenVitePlugin()
    const config: Record<string, any> = { server: { host: true } }

    plugin.config?.(config, { command: 'serve' })

    expect(config.server.host).toBe(true)
  })

  it('applies SSR build defaults', () => {
    const plugin = gurenVitePlugin()
    const config: Record<string, any> = {}

    plugin.config?.(config, { ssrBuild: true })

    expect(config.build.outDir).toBe('.guren/ssr')
    expect(config.build.manifest).toBe(true)
    expect(config.build.ssr).toContain('resources/js/ssr.tsx')
    expect(config.ssr.noExternal).toBe(true)
  })

  it('respects user-provided ssr.noExternal', () => {
    const plugin = gurenVitePlugin()
    const config: Record<string, any> = { ssr: { noExternal: ['react'] } }

    plugin.config?.(config, { ssrBuild: true })

    expect(config.ssr.noExternal).toEqual(['react'])
  })

  it('does not touch ssr config for client builds', () => {
    const plugin = gurenVitePlugin()
    const config: Record<string, any> = {}

    plugin.config?.(config, { command: 'build' })

    expect(config.ssr).toBeUndefined()
  })
})
