import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEV_ONLY_MODULES, SQL_CLIENT_MODULES } from '@guren/core/internal/deploy-build'

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
// gated behind GUREN_TEST_WRANGLER=1 and skipped in CI, like
// wrangler-migrations.test.ts.
const enabled = process.env.GUREN_TEST_WRANGLER === '1'

/** Installed directories that would let wrangler resolve a client for real. */
const DRIVER_PACKAGES = ['postgres', 'mysql2', '@aws-sdk']

function wrangler(cwd: string, args: string[]): { exitCode: number; output: string } {
  const result = Bun.spawnSync({ cmd: ['bunx', 'wrangler', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  return { exitCode: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` }
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
    const stubbed = [...DEV_ONLY_MODULES, ...SQL_CLIENT_MODULES]
    const alias: Record<string, string> = {}
    for (const module of stubbed) {
      const file = `${module.specifier.replace(/[^a-zA-Z0-9]+/g, '-')}.js`
      const throwing = module.exportNames
        .map((name) => `export function ${name}() { throw new Error('stubbed') }`)
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
        name: 'bundle-probe',
        main: 'worker.ts',
        compatibility_date: '2026-07-01',
        compatibility_flags: ['nodejs_compat'],
        alias,
      }),
    )
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
