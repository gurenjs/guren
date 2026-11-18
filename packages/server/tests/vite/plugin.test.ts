import { describe, expect, it, spyOn } from 'bun:test'
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

describe('the manualChunks option', () => {
  const splitZod = (id: string) => (id.includes('/node_modules/zod/') ? 'zod' : undefined)

  function clientChunks(options: Parameters<typeof gurenVitePlugin>[0]) {
    const config: Record<string, any> = {}
    gurenVitePlugin(options).config?.(config, { command: 'build' })
    return config.build.rollupOptions.output.manualChunks as (id: string) => string | undefined
  }

  it('names the chunk of a module it claims and keeps the built-in grouping for the rest', () => {
    const manualChunks = clientChunks({ manualChunks: splitZod })

    expect(manualChunks('/app/node_modules/zod/v4/core/schemas.js')).toBe('zod')
    expect(manualChunks('/app/node_modules/react-dom/index.js')).toBe('react-vendor')
    expect(manualChunks('/app/node_modules/@inertiajs/react/dist/index.js')).toBe('inertia-vendor')
    expect(manualChunks('/app/node_modules/@guren/inertia-client/dist/app.js')).toBe('framework-vendor')
    expect(manualChunks('/app/node_modules/clsx/dist/clsx.mjs')).toBe('vendor')
  })

  it('names no chunk for a module the option answers null for', () => {
    const manualChunks = clientChunks({
      manualChunks: (id) => (id.includes('/node_modules/zod/') ? null : undefined),
    })

    expect(manualChunks('/app/node_modules/zod/index.js')).toBeUndefined()
    expect(manualChunks('/app/node_modules/clsx/dist/clsx.mjs')).toBe('vendor')
  })

  it('passes the module path with forward slashes', () => {
    const manualChunks = clientChunks({ manualChunks: splitZod })

    expect(manualChunks('C:\\app\\node_modules\\zod\\index.js')).toBe('zod')
  })

  it('applies to the prototype build', () => {
    const config: Record<string, any> = { build: { rollupOptions: { input: '/app/index.html' } } }
    gurenVitePlugin({ manualChunks: splitZod, prototype: { shell: 'index.html' } }).config?.(config, {
      command: 'build',
      mode: 'prototype',
    })

    expect(config.build.rollupOptions.output.manualChunks('/app/node_modules/zod/index.js')).toBe('zod')
  })

  it('sets no manualChunks for the SSR build', () => {
    const config: Record<string, any> = {}
    gurenVitePlugin({ manualChunks: splitZod }).config?.(config, { ssrBuild: true })

    expect(config.build.rollupOptions.output.manualChunks).toBeUndefined()
  })

  it('keeps an explicit output.manualChunks and warns that the option is unused', () => {
    const own = () => 'everything'
    const config: Record<string, any> = { build: { rollupOptions: { output: { manualChunks: own } } } }
    const warn = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      gurenVitePlugin({ manualChunks: splitZod }).config?.(config, { command: 'build' })

      expect(config.build.rollupOptions.output.manualChunks).toBe(own)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('build.rollupOptions.output.manualChunks')
    } finally {
      warn.mockRestore()
    }
  })

  it('does not warn about an explicit output.manualChunks when the option is absent', () => {
    const config: Record<string, any> = { build: { rollupOptions: { output: { manualChunks: () => 'x' } } } }
    const warn = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      gurenVitePlugin().config?.(config, { command: 'build' })

      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
