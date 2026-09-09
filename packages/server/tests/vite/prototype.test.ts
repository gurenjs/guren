import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PROTOTYPE_SHELL_FILE, PROTOTYPE_SHELL_OVERRIDE, gurenVitePlugin, renderPrototypeShell } from '../../src/vite/plugin'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'guren-prototype-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('gurenVitePlugin in prototype mode', () => {
  it('takes the prototype branch instead of the client defaults', () => {
    const root = makeRoot()
    const plugin = gurenVitePlugin()
    const config: Record<string, any> = { root, publicDir: false }

    plugin.config(config, { command: 'build', mode: 'prototype' })

    expect(config.define['import.meta.env.GUREN_PROTOTYPE']).toBe('true')
    expect(config.appType).toBe('custom')
    expect(config.base).toBe('/')
    expect(config.build.outDir).toBe('dist/prototype')
    expect(config.build.manifest).toBe(false)
    expect(config.build.ssrManifest).toBe(false)
    expect(config.build.copyPublicDir).toBe(true)
    // The template's `publicDir: false` exists for the ordinary build; here it is replaced.
    expect(config.publicDir).toBe(path.resolve(root, 'public'))
    expect(config.build.rollupOptions.input).toBe(path.resolve(root, PROTOTYPE_SHELL_FILE))
    expect(readFileSync(path.resolve(root, PROTOTYPE_SHELL_FILE), 'utf8')).toContain('src="/resources/js/app.tsx"')
    expect(typeof config.build.rollupOptions.output.manualChunks).toBe('function')
  })

  it('keeps a custom publicDir and honours the prototype option', () => {
    const root = makeRoot()
    const plugin = gurenVitePlugin({ prototype: { base: '/demo/', outDir: 'out/proto' } })
    const config: Record<string, any> = { root, publicDir: 'static' }

    plugin.config(config, { command: 'build', mode: 'prototype' })

    expect(config.base).toBe('/demo/')
    expect(config.build.outDir).toBe('out/proto')
    expect(config.publicDir).toBe('static')
  })

  it('prefers the project shell override to the generated one', () => {
    const root = makeRoot()
    const override = path.resolve(root, PROTOTYPE_SHELL_OVERRIDE)
    mkdirSync(path.dirname(override), { recursive: true })
    writeFileSync(override, '<!doctype html><div id="app"></div>')
    const plugin = gurenVitePlugin()
    const config: Record<string, any> = { root }

    plugin.config(config, { command: 'build', mode: 'prototype' })

    expect(config.build.rollupOptions.input).toBe(override)
    expect(existsSync(path.resolve(root, PROTOTYPE_SHELL_FILE))).toBe(false)
  })

  it('defines GUREN_PROTOTYPE as false in every other mode', () => {
    const plugin = gurenVitePlugin()
    const client: Record<string, any> = {}
    const ssr: Record<string, any> = {}

    plugin.config(client, { command: 'build', mode: 'production' })
    plugin.config(ssr, { command: 'build', mode: 'production', ssrBuild: true })

    expect(client.define['import.meta.env.GUREN_PROTOTYPE']).toBe('false')
    expect(ssr.define['import.meta.env.GUREN_PROTOTYPE']).toBe('false')
    expect(client.appType).toBeUndefined()
    expect(client.build.outDir).toBe('public/assets')
  })

  it('moves the nested shell to the top of the output and writes the SPA fallbacks', () => {
    const root = makeRoot()
    const plugin = gurenVitePlugin()
    const config: Record<string, any> = { root }
    plugin.config(config, { command: 'build', mode: 'prototype' })
    plugin.configResolved({ root, build: { outDir: config.build.outDir } })

    const outDir = path.resolve(root, 'dist/prototype')
    const nested = path.resolve(outDir, PROTOTYPE_SHELL_FILE)
    mkdirSync(path.dirname(nested), { recursive: true })
    writeFileSync(nested, '<!doctype html><title>built</title>')

    plugin.writeBundle()

    expect(readFileSync(path.resolve(outDir, 'index.html'), 'utf8')).toContain('built')
    expect(readFileSync(path.resolve(outDir, '404.html'), 'utf8')).toContain('built')
    expect(readFileSync(path.resolve(outDir, '_redirects'), 'utf8')).toBe('/*    /index.html   200\n')
    expect(existsSync(path.resolve(outDir, '.guren'))).toBe(false)
  })

  it('serves the shell for document requests in dev and leaves assets to Vite', async () => {
    const root = makeRoot()
    const plugin = gurenVitePlugin()
    const config: Record<string, any> = { root }
    plugin.config(config, { command: 'serve', mode: 'prototype' })

    let handler: ((req: any, res: any, next: (error?: unknown) => void) => void) | undefined
    const server = {
      middlewares: { use: (fn: typeof handler) => { handler = fn } },
      transformIndexHtml: async (_url: string, html: string) => html.replace('</head>', '<!-- vite --></head>'),
    }
    const register = plugin.configureServer(server as any)
    register!()

    const served: string[] = []
    const res = { setHeader() {}, end(body: string) { served.push(body) } }
    let passed = 0
    const next = () => { passed += 1 }

    await handler!({ method: 'GET', url: '/posts/1', headers: { accept: 'text/html' } }, res, next)
    await handler!({ method: 'GET', url: '/resources/js/app.tsx', headers: { accept: '*/*' } }, res, next)
    await handler!({ method: 'GET', url: '/favicon.svg', headers: { accept: 'text/html' } }, res, next)
    await handler!({ method: 'POST', url: '/posts', headers: { accept: 'text/html' } }, res, next)

    expect(served).toHaveLength(1)
    expect(served[0]).toContain('<!-- vite -->')
    expect(served[0]).toContain('<div id="app"></div>')
    expect(passed).toBe(3)
  })

  it('does nothing in dev outside prototype mode', () => {
    const plugin = gurenVitePlugin()
    plugin.config({}, { command: 'serve', mode: 'development' })

    expect(plugin.configureServer({} as any)).toBeUndefined()
  })
})

describe('manualChunks and the prototype runtime', () => {
  it('leaves the prototype entry and the Hono router out of the eager vendor chunks', () => {
    const plugin = gurenVitePlugin()
    const config: Record<string, any> = {}
    plugin.config(config, { command: 'build', mode: 'production' })
    const manualChunks = config.build.rollupOptions.output.manualChunks as (id: string) => string | undefined

    expect(manualChunks('/app/node_modules/@guren/inertia-client/dist/app.js')).toBe('framework-vendor')
    expect(manualChunks('/repo/packages/inertia-client/src/app.tsx')).toBe('inertia-vendor')
    expect(manualChunks('/app/node_modules/@guren/inertia-client/dist/prototype.js')).toBeUndefined()
    expect(manualChunks('/repo/packages/inertia-client/src/prototype.ts')).toBeUndefined()
    expect(manualChunks('/app/node_modules/hono/dist/router/trie-router/router.js')).toBeUndefined()
    expect(manualChunks('/app/node_modules/hono/dist/jsx/index.js')).toBe('framework-vendor')
  })
})

describe('renderPrototypeShell', () => {
  it('points the module script at the entry and asks robots to stay away', () => {
    const shell = renderPrototypeShell('./resources/js/app.tsx')

    expect(shell).toContain('<script type="module" src="/resources/js/app.tsx"></script>')
    expect(shell).toContain('name="robots" content="noindex, nofollow"')
    expect(shell).toContain('<div id="app"></div>')
  })
})
