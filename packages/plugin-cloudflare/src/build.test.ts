import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOCUMENT_ASSET_EXTENSIONS, MCP_TRANSPORT_SPECIFIER } from '@guren/core/internal/deploy-build'
import { buildCloudflareOutput } from './build'

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2))
}

async function captureWarnings(run: () => Promise<void>): Promise<string> {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (message: string) => warnings.push(message)
  try {
    await run()
  } finally {
    console.warn = original
  }
  return warnings.join('\n')
}

/** The client manifest `scaffoldApp` writes — assertions derive from this. */
const CLIENT_MANIFEST = {
  'resources/js/app.tsx': { file: 'app-Abc123.js', css: ['app-Def456.css'] },
}

function scaffoldApp(
  root: string,
  options: { ssr?: boolean; renderExport?: string; mcpPlugin?: boolean } = {},
): void {
  const {
    ssr = true,
    renderExport = 'export const render = () => ({ body: "", head: [] })',
    mcpPlugin = false,
  } = options

  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/app.ts'), 'export default { boot: async () => {}, fetch: async () => new Response("ok") }\n')
  // Declaring `@guren/plugin-mcp` under `dependencies` is the App MCP opt-in
  // the build reads (RFC 0016 §7).
  writeJson(join(root, 'package.json'), {
    name: '@acme/demo-app',
    ...(mcpPlugin ? { dependencies: { '@guren/plugin-mcp': '^0.2.0' } } : {}),
  })

  mkdirSync(join(root, 'public/assets/.vite'), { recursive: true })
  writeFileSync(join(root, 'public/robots.txt'), 'User-agent: *\n')
  writeFileSync(join(root, 'public/assets/app-Abc123.js'), 'console.log("client")\n')
  writeJson(join(root, 'public/assets/.vite/manifest.json'), CLIENT_MANIFEST)

  if (ssr) {
    mkdirSync(join(root, '.guren/ssr/.vite'), { recursive: true })
    writeFileSync(join(root, '.guren/ssr/ssr-Xyz789.js'), `${renderExport}\n`)
    writeJson(join(root, '.guren/ssr/.vite/manifest.json'), {
      'resources/js/ssr.tsx': { file: 'ssr-Xyz789.js' },
    })
  }
}

describe('buildCloudflareOutput', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-build-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('should generate a worker that wires SSR, assets env, and the app entry', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
    expect(worker).toContain("import { createWorkersHandler } from '@guren/plugin-cloudflare'")
    expect(worker).toContain("import { setInertiaSsrRenderer } from '@guren/core'")
    expect(worker).toContain('import * as ssrModule from "../.guren/ssr/ssr-Xyz789.js"')
    expect(worker).toContain('import app from "../src/app.ts"')
    expect(worker).toContain('setInertiaSsrRenderer(ssrModule.render)')
    expect(worker).toContain('export default createWorkersHandler(app)')

    // The env assignments live in a module the worker imports *first*: a
    // statement in worker.js itself would run after the app's module graph
    // evaluated, so a module-scope viteAsset() call would see no manifest.
    const workerEnv = readFileSync(join(root, '.cloudflare/worker-env.js'), 'utf8')
    expect(workerEnv).toContain('process.env.GUREN_INERTIA_ENTRY = "/assets/app-Abc123.js"')
    expect(workerEnv).toContain('process.env.GUREN_INERTIA_STYLES = "/assets/app-Def456.css"')
    expect(worker.indexOf("import './worker-env.js'")).toBeGreaterThanOrEqual(0)
    expect(worker.indexOf("import './worker-env.js'")).toBeLessThan(worker.indexOf('import app'))
  })

  test('should bake the client manifest JSON into the worker for viteAsset()', async () => {
    // Workers has no filesystem, so viteAsset()'s production lookup can only
    // be answered by the GUREN_VITE_MANIFEST injection.
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const workerEnv = readFileSync(join(root, '.cloudflare/worker-env.js'), 'utf8')
    expect(workerEnv).toContain(
      `process.env.GUREN_VITE_MANIFEST = ${JSON.stringify(JSON.stringify(CLIENT_MANIFEST))}`,
    )
  })

  test('should copy public files into the assets directory', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    expect(readFileSync(join(root, '.cloudflare/assets/robots.txt'), 'utf8')).toContain('User-agent')
    expect(existsSync(join(root, '.cloudflare/assets/assets/app-Abc123.js'))).toBe(true)
  })

  test('should drop public/index.html so it cannot shadow the root route', async () => {
    scaffoldApp(root)
    writeFileSync(join(root, 'public/index.html'), '<div id="app"></div>')

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    expect(existsSync(join(root, '.cloudflare/assets/index.html'))).toBe(false)
    expect(existsSync(join(root, '.cloudflare/assets/robots.txt'))).toBe(true)
  })

  test('should mirror built assets under the /public/assets base URL path', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    expect(existsSync(join(root, '.cloudflare/assets/public/assets/app-Abc123.js'))).toBe(true)
  })

  test('should reject an SSR manifest entry that escapes the SSR directory', async () => {
    scaffoldApp(root)
    writeJson(join(root, '.guren/ssr/.vite/manifest.json'), {
      'resources/js/ssr.tsx': { file: '../../outside.js' },
    })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /escapes the SSR output directory/,
    )
  })

  test('should refuse an outputDir that is or contains the app root', async () => {
    scaffoldApp(root)

    await expect(
      buildCloudflareOutput({ rootDir: root, outputDir: root, skipAppBuild: true }),
    ).rejects.toThrow(/never the root itself/)
    await expect(
      buildCloudflareOutput({ rootDir: root, outputDir: join(root, '..'), skipAppBuild: true }),
    ).rejects.toThrow(/never the root itself/)
    expect(existsSync(join(root, 'src/app.ts'))).toBe(true)
  })

  test('should keep the previous output when the build fails', async () => {
    scaffoldApp(root)
    mkdirSync(join(root, '.cloudflare'), { recursive: true })
    writeFileSync(join(root, '.cloudflare/worker.js'), '// previous deploy\n')
    rmSync(join(root, 'src/app.ts'))

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /app entry not found/,
    )

    expect(readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')).toBe('// previous deploy\n')
  })

  test('should refuse the filesystem root as outputDir', async () => {
    scaffoldApp(root)

    // `out + sep` is "//" here, which no absolute path is prefixed by — a
    // string-prefix containment test lets this through to the rmSync.
    await expect(
      buildCloudflareOutput({ rootDir: root, outputDir: '/', skipAppBuild: true }),
    ).rejects.toThrow(/never the root itself or a parent of it/)
    expect(existsSync(join(root, 'src/app.ts'))).toBe(true)
  })

  test('should read the client manifest from a custom publicDir', async () => {
    scaffoldApp(root)

    // Move the built client somewhere other than <root>/public: the manifest
    // lookup has to follow `publicDir`, not assume the default location.
    mkdirSync(join(root, 'web-root/assets/.vite'), { recursive: true })
    writeJson(join(root, 'web-root/assets/.vite/manifest.json'), {
      'resources/js/app.tsx': { file: 'app-Custom999.js', css: ['app-Custom999.css'] },
    })

    await buildCloudflareOutput({
      rootDir: root,
      publicDir: join(root, 'web-root'),
      skipAppBuild: true,
    })

    const workerEnv = readFileSync(join(root, '.cloudflare/worker-env.js'), 'utf8')
    expect(workerEnv).toContain('process.env.GUREN_INERTIA_ENTRY = "/assets/app-Custom999.js"')
    expect(workerEnv).toContain('process.env.GUREN_INERTIA_STYLES = "/assets/app-Custom999.css"')
  })

  test('should scaffold wrangler.jsonc once and never overwrite it', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const configPath = join(root, 'wrangler.jsonc')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(config.name).toBe('demo-app')
    expect(config.main).toBe('.cloudflare/worker.js')
    expect(config.compatibility_flags).toEqual(['nodejs_compat'])
    expect(config.assets.directory).toBe('.cloudflare/assets')
    expect(config.d1_databases[0].migrations_dir).toBe('.cloudflare/d1-migrations')

    writeFileSync(configPath, '{ "name": "user-edited" }\n')
    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })
    expect(readFileSync(configPath, 'utf8')).toContain('user-edited')
  })

  test('should generate a CSR-only worker when no SSR manifest exists', async () => {
    scaffoldApp(root, { ssr: false })

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
    expect(worker).not.toContain('setInertiaSsrRenderer')
    expect(worker).toContain('export default createWorkersHandler(app)')
  })

  test('should accept an SSR entry with a default export', async () => {
    scaffoldApp(root, { renderExport: 'export default () => ({ body: "", head: [] })' })

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
    expect(worker).toContain('setInertiaSsrRenderer(ssrModule.default)')
    expect(worker).not.toContain('ssrModule.render')
  })

  test('should prefer a callable default over a non-function render', async () => {
    scaffoldApp(root, {
      renderExport: 'export const render = 42\nexport default () => ({ body: "", head: [] })',
    })

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    // What the runtime loader would pick: each candidate is tested for being a
    // function, so a non-callable `render` does not shadow a valid default.
    const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
    expect(worker).toContain('setInertiaSsrRenderer(ssrModule.default)')
  })

  test('should throw when the SSR entry exports no renderer', async () => {
    scaffoldApp(root, { renderExport: 'export const unrelated = 42' })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /does not export a renderer/,
    )
  })

  test('should throw when the app entry is missing', async () => {
    scaffoldApp(root)
    rmSync(join(root, 'src/app.ts'))

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /app entry not found/,
    )
  })
})

describe('static document headers', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-doc-headers-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('should write a _headers rule for every document extension', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const headers = readFileSync(join(root, '.cloudflare/assets/_headers'), 'utf8')
    // Derived from the shared list rather than spelled out here, so an
    // extension added there fails this until it has a rule. One splat per
    // pattern: a second one is a parse error the platform answers by dropping
    // the rule, which would read as a rule that is present and matches nothing.
    for (const extension of DOCUMENT_ASSET_EXTENSIONS) {
      expect(headers).toContain(
        `/*.${extension}\n  Content-Disposition: attachment\n  X-Content-Type-Options: nosniff`,
      )
    }
  })

  test('should leave the types a browser cannot render as a document alone', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const headers = readFileSync(join(root, '.cloudflare/assets/_headers'), 'utf8')
    // The whole point of the disposition is that subresources keep loading;
    // a rule reaching scripts, stylesheets or images would break the app.
    expect(headers).not.toContain('/*.js')
    expect(headers).not.toContain('/*.css')
    expect(headers).not.toContain('/*.png')
  })

  test('should keep an app-authored _headers and rule ahead of it', async () => {
    scaffoldApp(root)
    writeFileSync(join(root, 'public/_headers'), '/*\n  X-Frame-Options: DENY\n')

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const headers = readFileSync(join(root, '.cloudflare/assets/_headers'), 'utf8')
    expect(headers).toContain('X-Frame-Options: DENY')
    // Only the first rule naming a header sets it, so going second would turn
    // an app's own Content-Disposition into "inline, attachment".
    expect(headers.indexOf('Content-Disposition: attachment')).toBeLessThan(
      headers.indexOf('X-Frame-Options: DENY'),
    )
  })

  test('should name html_handling for a config that predates it', async () => {
    scaffoldApp(root)
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'legacy',
      main: '.cloudflare/worker.js',
      assets: { directory: '.cloudflare/assets' },
    })

    const warning = await captureWarnings(async () => {
      await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })
    })

    expect(warning).toContain('"html_handling": "none" (inside "assets")')
  })

  test('should leave an app that named another html_handling alone', async () => {
    scaffoldApp(root)
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'legacy',
      main: '.cloudflare/worker.js',
      // Typed by hand, so it is a decision rather than an omission — the
      // /*.html rule is weaker for it, and that is the app's call to make.
      assets: { directory: '.cloudflare/assets', html_handling: 'auto-trailing-slash' },
    })

    const warning = await captureWarnings(async () => {
      await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })
    })

    expect(warning).not.toContain('html_handling')
  })

  test('should serve staged HTML at its own path so the html rule is not vacuous', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))
    // The platform default serves public/page.html at /page and redirects
    // /page.html there, so the /*.html rule would only ever land on the
    // redirect and the document itself would stay inline.
    expect(config.assets.html_handling).toBe('none')
  })
})

describe('flattenD1Migrations', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-migrations-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('should flatten drizzle-kit folder migrations into wrangler-visible sql files', async () => {
    scaffoldApp(root)
    mkdirSync(join(root, 'db/migrations/20260725064448_third_storm'), { recursive: true })
    writeFileSync(
      join(root, 'db/migrations/20260725064448_third_storm/migration.sql'),
      'CREATE TABLE `posts` (`id` integer PRIMARY KEY);\n',
    )
    mkdirSync(join(root, 'db/migrations/meta'), { recursive: true })
    writeFileSync(join(root, 'db/migrations/meta/_journal.json'), '{}')
    writeFileSync(join(root, 'db/migrations/0000_flat_legacy.sql'), 'SELECT 1;\n')

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const flattened = join(root, '.cloudflare/d1-migrations')
    expect(readFileSync(join(flattened, '20260725064448_third_storm.sql'), 'utf8')).toContain('CREATE TABLE')
    expect(readFileSync(join(flattened, '0000_flat_legacy.sql'), 'utf8')).toContain('SELECT 1')
    expect(existsSync(join(flattened, 'meta'))).toBe(false)

    const wrangler = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))
    expect(wrangler.d1_databases[0].migrations_dir).toBe('.cloudflare/d1-migrations')
  })

  test('should emit no directory when there are no migrations', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    expect(existsSync(join(root, '.cloudflare/d1-migrations'))).toBe(false)
  })
})

describe('workers runtime configuration', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-config-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('should alias dev-only modules to generated stubs and define NODE_ENV', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))
    expect(config.alias['bun:sqlite']).toBe('./.cloudflare/stub-bun-sqlite.js')
    expect(config.alias.vite).toBe('./.cloudflare/stub-vite.js')
    expect(config.alias['@guren/cli']).toBe('./.cloudflare/stub-guren-cli.js')
    // The SDK is only ever imported through subpaths, which a package-name
    // alias does not cover.
    expect(config.alias['@modelcontextprotocol/sdk/server/mcp.js']).toBeDefined()
    expect(config.define['process.env.NODE_ENV']).toBe('"production"')

    expect(readFileSync(join(root, '.cloudflare/stub-bun-sqlite.js'), 'utf8')).toContain('throw new Error')
    expect(existsSync(join(root, '.cloudflare/stub-vite.js'))).toBe(true)

    // The regression hold for the App MCP change: an app that did not ask for
    // the endpoint keeps every stub it had.
    expect(config.alias[MCP_TRANSPORT_SPECIFIER]).toBe('./.cloudflare/stub-mcp-transport.js')
  })

  test('should leave the App MCP transport unaliased for an app depending on the plugin', async () => {
    scaffoldApp(root, { mcpPlugin: true })

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))
    // The alias was the only thing killing the endpoint on Workers; the
    // adapter itself is workerd-compatible (RFC 0016 §7).
    expect(config.alias[MCP_TRANSPORT_SPECIFIER]).toBeUndefined()
    // Everything else is unchanged — the Dev MCP's McpServer generates files
    // on disk and must stay compiled shut whatever the app depends on.
    expect(config.alias['@modelcontextprotocol/sdk/server/mcp.js']).toBe('./.cloudflare/stub-mcp-server.js')
    expect(config.alias['@guren/cli']).toBe('./.cloudflare/stub-guren-cli.js')
    expect(config.alias['bun:sqlite']).toBe('./.cloudflare/stub-bun-sqlite.js')
    expect(config.alias.vite).toBe('./.cloudflare/stub-vite.js')
    expect(config.alias.postgres).toBe('./.cloudflare/stub-postgres.js')

    // The stub file is still written: an app whose committed config predates
    // this version keeps pointing at it.
    expect(existsSync(join(root, '.cloudflare/stub-mcp-transport.js'))).toBe(true)
  })

  test('should not suggest the transport alias when warning an MCP app about a stale config', async () => {
    scaffoldApp(root, { mcpPlugin: true })
    // A config predating the build-owned keys entirely, with no alias at all —
    // so the warning names every entry it is missing.
    writeFileSync(join(root, 'wrangler.jsonc'), '{ "name": "legacy" }\n')

    const warning = await captureWarnings(() =>
      buildCloudflareOutput({ rootDir: root, skipAppBuild: true }),
    )

    expect(warning).toContain('@modelcontextprotocol/sdk/server/mcp.js')
    // Suggesting the transport alias would talk this app into the very stub
    // the guard below fails on.
    expect(warning).not.toContain(MCP_TRANSPORT_SPECIFIER)
  })

  test('should define import.meta.url so module-scope URL resolution survives', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    // Both Vite's createRequire(import.meta.url) and scaffolded
    // new URL(..., import.meta.url) run at module scope; workerd leaves the
    // value undefined and the worker never starts without this.
    const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))
    expect(config.define['import.meta.url']).toBe('"file:///worker.js"')
  })

  test('should warn when an existing wrangler config lacks build-owned keys', async () => {
    scaffoldApp(root)
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'legacy',
      main: '.cloudflare/worker.js',
      d1_databases: [{ binding: 'DB', migrations_dir: 'db/migrations' }],
    })
    const warning = await captureWarnings(async () => {
      await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })
    })

    expect(warning).toContain('alias')
    expect(warning).toContain('process.env.NODE_ENV')
    expect(warning).toContain('.cloudflare/d1-migrations')
  })

  test('should warn about a missing alias in a config carrying comments and trailing commas', async () => {
    scaffoldApp(root)
    const configPath = join(root, 'wrangler.jsonc')

    // Scaffold first, then take one alias back out — the expectation is
    // derived from the alias map the build itself owns, so this test keeps
    // holding as that list grows.
    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })
    const scaffolded = JSON.parse(readFileSync(configPath, 'utf8'))
    const [dropped, ...kept] = Object.keys(scaffolded.alias)
    const alias = {
      ...Object.fromEntries(kept.map((key) => [key, scaffolded.alias[key]])),
      // An app's own alias, the kind the suggestion must not read as
      // something to paste over.
      shiki: './stubs/shiki.js',
    }

    // Every JSONC hazard a real config carries: a line comment, a block
    // comment, a trailing comma, `//` inside a string, and escaped quotes.
    writeFileSync(
      configPath,
      `{
  // Kept by the app, not the build.
  "name": "legacy",
  "main": ".cloudflare/worker.js",
  /* The build owns these. */
  "alias": ${JSON.stringify(alias, null, 2)},
  "define": {
    "process.env.NODE_ENV": "\\"production\\"",
    "import.meta.url": "\\"file:///worker.js\\"",
  },
  "d1_databases": [
    {
      "binding": "DB",
      "migrations_dir": ".cloudflare/d1-migrations",
    },
  ],
}
`,
    )

    const warning = await captureWarnings(async () => {
      await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })
    })

    expect(warning).toContain(dropped)
    // A stripper that mangled `"\"file:///worker.js\""` or the escaped quotes
    // around `"production"` would either fail to parse — losing the alias line
    // above — or report `define` as missing when the file has it.
    expect(warning).not.toContain('process.env.NODE_ENV')
    expect(warning).not.toContain('could not parse')
    // Only the missing entry is suggested, so nothing the file already has —
    // the app's own `shiki` stub included — is named. A suggestion carrying
    // those entries reads as an object to paste over `alias`, which would
    // drop the ones the build does not own.
    for (const [specifier, target] of Object.entries(alias)) {
      expect(warning).not.toContain(specifier)
      expect(warning).not.toContain(target)
    }
  })

  test('should warn rather than throw when alias is not an object', async () => {
    scaffoldApp(root)
    // Malformed rather than outdated. `in` on a string throws, and this
    // warning runs inside the scaffold's catch block, so the TypeError would
    // escape as a build failure instead of the guidance the check exists for.
    writeFileSync(join(root, 'wrangler.jsonc'), '{ "name": "legacy", "alias": "./stubs" }\n')

    const warning = await captureWarnings(async () => {
      await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })
    })

    expect(warning).toContain('bun:sqlite')
  })

  test('should stay silent when a commented config already has every build-owned key', async () => {
    scaffoldApp(root)
    const configPath = join(root, 'wrangler.jsonc')

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })
    const scaffolded = readFileSync(configPath, 'utf8')
    writeFileSync(configPath, `// An app comment, added after scaffolding.\n${scaffolded}`)

    const warning = await captureWarnings(async () => {
      await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })
    })

    expect(warning).toBe('')
  })

  test('should report a config it cannot parse rather than skipping the check', async () => {
    scaffoldApp(root)
    writeFileSync(join(root, 'wrangler.jsonc'), '{ "name": "legacy", oops }\n')

    const warning = await captureWarnings(async () => {
      await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })
    })

    expect(warning).toContain('could not parse')
  })

  test('should write a stub file for every aliased specifier', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    // The alias map and the files on disk are derived from one list but through
    // two code paths; a stub the config points at but the build never writes
    // fails only at `wrangler deploy`.
    const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))
    const aliases = Object.values(config.alias) as string[]
    expect(aliases.length).toBeGreaterThan(0)
    for (const target of aliases) {
      expect(existsSync(join(root, target.replace(/^\.\//, '')))).toBe(true)
    }
  })

  test('should reject migrations that flatten to the same filename', async () => {
    scaffoldApp(root)
    mkdirSync(join(root, 'db/migrations/0000_clash'), { recursive: true })
    writeFileSync(join(root, 'db/migrations/0000_clash/migration.sql'), 'SELECT 1;')
    writeFileSync(join(root, 'db/migrations/0000_clash.sql'), 'SELECT 2;')

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /both flatten to/,
    )
  })
})

describe('buildCloudflareOutput with a stale committed wrangler.jsonc', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-mcp-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** A config carrying the alias set as scaffolded before the app added the plugin. */
  function writeStaleConfig(root: string, extra = ''): void {
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      `{\n${extra}  "name": "legacy",\n  "main": ".cloudflare/worker.js",\n  "alias": {\n`
        + `    "bun:sqlite": "./.cloudflare/stub-bun-sqlite.js",\n`
        + `    ${JSON.stringify(MCP_TRANSPORT_SPECIFIER)}: "./.cloudflare/stub-mcp-transport.js"\n`
        + `  }\n}\n`,
    )
  }

  test('should fail and name the alias line to delete', async () => {
    scaffoldApp(root, { mcpPlugin: true })
    writeStaleConfig(root)

    // The scaffold never overwrites an existing config, so this alias would
    // otherwise survive every build and deploy the endpoint compiled shut,
    // with nothing red anywhere.
    const error = await buildCloudflareOutput({ rootDir: root, skipAppBuild: true }).catch(
      (thrown: Error) => thrown,
    )

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('@guren/plugin-mcp')
    // The exact line, so the fix is an edit rather than a search.
    expect(message).toContain(
      `${JSON.stringify(MCP_TRANSPORT_SPECIFIER)}: "./.cloudflare/stub-mcp-transport.js"`,
    )
    // And the one entry that must survive the edit.
    expect(message).toContain('@modelcontextprotocol/sdk/server/mcp.js')
  })

  test('should fail on generated residue under a custom output directory', async () => {
    scaffoldApp(root, { mcpPlugin: true })
    // Same residue, different outputDir — the alias target is a path this
    // build chose, so matching the whole of it would miss every app that
    // moved its output.
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      `{\n  "name": "legacy",\n  "alias": {\n`
        + `    ${JSON.stringify(MCP_TRANSPORT_SPECIFIER)}: "./dist/cf/stub-mcp-transport.js"\n`
        + `  }\n}\n`,
    )

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /@guren\/plugin-mcp/,
    )
  })

  test('should leave an alias pointing at the developer own shim alone', async () => {
    scaffoldApp(root, { mcpPlugin: true })
    // An alias on this specifier is only *build residue* when it names the
    // stub file this build writes. Pointing it somewhere else is a deliberate
    // override — an alternative transport, an instrumented wrapper — and
    // failing on it would refuse a config with nothing wrong with it, while
    // claiming in the message that a stub is there when it is not.
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      `{\n  "name": "legacy",\n  "alias": {\n`
        + `    ${JSON.stringify(MCP_TRANSPORT_SPECIFIER)}: "./shims/my-transport.js"\n`
        + `  }\n}\n`,
    )

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    expect(existsSync(join(root, '.cloudflare/worker.js'))).toBe(true)
  })

  test('should leave a non-string alias target alone', async () => {
    scaffoldApp(root, { mcpPlugin: true })
    // Malformed rather than stale, and this guard exists to name one editable
    // line — it cannot name one in a value that is not a path.
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      `{\n  "name": "legacy",\n  "alias": { ${JSON.stringify(MCP_TRANSPORT_SPECIFIER)}: 42 }\n}\n`,
    )

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    expect(existsSync(join(root, '.cloudflare/worker.js'))).toBe(true)
  })

  test('should build normally when the app does not depend on the plugin', async () => {
    scaffoldApp(root)
    writeStaleConfig(root)

    // Without the plugin the alias is correct, not stale — a guard that fired
    // here would break every app that has ever deployed to Workers.
    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    expect(existsSync(join(root, '.cloudflare/worker.js'))).toBe(true)
  })

  test('should not fail on the alias line commented out rather than deleted', async () => {
    scaffoldApp(root, { mcpPlugin: true })
    // What a developer following the failure message actually leaves behind:
    // the line commented out, not deleted. Both the specifier and the stub
    // filename are still in the file, so a guard that matched the text rather
    // than the parsed keys would fail this build permanently, with the
    // instruction it prints already carried out.
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      `{\n  "name": "legacy",\n  "main": ".cloudflare/worker.js",\n  "alias": {\n`
        + `    "bun:sqlite": "./.cloudflare/stub-bun-sqlite.js",\n`
        + `    // Removed for the App MCP endpoint (RFC 0016):\n`
        + `    // ${JSON.stringify(MCP_TRANSPORT_SPECIFIER)}: "./.cloudflare/stub-mcp-transport.js"\n`
        + `  }\n}\n`,
    )

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    expect(existsSync(join(root, '.cloudflare/worker.js'))).toBe(true)
  })

  test('should build rather than fail when the config cannot be parsed', async () => {
    scaffoldApp(root, { mcpPlugin: true })
    writeFileSync(join(root, 'wrangler.jsonc'), '{ "name": "legacy", "alias": ')

    // Unreadable is not evidence of a stale alias, and the existing
    // build-owned-keys warning already reports the file.
    const warning = await captureWarnings(() =>
      buildCloudflareOutput({ rootDir: root, skipAppBuild: true }),
    )

    expect(existsSync(join(root, '.cloudflare/worker.js'))).toBe(true)
    expect(warning).toContain('could not parse')
  })
})
