import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEV_ONLY_MODULES,
  SQL_CLIENT_MODULES,
  stubbableDevOnlyModules,
} from '@guren/core/internal/deploy-build'

// Opt-in end-to-end contract test: proves wrangler can actually bundle a
// worker that imports `@guren/orm`, with only the stubs `cloudflare:build`
// scaffolds and none of the database clients installed.
//
// This is the gap that let a real defect ship. `@guren/orm` names every
// dialect's client in a *literal* dynamic import, and a bundler follows those
// whether or not the branch can be taken — so a D1 app failed on
// `Could not resolve "postgres"`, naming a database its author had not
// chosen. Nothing caught it: no gate ran wrangler over a scaffolded app, and
// the one Workers app in this repo carries a leftover `postgres` dependency
// from before it moved to D1, which masked the failure.
//
// Requires network on first run (bunx downloads wrangler + workerd), so it is
// gated behind GUREN_TEST_WRANGLER=1 rather than run on every PR, like
// wrangler-migrations.test.ts. The nightly canary sets the variable, so this
// does run — the gate it replaces was one nothing switched on at all.
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
 * contract rather than the command that emits it.
 *
 * Which modules a probe passes is the whole variable: the ORM probe below
 * stubs everything, and the App MCP probe stubs everything *except* the
 * transport, which is the configuration RFC 0016 Phase 4a produces.
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
    // package, and resolution then walks out of the probe into this
    // repository's own `node_modules`, where the database clients *are*
    // installed. That made an earlier version of this test pass with no stubs
    // at all: it was measuring the monorepo, not the app.
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
    // Asserted rather than assumed: if a future installer pulls the ORM's
    // optional peers in, wrangler would resolve them for real and this test
    // would pass no matter what the stubs say.
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

    // The stubs and aliases `cloudflare:build` scaffolds, written directly so
    // the test pins the contract rather than the command that emits it.
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
 * The free plan's compressed worker limit. Written as a byte count rather than
 * copied from the RFC's prose "3 MB", which is loose about MB vs MiB — the
 * platform's limit is 3 MiB of gzipped upload.
 */
const FREE_PLAN_GZIP_BUDGET = 3 * 1024 * 1024

/** Extensions that count toward the upload; sourcemaps do not, and dwarf it. */
const UPLOADED_EXTENSIONS = ['.js', '.mjs', '.wasm']

/** A package of this workspace, as the probe vendors it: its directory and manifest. */
type WorkspacePackage = { dir: string; manifest: Record<string, unknown> }

/**
 * The `@guren/*` packages a probe must resolve from this checkout, derived
 * rather than listed: seed with the one the worker imports and close over the
 * workspace `dependencies`. A package added to `@guren/plugin-mcp`'s graph
 * enters the probe by itself — a hand-kept list is how a package comes to be
 * installed from npm and silently verified in its *published* form instead
 * (see `scripts/smoke/local-packages.ts`, which owns the same rule for the
 * smokes).
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
 * Install a probe's third-party dependencies from npm and vendor this
 * checkout's `@guren/*` packages over them, flat.
 *
 * Vendoring the workspace packages by *copy* rather than by tarball is not a
 * shortcut: `bun add` of a tarball leaves the packages' own `@guren/*` ranges
 * to resolve, which npm satisfies with published copies nested under each
 * vendored package — measured directly, and a published `@guren/core` that
 * predates the change under test made the bundle fail on exports the checkout
 * has. Third-party deps are therefore flattened to the probe's top level and
 * the copied manifests have their ranges stripped.
 *
 * `required` names packages the probe would be measuring nothing without, and
 * `extra` adds dependencies no `@guren/*` manifest declares — the OAuth probe's
 * provider package, which a real app installs itself.
 *
 * The two loops at the end are the assertion the whole probe rests on: a
 * package resolving *out* of the probe measures this monorepo rather than an
 * installed app, which has reported a real bundle change as no change at all
 * before.
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

    // Every third-party dependency of the closure, flattened to the probe's
    // top level. Vendoring the workspace packages by *copy* rather than by
    // tarball is not a shortcut: `bun add` of a tarball leaves the packages'
    // own `@guren/*` ranges to resolve, which npm satisfies with published
    // copies nested under each vendored package — measured directly, and the
    // published `@guren/core` predates RFC 0016, so the bundle failed on
    // exports the checkout has.
    vendorClosure(root, 'mcp-bundle-probe', closure, {
      // The real SDK, from npm: what the transport actually costs is the
      // number this probe exists to report.
      required: ['@modelcontextprotocol/sdk'],
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
   * wrangler would upload.
   *
   * Gzipped here rather than parsed out of wrangler's own "Total Upload /
   * gzip" line — that line is prose and can be reworded — but printed beside
   * it so a human can reconcile the two. Sourcemaps are excluded: the `.map`
   * beside the bundle is several times its size and the limit does not count
   * it, so a whole-directory sum would fail for a file that never ships.
   */
  function bundleSize(label: string, modules: readonly StubbedModule[]): number {
    writeWranglerConfig(root, 'mcp-bundle-probe', modules)
    const out = join(root, `out-${label}`)
    const result = wrangler(root, ['deploy', '--dry-run', '--outdir', out])

    // Name what is missing rather than only that something is: with the
    // transport unstubbed, a bundle that cannot resolve reports the SDK
    // subpath by name.
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
    'bundles the App MCP transport and stays inside the free-plan budget',
    () => {
      // Everything `cloudflare:build` stubs for an app that declares
      // `@guren/plugin-mcp` — which is everything except the transport.
      const served = bundleSize('transport-served', [
        ...stubbableDevOnlyModules({ mcpPlugin: true }),
        ...SQL_CLIENT_MODULES,
      ])
      // And the same worker as every deploy plugin built it before RFC 0016
      // Phase 4a. Both are measured because "the bundle resolves" cannot tell
      // them apart: the stub declares the transport's export name, so the
      // stubbed configuration bundles perfectly well — it just deploys an
      // endpoint that throws. The size difference is the only observable
      // proof that the real transport reached the bundle, and it is also the
      // number the RFC asks this probe to report.
      const stubbed = bundleSize('transport-stubbed', [...DEV_ONLY_MODULES, ...SQL_CLIENT_MODULES])

      console.log(
        `App MCP transport costs ${((served - stubbed) / 1024).toFixed(1)} KiB gzipped `
          + `(${((served / FREE_PLAN_GZIP_BUDGET) * 100).toFixed(1)}% of the ${FREE_PLAN_GZIP_BUDGET / 1024 / 1024} MiB free-plan budget used in total)`,
      )

      expect(served).toBeGreaterThan(stubbed)
      expect(served).toBeLessThan(FREE_PLAN_GZIP_BUDGET)
    },
    300_000,
  )
})

/**
 * The OAuth-fronted worker `cloudflare:build --mcp-oauth` generates, bundled
 * for real.
 *
 * What only this can answer: whether `@guren/plugin-mcp/oauth` resolves from
 * an *installed* copy of the package. That subpath is imported by code which
 * exists nowhere in this repository — a worker generated into someone else's
 * app — so an `exports` entry or a `files` list that publishes the wrong thing
 * is invisible to every other gate, right up until a deploy cannot resolve it.
 * The bundle also proves `@cloudflare/workers-oauth-provider` itself is
 * workerd-compatible, which the build assumes and never checks.
 *
 * The worker source is the generator's own output, not a hand-written
 * approximation: `renderWorkerModule` is what deploys, and a probe pinning a
 * copy of it would keep passing after the generator changed.
 */
describe.skipIf(!enabled)('wrangler bundles the --mcp-oauth worker', () => {
  let root: string

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'guren-wrangler-oauth-'))

    vendorClosure(root, 'mcp-oauth-bundle-probe', workspaceClosure('@guren/plugin-mcp'), {
      required: ['@modelcontextprotocol/sdk'],
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

    // A minimal app entry the generated worker can import, and the generator's
    // own output around it.
    writeFileSync(
      join(root, 'app.js'),
      'export default { boot: async () => {}, fetch: async () => new Response("ok") }\n',
    )
    const { buildCloudflareOutput } = await import('./build')
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

    await buildCloudflareOutput({
      rootDir: root,
      outputDir: join(root, 'cf-out'),
      skipAppBuild: true,
      mcpOauth: true,
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

      const result = wrangler(root, ['deploy', '--dry-run', '--outdir', join(root, 'out')])

      expect(result.output).not.toMatch(/Could not resolve/)
      expect(result.exitCode).toBe(0)
    },
    300_000,
  )
})
