import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildVercelOutput, createVercelHandler, vercelPlugin } from '../src/index'

const DEFAULT_ENTRYPOINT_SOURCE = "export default { fetch() { return new Response('ok') } }\n"

/** Markers the fake SDK exports, so a test can tell "resolved" from "stubbed". */
const SDK_SERVER_INDEX_MARKER = 'fake-sdk-server-index'
const SDK_TRANSPORT_MARKER = 'fake-sdk-transport'

/**
 * An entrypoint importing both SDK subpaths and reporting what it got.
 *
 * `server/index.js` comes in as a *namespace*: the catch-all stub for an
 * unlisted subpath is a bare `throw` with no exports at all, so a named import
 * of it fails the bundle rather than the bundled module, and the stubbed and
 * unstubbed cases would then fail at different stages.
 */
const SDK_ENTRY_SOURCE =
  "import * as serverIndex from '@modelcontextprotocol/sdk/server/index.js'\n"
  + "import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'\n"
  + 'export default { fetch() { return new Response(`${serverIndex.MARKER}|${WebStandardStreamableHTTPServerTransport}`) } }\n'

/**
 * A stand-in for `@modelcontextprotocol/sdk` inside the scaffolded app.
 *
 * Deliberately without an `exports` map: a subpath under one that is slightly
 * wrong fails to resolve and reads exactly like the stub still intercepting,
 * which is the verdict these tests exist to distinguish.
 */
function installFakeMcpSdk(root: string): void {
  const pkg = join(root, 'node_modules/@modelcontextprotocol/sdk')
  mkdirSync(join(pkg, 'server'), { recursive: true })
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@modelcontextprotocol/sdk', version: '1.30.0', type: 'module' }),
    'utf8',
  )
  writeFileSync(join(pkg, 'server/index.js'), `export const MARKER = '${SDK_SERVER_INDEX_MARKER}'\n`, 'utf8')
  writeFileSync(
    join(pkg, 'server/webStandardStreamableHttp.js'),
    `export const WebStandardStreamableHTTPServerTransport = '${SDK_TRANSPORT_MARKER}'\n`,
    'utf8',
  )
}

/**
 * Writes a minimal buildable app under `root` and returns it as
 * `buildVercelOutput` options, so a test can just `await buildVercelOutput(app)`.
 */
function scaffoldApp(
  root: string,
  options: { entrypoint?: string; source?: string; mcpPlugin?: boolean } = {},
): { rootDir: string; entrypoint: string; outputDir: string } {
  const { entrypoint = 'src/index.ts', source = DEFAULT_ENTRYPOINT_SOURCE, mcpPlugin = false } = options
  const entrypointPath = join(root, entrypoint)

  mkdirSync(dirname(entrypointPath), { recursive: true })
  writeFileSync(entrypointPath, source, 'utf8')

  if (mcpPlugin) {
    // Declaring the plugin under `dependencies` is the App MCP opt-in the
    // build reads (RFC 0016 §7).
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo-app', dependencies: { '@guren/plugin-mcp': '^0.2.0' } }),
      'utf8',
    )
  }

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

  it('returns an independent provider class per factory call', async () => {
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

    it('refuses an outputDir that is, contains, or is the root of the app', async () => {
      // The build deletes outputDir before writing it, so a caller that points
      // it at the project (or at `/`) would lose the source tree.
      const app = scaffoldApp(root, { entrypoint: 'src/vercel.ts' })

      for (const outputDir of [root, join(root, '..'), '/']) {
        await expect(buildVercelOutput({ ...app, outputDir })).rejects.toThrow(
          /never the root itself or a parent of it/,
        )
      }
      expect(readFileSync(app.entrypoint, 'utf8')).toBe(DEFAULT_ENTRYPOINT_SOURCE)
    })

    it('reads the client manifest from a custom publicDir', async () => {
      const app = scaffoldApp(root, { entrypoint: 'src/vercel.ts' })
      mkdirSync(join(root, 'web-root/assets/.vite'), { recursive: true })
      writeFileSync(
        join(root, 'web-root/assets/.vite/manifest.json'),
        JSON.stringify({
          'resources/js/app.tsx': { file: 'app-Custom999.js', css: ['app-Custom999.css'] },
        }),
      )

      await buildVercelOutput({ ...app, publicDir: join(root, 'web-root') })

      const config = JSON.parse(
        readFileSync(join(app.outputDir, 'functions/index.func/.vc-config.json'), 'utf8'),
      ) as { environment: Record<string, string> }

      expect(config.environment.GUREN_INERTIA_ENTRY).toBe('/assets/app-Custom999.js')
      expect(config.environment.GUREN_INERTIA_STYLES).toBe('/assets/app-Custom999.css')
    })

    it('inlines the client manifest into the bundle for viteAsset()', async () => {
      // The function directory ships no public/assets/manifest.json, and the
      // function environment is size-capped — so the build substitutes the
      // exact expression `process.env.GUREN_VITE_MANIFEST` with the manifest
      // JSON via `define`. The fixture reads that expression the same way
      // @guren/server's vite-manifest.ts does (its form is pinned by a server
      // source test), so an inlined read here proves the mechanism.
      const app = scaffoldApp(root, {
        entrypoint: 'src/vercel.ts',
        source:
          'export const manifest = process.env.GUREN_VITE_MANIFEST\n' + DEFAULT_ENTRYPOINT_SOURCE,
      })
      mkdirSync(join(root, 'public/assets/.vite'), { recursive: true })
      writeFileSync(
        join(root, 'public/assets/.vite/manifest.json'),
        JSON.stringify({ 'resources/css/app.css': { file: 'app-1nl1ned.css' } }),
      )

      await buildVercelOutput(app)

      const bundle = readFileSync(
        join(app.outputDir, 'functions/index.func/vercel.js'),
        'utf8',
      )
      expect(bundle).toContain('app-1nl1ned.css')
      expect(bundle).not.toContain('process.env.GUREN_VITE_MANIFEST')

      // And never through the environment, where the payload would count
      // against Vercel's configuration size limits.
      const config = JSON.parse(
        readFileSync(join(app.outputDir, 'functions/index.func/.vc-config.json'), 'utf8'),
      ) as { environment: Record<string, string> }
      expect(config.environment.GUREN_VITE_MANIFEST).toBeUndefined()
    })

    it('points GUREN_INERTIA_SSR_MANIFEST at the layout the SSR build produced', async () => {
      // Older Vite configs emit a flat manifest.json; naming the .vite path
      // unconditionally leaves the runtime loading a file that is not there.
      const app = scaffoldApp(root, { entrypoint: 'src/vercel.ts' })
      mkdirSync(join(root, '.guren/ssr'), { recursive: true })
      writeFileSync(join(root, '.guren/ssr/ssr-Xyz789.js'), 'export const render = () => ({})\n')
      writeFileSync(
        join(root, '.guren/ssr/manifest.json'),
        JSON.stringify({ 'resources/js/ssr.tsx': { file: 'ssr-Xyz789.js' } }),
      )

      await buildVercelOutput(app)

      const config = JSON.parse(
        readFileSync(join(app.outputDir, 'functions/index.func/.vc-config.json'), 'utf8'),
      ) as { environment: Record<string, string> }

      expect(config.environment.GUREN_INERTIA_SSR_ENTRY).toBe('./.guren/ssr/ssr-Xyz789.js')
      expect(config.environment.GUREN_INERTIA_SSR_MANIFEST).toBe('./.guren/ssr/manifest.json')
    })

    it('fails when the SSR manifest names a chunk that is not on disk, keeping the previous output', async () => {
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

      await expect(buildVercelOutput(app)).rejects.toThrow(/but the file does not exist/)
      // Deleting before validation would take the last deployable artifact
      // with it, leaving nothing to roll back to.
      expect(readFileSync(join(app.outputDir, 'config.json'), 'utf8')).toBe('{ "previous": true }')
    })

    it('fails on a missing entrypoint before touching the previous output', async () => {
      // The spawned `bun build` would also fail on this, but only after the
      // previous output was deleted.
      const app = scaffoldApp(root, { entrypoint: 'src/vercel.ts' })
      rmSync(app.entrypoint)
      mkdirSync(join(app.outputDir, 'functions'), { recursive: true })
      writeFileSync(join(app.outputDir, 'config.json'), '{ "previous": true }')

      await expect(buildVercelOutput(app)).rejects.toThrow(/entrypoint not found/)
      expect(readFileSync(join(app.outputDir, 'config.json'), 'utf8')).toBe('{ "previous": true }')
    })

    it('matches the configured handler filename to the bundled entrypoint', async () => {
      const app = scaffoldApp(root, { entrypoint: 'src/vercel.ts' })

      await buildVercelOutput(app)

      const config = JSON.parse(
        readFileSync(join(app.outputDir, 'functions/index.func/.vc-config.json'), 'utf8'),
      ) as { handler: string }

      expect(config.handler).toBe('vercel.js')
    })

    it('routes the asset base back onto the output root', async () => {
      // Built assets self-reference `/public/assets/` while the files land at
      // the output root, so a deployment routed only by this file — which is
      // what `--prebuilt` does — needs the mapping here rather than in
      // vercel.json.
      const app = scaffoldApp(root, { entrypoint: 'src/vercel.ts' })

      await buildVercelOutput(app)

      const config = JSON.parse(readFileSync(join(app.outputDir, 'config.json'), 'utf8'))
      const routes = config.routes as Array<Record<string, string>>

      expect(routes[0]).toEqual({ src: '/public/(.*)', dest: '/$1' })
      // It has to win before the filesystem handler, which would otherwise
      // miss and fall through to the function.
      expect(routes.findIndex((route) => route.handle === 'filesystem')).toBeGreaterThan(0)
    })

    it('copies the docs directory into the function bundle', async () => {
      const app = scaffoldApp(root)
      mkdirSync(join(root, 'docs/en/guides'), { recursive: true })
      writeFileSync(join(root, 'docs/en/guides/overview.md'), '# Overview\n\nHello docs.\n', 'utf8')

      await buildVercelOutput(app)

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

      await buildVercelOutput(app)

      // Asserting on the runtime name rather than the bundle text: `.name` is
      // what the queue registry and notification types actually read, and it
      // survives any reformatting the bundler may do.
      const bundled = await import(join(app.outputDir, 'functions/index.func/index.js'))
      const response = await bundled.default.fetch(new Request('http://example.com/'))

      expect(await response.text()).toBe('GurenJobProbe')
    })

    it('finds docs in a parent directory when the app root is nested', async () => {
      const app = scaffoldApp(join(root, 'web'))
      mkdirSync(join(root, 'docs/en/guides'), { recursive: true })
      writeFileSync(join(root, 'docs/en/guides/overview.md'), '# Overview\n\nParent docs.\n', 'utf8')

      await buildVercelOutput(app)

      const copied = readFileSync(
        join(app.outputDir, 'functions/index.func/docs/en/guides/overview.md'),
        'utf8',
      )

      expect(copied).toContain('Parent docs.')
    })

    it('stubs both MCP SDK subpaths for an app that does not depend on the plugin', async () => {
      // The regression hold: nothing about RFC 0016 Phase 4a reaches an app
      // that never asked for the App MCP endpoint.
      const app = scaffoldApp(root, { source: SDK_ENTRY_SOURCE })
      installFakeMcpSdk(root)

      await buildVercelOutput(app)

      const bundle = readFileSync(join(app.outputDir, 'functions/index.func/index.js'), 'utf8')
      expect(bundle).toContain('The MCP endpoint is unavailable on Vercel')
      // The SDK sits installed beside the app, so its markers reaching the
      // bundle is what "resolved for real" would look like.
      expect(bundle).not.toContain(SDK_TRANSPORT_MARKER)
      expect(bundle).not.toContain(SDK_SERVER_INDEX_MARKER)
    })

    it('bundles the real MCP SDK for an app depending on @guren/plugin-mcp', async () => {
      const app = scaffoldApp(root, { source: SDK_ENTRY_SOURCE, mcpPlugin: true })
      installFakeMcpSdk(root)

      await buildVercelOutput(app)

      // Two mechanisms had to stop firing, and the markers tell them apart
      // from "resolved nothing": `webStandardStreamableHttp.js` is the entry
      // the stub map releases, and `server/index.js` is one no entry ever
      // named — only the SDK-prefix catch-all could have stubbed it, and
      // @guren/plugin-mcp imports it *statically*, so a catch-all still in
      // force would leave the endpoint just as compiled shut.
      const bundle = readFileSync(join(app.outputDir, 'functions/index.func/index.js'), 'utf8')
      expect(bundle).toContain(SDK_TRANSPORT_MARKER)
      expect(bundle).toContain(SDK_SERVER_INDEX_MARKER)
      expect(bundle).not.toContain('The MCP endpoint is unavailable on Vercel')
    })

    it('keeps the Dev MCP server stubbed even for an app depending on the plugin', async () => {
      // Its McpServer drives the CLI's code generators against a filesystem
      // the function does not have, and the App MCP endpoint never touches it.
      const app = scaffoldApp(root, {
        source:
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'\n"
          + 'export default { fetch() { return new Response(String(McpServer)) } }\n',
        mcpPlugin: true,
      })
      installFakeMcpSdk(root)
      writeFileSync(
        join(root, 'node_modules/@modelcontextprotocol/sdk/server/mcp.js'),
        "export const McpServer = 'fake-sdk-mcp-server'\n",
      )

      await buildVercelOutput(app)

      const bundle = readFileSync(join(app.outputDir, 'functions/index.func/index.js'), 'utf8')
      expect(bundle).toContain('The MCP endpoint is unavailable on Vercel')
      expect(bundle).not.toContain('fake-sdk-mcp-server')
    })
  })
})
