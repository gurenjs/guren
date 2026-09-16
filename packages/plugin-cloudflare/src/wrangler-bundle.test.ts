import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEV_ONLY_MODULES,
  SQL_CLIENT_MODULES,
  stubbableDevOnlyModules,
} from '@guren/core/internal/deploy-build'
import type { Miniflare } from 'miniflare'

// Opt-in end-to-end contract test: proves wrangler can bundle a worker that
// imports `@guren/orm` with only the stubs `cloudflare:build` scaffolds and no
// database client installed. `@guren/orm` names every dialect's client in a
// *literal* dynamic import, which a bundler follows whether or not the branch can
// be taken. Gated behind GUREN_TEST_WRANGLER=1 (downloads wrangler and workerd).
const enabled = process.env.GUREN_TEST_WRANGLER === '1'

/** Installed directories that would let wrangler resolve a client for real. */
const DRIVER_PACKAGES = ['postgres', 'mysql2', '@aws-sdk']

function wrangler(cwd: string, args: string[]): { exitCode: number; output: string } {
  const result = Bun.spawnSync({ cmd: ['bunx', 'wrangler', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  return { exitCode: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` }
}

/** As much of a `DEV_ONLY_MODULES` / `SQL_CLIENT_MODULES` entry as a stub needs. */
type StubbedModule = { specifier: string; exportNames: readonly string[] }

/**
 * Write the stub files and the `wrangler.jsonc` aliasing `modules` to them —
 * what `cloudflare:build` scaffolds, written directly so a probe pins the
 * contract rather than the command that emits it. Which modules a probe passes
 * is the whole variable: the App MCP probe stubs what `cloudflare:build` stubs
 * for an app declaring the plugin, then that plus the SDK itself.
 */
function writeWranglerConfig(root: string, name: string, modules: readonly StubbedModule[]): void {
  mkdirSync(join(root, 'stubs'), { recursive: true })

  const alias: Record<string, string> = {}
  for (const module of modules) {
    const file = `${module.specifier.replace(/[^a-zA-Z0-9]+/g, '-')}.js`
    const throwing = module.exportNames
      .map((exportName) => `export function ${exportName}() { throw new Error('stubbed') }`)
      .join('\n')
    const named = module.exportNames.length > 0 ? `, { ${module.exportNames.join(', ')} }` : ''
    writeFileSync(
      join(root, 'stubs', file),
      `${throwing}\nfunction unavailable() { throw new Error('stubbed') }\nexport default Object.assign(unavailable${named})\n`,
    )
    alias[module.specifier] = `./stubs/${file}`
  }

  writeFileSync(
    join(root, 'wrangler.jsonc'),
    JSON.stringify({
      name,
      main: 'worker.ts',
      compatibility_date: '2026-07-01',
      compatibility_flags: ['nodejs_compat'],
      alias,
    }),
  )
}

describe.skipIf(!enabled)('wrangler bundles a worker importing @guren/orm', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-wrangler-bundle-'))
    mkdirSync(join(root, 'stubs'), { recursive: true })

    // Only @guren/orm — no `postgres`, no `mysql2`, no AWS Data API client,
    // which is what a D1 app actually installs.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'bundle-probe', type: 'module', private: true }),
    )
    // Installed from a tarball, not `file:` — a local path install links the
    // package, and resolution then walks out of the probe into this repository's
    // own `node_modules`, where the database clients *are* installed. That made
    // an earlier version measure the monorepo rather than the app.
    const ormDir = new URL('../../orm', import.meta.url).pathname
    const packed = Bun.spawnSync({
      cmd: ['bun', 'pm', 'pack', '--destination', root],
      cwd: ormDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (packed.exitCode !== 0) {
      throw new Error(`bundle probe could not pack @guren/orm:\n${packed.stderr.toString()}`)
    }
    const tarball = readdirSync(root).find((file) => file.endsWith('.tgz'))
    if (!tarball) {
      throw new Error(`bundle probe found no tarball in ${root}`)
    }
    const install = Bun.spawnSync({
      cmd: ['bun', 'add', join(root, tarball)],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (install.exitCode !== 0) {
      // Without this the bundle fails on `@guren/orm` itself and the test
      // reports the very symptom it is meant to detect, for the wrong reason.
      throw new Error(`bundle probe setup failed to install @guren/orm:\n${install.stderr.toString()}`)
    }

    // A real D1 app installs no database client, so neither does the probe.
    // Asserted rather than assumed: an installer that pulled the ORM's optional
    // peers in would let wrangler resolve them whatever the stubs say.
    for (const client of DRIVER_PACKAGES) {
      rmSync(join(root, 'node_modules', client), { recursive: true, force: true })
      if (existsSync(join(root, 'node_modules', client))) {
        throw new Error(`bundle probe still has ${client} installed; the test would pass vacuously`)
      }
    }

    writeFileSync(
      join(root, 'worker.ts'),
      `import { createD1Database } from '@guren/orm'\n`
        + `export default {\n`
        + `  async fetch(_r: Request, env: { DB: unknown }): Promise<Response> {\n`
        + `    return new Response(typeof createD1Database({ binding: () => env.DB }).getDatabase)\n`
        + `  },\n`
        + `}\n`,
    )

    writeWranglerConfig(root, 'bundle-probe', [...DEV_ONLY_MODULES, ...SQL_CLIENT_MODULES])
  })

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test(
    'resolves every module the ORM reaches for, with no database client installed',
    () => {
      const result = wrangler(root, ['deploy', '--dry-run', '--outdir', join(root, 'out')])

      // Name what is missing rather than only that something is: the failure
      // mode this guards against reports a package the app never chose.
      expect(result.output).not.toMatch(/Could not resolve/)
      expect(result.exitCode).toBe(0)
    },
    180_000,
  )
})

/**
 * The free plan's compressed worker limit: 3 MiB of gzipped upload. A byte count
 * because the RFC's prose "3 MB" is loose about MB vs MiB.
 */
const FREE_PLAN_GZIP_BUDGET = 3 * 1024 * 1024

/** Extensions that count toward the upload; sourcemaps do not, and dwarf it. */
const UPLOADED_EXTENSIONS = ['.js', '.mjs', '.wasm']

/** A package of this workspace, as the probe vendors it: its directory and manifest. */
type WorkspacePackage = { dir: string; manifest: Record<string, unknown> }

/**
 * The `@guren/*` packages a probe must resolve from this checkout, derived
 * rather than listed: seed with the one the worker imports and close over the
 * workspace `dependencies`. A hand-kept list is how a package comes to be
 * installed from npm and silently verified in its *published* form instead (see
 * `scripts/smoke/local-packages.ts`, the same rule for the smokes).
 */
function workspaceClosure(seed: string): Map<string, WorkspacePackage> {
  const packagesDir = new URL('../../', import.meta.url).pathname
  const byName = new Map<string, WorkspacePackage>()
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(packagesDir, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    byName.set(manifest.name as string, { dir: join(packagesDir, entry.name), manifest })
  }

  const closure = new Map<string, WorkspacePackage>()
  const queue = [seed]
  while (queue.length > 0) {
    const name = queue.shift() as string
    if (closure.has(name)) continue
    const found = byName.get(name)
    if (!found) {
      throw new Error(`bundle probe: ${name} is not a package in this workspace`)
    }
    closure.set(name, found)
    for (const dep of Object.keys((found.manifest.dependencies ?? {}) as Record<string, string>)) {
      if (dep.startsWith('@guren/')) queue.push(dep)
    }
  }

  return closure
}

/**
 * Install a probe's third-party dependencies from npm and vendor this checkout's
 * `@guren/*` packages over them, flat, by copy: `bun add` of a tarball leaves the
 * packages' own `@guren/*` ranges to npm, which nests published copies under each
 * vendored package (measured). `extra` adds dependencies no `@guren/*` manifest
 * declares. The two loops at the end assert no package resolves *out* of the closure.
 */
function vendorClosure(
  root: string,
  name: string,
  closure: Map<string, WorkspacePackage>,
  options: { required?: readonly string[]; extra?: Record<string, string> } = {},
): void {
  const thirdParty: Record<string, string> = { ...options.extra }
  for (const { manifest } of closure.values()) {
    for (const [dep, range] of Object.entries((manifest.dependencies ?? {}) as Record<string, string>)) {
      if (!dep.startsWith('@guren/')) thirdParty[dep] = range
    }
  }

  for (const required of options.required ?? []) {
    if (!thirdParty[required]) {
      throw new Error(`bundle probe: no ${required} in the closure; the probe would measure nothing`)
    }
  }

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name, type: 'module', private: true, dependencies: thirdParty }),
  )
  const install = Bun.spawnSync({ cmd: ['bun', 'install'], cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (install.exitCode !== 0) {
    throw new Error(`bundle probe setup failed to install dependencies:\n${install.stderr.toString()}`)
  }

  for (const [packageName, { dir, manifest }] of closure) {
    const dist = join(dir, 'dist')
    if (!existsSync(dist)) {
      throw new Error(`bundle probe: ${packageName} has no dist/; run \`bun run build\` first`)
    }
    const target = join(root, 'node_modules', packageName)
    mkdirSync(target, { recursive: true })
    cpSync(dist, join(target, 'dist'), { recursive: true })
    const { dependencies, devDependencies, peerDependencies, ...rest } = manifest
    writeFileSync(join(target, 'package.json'), JSON.stringify(rest))
  }

  for (const packageName of [...closure.keys(), ...(options.required ?? []), ...Object.keys(options.extra ?? {})]) {
    if (!existsSync(join(root, 'node_modules', packageName))) {
      throw new Error(`bundle probe: ${packageName} did not land in the probe's node_modules`)
    }
  }
  for (const packageName of closure.keys()) {
    if (existsSync(join(root, 'node_modules', packageName, 'node_modules'))) {
      throw new Error(`bundle probe: ${packageName} has nested node_modules; it would resolve a second copy`)
    }
  }
}

describe.skipIf(!enabled)('wrangler bundles a worker importing @guren/plugin-mcp', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-wrangler-mcp-'))

    const closure = workspaceClosure('@guren/plugin-mcp')

    // Every third-party dependency of the closure, flattened to the top level.
    vendorClosure(root, 'mcp-bundle-probe', closure, {
      // The real SDK from npm: what the endpoint costs is what this reports.
      required: ['@modelcontextprotocol/server'],
    })

    writeFileSync(
      join(root, 'worker.ts'),
      `import { mcpPlugin } from '@guren/plugin-mcp'\n`
        + `export default {\n`
        + `  async fetch(): Promise<Response> {\n`
        + `    return new Response(typeof mcpPlugin)\n`
        + `  },\n`
        + `}\n`,
    )
  })

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  /**
   * Bundle the probe with `modules` stubbed and report the gzipped bytes
   * wrangler would upload. Gzipped here rather than parsed out of wrangler's own
   * "Total Upload / gzip" line, which is prose and can be reworded. Sourcemaps
   * are excluded: the `.map` is several times the bundle's size and the limit
   * does not count it.
   */
  function bundleSize(label: string, modules: readonly StubbedModule[]): number {
    writeWranglerConfig(root, 'mcp-bundle-probe', modules)
    const out = join(root, `out-${label}`)
    const result = wrangler(root, ['deploy', '--dry-run', '--outdir', out])

    // Name what is missing rather than only that something is: with the
    // transport unstubbed, a failed resolve reports the SDK subpath by name.
    expect(result.output).not.toMatch(/Could not resolve/)
    expect(result.exitCode).toBe(0)

    let gzipped = 0
    let files = 0
    for (const file of readdirSync(out)) {
      if (!UPLOADED_EXTENSIONS.some((extension) => file.endsWith(extension))) continue
      gzipped += Bun.gzipSync(readFileSync(join(out, file))).byteLength
      files += 1
    }

    // A worker with nothing measured passes any budget.
    expect(files).toBeGreaterThan(0)

    console.log(
      `App MCP probe [${label}]: ${(gzipped / 1024).toFixed(1)} KiB gzipped over ${files} file(s) — `
        + result.output.split('\n').find((line) => line.includes('Total Upload'))?.trim(),
    )

    return gzipped
  }

  test(
    'bundles the App MCP SDK and stays inside the free-plan budget',
    () => {
      // Everything `cloudflare:build` stubs for an app that declares
      // `@guren/plugin-mcp`.
      const deployed = [...stubbableDevOnlyModules({ mcpPlugin: true }), ...SQL_CLIENT_MODULES]
      const served = bundleSize('sdk-served', deployed)
      // And the same worker with the SDK v2 root stubbed under the names
      // plugin-mcp imports. "The bundle resolves" cannot tell the two apart, so
      // the size difference is the only proof the real SDK reached the worker.
      const stubbed = bundleSize('sdk-stubbed', [
        ...deployed,
        { specifier: '@modelcontextprotocol/server', exportNames: ['createMcpHandler', 'Server'] },
      ])

      console.log(
        `App MCP SDK costs ${((served - stubbed) / 1024).toFixed(1)} KiB gzipped `
          + `(${((served / FREE_PLAN_GZIP_BUDGET) * 100).toFixed(1)}% of the ${FREE_PLAN_GZIP_BUDGET / 1024 / 1024} MiB free-plan budget used in total)`,
      )

      expect(served).toBeGreaterThan(stubbed)
      expect(served).toBeLessThan(FREE_PLAN_GZIP_BUDGET)
    },
    300_000,
  )
})

/**
 * The App MCP endpoint answering under workerd (RFC 0028 §5): bundling proves only
 * that the SDK resolves, and v2's server selects its `workerd` shims at runtime.
 * A real app with a token store serves both protocol eras through Miniflare, the
 * bundle being what `wrangler deploy` would upload with `cloudflare:build`'s stubs.
 */
describe.skipIf(!enabled)('workerd serves the App MCP endpoint', () => {
  let root: string
  let mf: Miniflare | undefined

  const WORKER = `import { createApp, createApiToken, EventServiceProvider, MemoryApiTokenStore, type Application, type Router } from '@guren/core'
import { mcpPlugin } from '@guren/plugin-mcp'

// workerd forbids I/O, crypto and timers at module scope, so the app, its boot
// and the probe's token all wait for the first request.
let ready: Promise<{ app: Application; token: string }> | undefined

async function start(): Promise<{ app: Application; token: string }> {
  const store = new MemoryApiTokenStore()
  const app = createApp({
    routes: (router: Router) => {
      router
        .get('/tenant', (c) => Response.json({ tenant: (c.env as { TENANT?: string }).TENANT ?? null }))
        .name('tenant.show')
        .agent({ description: 'Echo the tenant binding' })
    },
    providers: [EventServiceProvider, mcpPlugin({ rateLimit: false })],
  })
  app.auth.useTokens(store)
  await app.boot()
  const { plainTextToken } = await createApiToken(store, { name: 'probe', userId: 1, abilities: ['tools:*'] })
  return { app, token: plainTextToken }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    const { app, token } = await (ready ??= start())
    if (new URL(request.url).pathname === '/_probe/token') return new Response(token)
    return app.fetch(request, env as never, ctx as never)
  },
}
`

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'guren-workerd-mcp-'))
    vendorClosure(root, 'mcp-workerd-probe', workspaceClosure('@guren/plugin-mcp'), {
      required: ['@modelcontextprotocol/server'],
    })
    writeFileSync(join(root, 'worker.ts'), WORKER)
    writeWranglerConfig(root, 'mcp-workerd-probe', [
      ...stubbableDevOnlyModules({ mcpPlugin: true }),
      ...SQL_CLIENT_MODULES,
    ])

    const out = join(root, 'out')
    const result = wrangler(root, ['deploy', '--dry-run', '--outdir', out])
    expect(result.output).not.toMatch(/Could not resolve/)
    expect(result.exitCode).toBe(0)

    const { Miniflare } = await import('miniflare')
    mf = new Miniflare({
      // Contents rather than a path: Miniflare's module walk refuses the bundle's
      // computed `import()`, and a path under the temp directory fails workerd's
      // start with "internal error" even for a one-line worker.
      modules: [{ type: 'ESModule', path: 'worker.js', contents: readFileSync(join(out, 'worker.js'), 'utf8') }],
      compatibilityDate: '2026-07-01',
      compatibilityFlags: ['nodejs_compat'],
      bindings: { TENANT: 'acme' },
    })
  }, 300_000)

  afterAll(async () => {
    await mf?.dispose()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  const serve = async (request: Request): Promise<Response> =>
    (await mf!.dispatchFetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.body ? await request.text() : undefined,
    })) as unknown as Response

  for (const era of ['modern', 'legacy'] as const) {
    test(`answers a ${era} client`, async () => {
      const token = await (await serve(new Request('http://localhost/_probe/token'))).text()
      const client = new Client(
        { name: `workerd-${era}`, version: '1.0.0' },
        era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
      )
      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
          fetch: (input, init) => serve(new Request(input, init)),
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      )

      expect(client.getProtocolEra()).toBe(era)
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toContain('tenant.show')

      const result = await client.callTool({ name: 'tenant.show', arguments: {} })
      const [first] = result.content as Array<{ text?: string }>
      // The binding crossed workerd's env into the re-entrant request.
      expect(JSON.parse(first?.text ?? '')).toEqual({ tenant: 'acme' })

      await client.close()
    }, 60_000)
  }
})

/**
 * The OAuth-fronted worker `cloudflare:build --mcp-oauth` generates, bundled for
 * real. Only this can answer whether `@guren/plugin-mcp/oauth` resolves from an
 * *installed* copy (nothing in this repository imports that subpath) and whether
 * `@cloudflare/workers-oauth-provider` is workerd-compatible, which the build
 * assumes. The worker source is the generator's own output, never a pinned copy.
 */
describe.skipIf(!enabled)('wrangler bundles the --mcp-oauth worker', () => {
  let root: string

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'guren-wrangler-oauth-'))

    vendorClosure(root, 'mcp-oauth-bundle-probe', workspaceClosure('@guren/plugin-mcp'), {
      required: ['@modelcontextprotocol/server'],
      // No `@guren/*` manifest declares it — a real app installs it itself,
      // which is exactly what the build's guard demands.
      extra: { '@cloudflare/workers-oauth-provider': '^0.10.3' },
    })

    // The generated worker imports `createWorkersHandler` from this package,
    // which is not in @guren/plugin-mcp's closure. Vendored the same way.
    const self = new URL('../', import.meta.url).pathname
    const target = join(root, 'node_modules', '@guren/plugin-cloudflare')
    mkdirSync(target, { recursive: true })
    cpSync(join(self, 'dist'), join(target, 'dist'), { recursive: true })
    const manifest = JSON.parse(readFileSync(join(self, 'package.json'), 'utf8')) as Record<string, unknown>
    const { dependencies, devDependencies, peerDependencies, ...rest } = manifest
    writeFileSync(join(target, 'package.json'), JSON.stringify(rest))

    // A minimal app entry the generated worker can import, and the client
    // manifest the generator reads, at the paths it looks for them.
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src/app.ts'), 'export default { boot: async () => {}, fetch: async () => new Response("ok") }\n')
    mkdirSync(join(root, 'public/assets/.vite'), { recursive: true })
    writeFileSync(join(root, 'public/assets/app.js'), 'console.log(1)\n')
    writeFileSync(
      join(root, 'public/assets/.vite/manifest.json'),
      JSON.stringify({ 'resources/js/app.tsx': { file: 'app.js' } }),
    )
    // The probe's package.json is the vendoring's, so the dependency guards
    // are satisfied by rewriting it rather than by a second install.
    const probeManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    probeManifest.dependencies['@guren/plugin-mcp'] = '*'
    writeFileSync(join(root, 'package.json'), JSON.stringify(probeManifest))

    const { buildCloudflareOutput } = await import('./build')
    await buildCloudflareOutput({
      rootDir: root,
      outputDir: join(root, 'cf-out'),
      skipAppBuild: true,
      mcpOAuth: true,
    })
  })

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test(
    'resolves the oauth subpath and the provider package',
    () => {
      // The build wrote its own wrangler.jsonc, aliases and all — including
      // the OAUTH_KV binding, whose placeholder id a dry run does not resolve.
      const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')) as Record<string, unknown>
      config.kv_namespaces = [{ binding: 'OAUTH_KV', id: '0'.repeat(32) }]
      delete config.d1_databases
      delete config.assets
      writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify(config))

      const out = join(root, 'out')
      const result = wrangler(root, ['deploy', '--dry-run', '--outdir', out])

      expect(result.output).not.toMatch(/Could not resolve/)
      expect(result.exitCode).toBe(0)

      const bundle = readdirSync(out)
        .filter((file) => file.endsWith('.js'))
        .map((file) => readFileSync(join(out, file), 'utf8'))
        .join('\n')

      // No deploy generator in the deployed worker. `Cloudflare build:` prefixes
      // every message `build.ts` emits and appears nowhere else, so its absence is
      // the assertion. Not proof the import graph is clean: the worker imports the
      // package root, which re-exports `buildCloudflareOutput`, and wrangler tree-
      // shakes it out. `tests/lean-env-subpath.test.ts` guards the unbundled dev path.
      expect(bundle).not.toContain('Cloudflare build:')
      // Which means something only if there is a real bundle to look at.
      expect(bundle).toContain('OAuthProvider')
      expect(bundle.length).toBeGreaterThan(1000)

      // The sweep is imported from the package root rather than emitted, and the
      // root also exports the deploy generator that the assertion above proves is
      // tree-shaken out. So the marker key is the evidence the shaker kept the
      // half that has to survive — a dropped sweep resolves and deploys fine.
      expect(bundle).toContain('guren:oauth-purge:last')
    },
    300_000,
  )
})
