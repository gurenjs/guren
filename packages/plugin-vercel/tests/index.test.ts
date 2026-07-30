import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildVercelOutput, createVercelHandler, vercelPlugin } from '../src/index'

const DEFAULT_ENTRYPOINT_SOURCE = "export default { fetch() { return new Response('ok') } }\n"

/**
 * Writes a minimal buildable app under `root` and returns it as
 * `buildVercelOutput` options, so a test can just `buildVercelOutput(app)`.
 */
function scaffoldApp(
  root: string,
  options: { entrypoint?: string; source?: string } = {},
): { rootDir: string; entrypoint: string; outputDir: string } {
  const { entrypoint = 'src/index.ts', source = DEFAULT_ENTRYPOINT_SOURCE } = options
  const entrypointPath = join(root, entrypoint)

  mkdirSync(dirname(entrypointPath), { recursive: true })
  writeFileSync(entrypointPath, source, 'utf8')

  return { rootDir: root, entrypoint: entrypointPath, outputDir: join(root, '.vercel/output') }
}

describe('@guren/plugin-vercel', () => {
  it('creates a Vercel fetch handler from a bootable app', async () => {
    let booted = false
    const app = {
      async boot() {
        booted = true
      },
      async fetch(request: Request) {
        return new Response(`ok:${new URL(request.url).pathname}`)
      },
    }

    const handler = await createVercelHandler(app)
    const response = await handler.fetch(new Request('http://example.com/hello'))

    expect(booted).toBe(true)
    expect(await response.text()).toBe('ok:/hello')
  })

  it('returns an independent provider class per factory call', () => {
    const first = vercelPlugin()
    const second = vercelPlugin({})

    expect(typeof first).toBe('function')
    expect(first).not.toBe(second)
    expect(first.name).toBe('vercelPluginProvider')
  })

  describe('buildVercelOutput', () => {
    let root: string

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'guren-plugin-vercel-'))
    })

    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('refuses an outputDir that is, contains, or is the root of the app', () => {
      // The build deletes outputDir before writing it, so a caller that points
      // it at the project (or at `/`) would lose the source tree.
      const app = scaffoldApp(root, { entrypoint: 'src/vercel.ts' })

      for (const outputDir of [root, join(root, '..'), '/']) {
        expect(() => buildVercelOutput({ ...app, outputDir })).toThrow(
          /never the root itself or a parent of it/,
        )
      }
      expect(readFileSync(app.entrypoint, 'utf8')).toBe(DEFAULT_ENTRYPOINT_SOURCE)
    })

    it('reads the client manifest from a custom publicDir', () => {
      const app = scaffoldApp(root, { entrypoint: 'src/vercel.ts' })
      mkdirSync(join(root, 'web-root/assets/.vite'), { recursive: true })
      writeFileSync(
        join(root, 'web-root/assets/.vite/manifest.json'),
        JSON.stringify({
          'resources/js/app.tsx': { file: 'app-Custom999.js', css: ['app-Custom999.css'] },
        }),
      )

      buildVercelOutput({ ...app, publicDir: join(root, 'web-root') })

      const config = JSON.parse(
        readFileSync(join(app.outputDir, 'functions/index.func/.vc-config.json'), 'utf8'),
      ) as { environment: Record<string, string> }

      expect(config.environment.GUREN_INERTIA_ENTRY).toBe('/assets/app-Custom999.js')
      expect(config.environment.GUREN_INERTIA_STYLES).toBe('/assets/app-Custom999.css')
    })

    it('points GUREN_INERTIA_SSR_MANIFEST at the layout the SSR build produced', () => {
      // Older Vite configs emit a flat manifest.json; naming the .vite path
      // unconditionally leaves the runtime loading a file that is not there.
      const app = scaffoldApp(root, { entrypoint: 'src/vercel.ts' })
      mkdirSync(join(root, '.guren/ssr'), { recursive: true })
      writeFileSync(join(root, '.guren/ssr/ssr-Xyz789.js'), 'export const render = () => ({})\n')
      writeFileSync(
        join(root, '.guren/ssr/manifest.json'),
        JSON.stringify({ 'resources/js/ssr.tsx': { file: 'ssr-Xyz789.js' } }),
      )

      buildVercelOutput(app)

      const config = JSON.parse(
        readFileSync(join(app.outputDir, 'functions/index.func/.vc-config.json'), 'utf8'),
      ) as { environment: Record<string, string> }

      expect(config.environment.GUREN_INERTIA_SSR_ENTRY).toBe('./.guren/ssr/ssr-Xyz789.js')
      expect(config.environment.GUREN_INERTIA_SSR_MANIFEST).toBe('./.guren/ssr/manifest.json')
    })

    it('fails when the SSR manifest names a chunk that is not on disk, keeping the previous output', () => {
      // Previously written into the function environment unchecked, so a stale
      // or partial SSR build deployed and fell back to CSR at request time.
      // Cloudflare and Lambda already treated this as fatal.
      const app = scaffoldApp(root, { entrypoint: 'src/vercel.ts' })
      mkdirSync(join(app.outputDir, 'functions'), { recursive: true })
      writeFileSync(join(app.outputDir, 'config.json'), '{ "previous": true }')
      mkdirSync(join(root, '.guren/ssr/.vite'), { recursive: true })
      writeFileSync(
        join(root, '.guren/ssr/.vite/manifest.json'),
        JSON.stringify({ 'resources/js/ssr.tsx': { file: 'ssr-Gone.js' } }),
      )

      expect(() => buildVercelOutput(app)).toThrow(/but the file does not exist/)
      // Deleting before validation would take the last deployable artifact
      // with it, leaving nothing to roll back to.
      expect(readFileSync(join(app.outputDir, 'config.json'), 'utf8')).toBe('{ "previous": true }')
    })

    it('fails on a missing entrypoint before touching the previous output', () => {
      // The spawned `bun build` would also fail on this, but only after the
      // previous output was deleted.
      const app = scaffoldApp(root, { entrypoint: 'src/vercel.ts' })
      rmSync(app.entrypoint)
      mkdirSync(join(app.outputDir, 'functions'), { recursive: true })
      writeFileSync(join(app.outputDir, 'config.json'), '{ "previous": true }')

      expect(() => buildVercelOutput(app)).toThrow(/entrypoint not found/)
      expect(readFileSync(join(app.outputDir, 'config.json'), 'utf8')).toBe('{ "previous": true }')
    })

    it('matches the configured handler filename to the bundled entrypoint', () => {
      const app = scaffoldApp(root, { entrypoint: 'src/vercel.ts' })

      buildVercelOutput(app)

      const config = JSON.parse(
        readFileSync(join(app.outputDir, 'functions/index.func/.vc-config.json'), 'utf8'),
      ) as { handler: string }

      expect(config.handler).toBe('vercel.js')
    })

    it('routes the asset base back onto the output root', () => {
      // Built assets self-reference `/public/assets/` while the files land at
      // the output root, so a deployment routed only by this file — which is
      // what `--prebuilt` does — needs the mapping here rather than in
      // vercel.json.
      const app = scaffoldApp(root, { entrypoint: 'src/vercel.ts' })

      buildVercelOutput(app)

      const config = JSON.parse(readFileSync(join(app.outputDir, 'config.json'), 'utf8'))
      const routes = config.routes as Array<Record<string, string>>

      expect(routes[0]).toEqual({ src: '/public/(.*)', dest: '/$1' })
      // It has to win before the filesystem handler, which would otherwise
      // miss and fall through to the function.
      expect(routes.findIndex((route) => route.handle === 'filesystem')).toBeGreaterThan(0)
    })

    it('copies the docs directory into the function bundle', () => {
      const app = scaffoldApp(root)
      mkdirSync(join(root, 'docs/en/guides'), { recursive: true })
      writeFileSync(join(root, 'docs/en/guides/overview.md'), '# Overview\n\nHello docs.\n', 'utf8')

      buildVercelOutput(app)

      const copied = readFileSync(
        join(app.outputDir, 'functions/index.func/docs/en/guides/overview.md'),
        'utf8',
      )

      expect(copied).toContain('Hello docs.')
    })

    it('preserves class names through the bundler', async () => {
      // Regression guard for the bundler flags in src/index.ts — see the comment
      // on that argv for why mangled class names outlive a deploy.
      const app = scaffoldApp(root, {
        source:
          'class GurenJobProbe {}\nexport default { fetch() { return new Response(GurenJobProbe.name) } }\n',
      })

      buildVercelOutput(app)

      // Asserting on the runtime name rather than the bundle text: `.name` is
      // what the queue registry and notification types actually read, and it
      // survives any reformatting the bundler may do.
      const bundled = await import(join(app.outputDir, 'functions/index.func/index.js'))
      const response = await bundled.default.fetch(new Request('http://example.com/'))

      expect(await response.text()).toBe('GurenJobProbe')
    })

    it('finds docs in a parent directory when the app root is nested', () => {
      const app = scaffoldApp(join(root, 'web'))
      mkdirSync(join(root, 'docs/en/guides'), { recursive: true })
      writeFileSync(join(root, 'docs/en/guides/overview.md'), '# Overview\n\nParent docs.\n', 'utf8')

      buildVercelOutput(app)

      const copied = readFileSync(
        join(app.outputDir, 'functions/index.func/docs/en/guides/overview.md'),
        'utf8',
      )

      expect(copied).toContain('Parent docs.')
    })
  })
})
