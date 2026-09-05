import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DATABASE_DIALECTS, type DatabaseDialect } from '@guren/core/internal/deploy-build'
import { buildLambdaOutput } from '../src/build'

// Opt-in contract test (GUREN_TEST_BUNDLE=1, network; the nightly canary sets it):
// `lambda:build` bundles an `@guren/orm` app with only its own database client.
// The ORM's *literal* dynamic import of every dialect's client is followed by a
// bundler regardless of branch. Postgres assertions matter as much as mysql2 —
// over-stubbing builds clean and cannot reach its database. Assert behaviour only.
const enabled = process.env.GUREN_TEST_BUNDLE === '1'

/**
 * Packages this probe must not have installed: the clients of dialects a
 * Postgres app never uses, plus the dev-only modules the build stubs
 * unconditionally — reached from the probe entry below, so a build that stopped
 * stubbing them fails here rather than in a user's deploy.
 */
const ABSENT_PACKAGES = ['mysql2', '@aws-sdk', 'vite', '@modelcontextprotocol']

function run(cmd: string[], cwd: string): { exitCode: number; output: string } {
  const result = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' })
  return { exitCode: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` }
}

describe.skipIf(!enabled)('lambda:build bundles an app importing @guren/orm', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-lambda-bundle-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'config'), { recursive: true })

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'lambda-bundle-probe', type: 'module', private: true }),
    )

    // Installed from a tarball, not `file:` — a local path install links the
    // package, and resolution then walks out of the probe into this repository's
    // own `node_modules`, where every database client *is* installed. That is
    // how the Workers version first passed with no stubs at all.
    const packed = run(['bun', 'pm', 'pack', '--destination', root], new URL('../../orm', import.meta.url).pathname)
    if (packed.exitCode !== 0) {
      throw new Error(`bundle probe could not pack @guren/orm:\n${packed.output}`)
    }
    const tarball = readdirSync(root).find((file) => file.endsWith('.tgz'))
    if (!tarball) {
      throw new Error(`bundle probe found no tarball in ${root}`)
    }

    // `postgres` alongside it: this app connects with Postgres, so its client
    // has to be the real one for the test to be able to catch over-stubbing.
    const install = run(['bun', 'add', join(root, tarball), 'postgres'], root)
    if (install.exitCode !== 0) {
      // Without this the bundle fails on `@guren/orm` itself and the test
      // reports the very symptom it is meant to detect, for the wrong reason.
      throw new Error(`bundle probe setup failed to install @guren/orm:\n${install.output}`)
    }

    // Asserted rather than assumed: an installer that pulled the ORM's optional
    // peers in would let the bundler resolve them whatever the stubs say.
    for (const client of ABSENT_PACKAGES) {
      rmSync(join(root, 'node_modules', client), { recursive: true, force: true })
      if (existsSync(join(root, 'node_modules', client))) {
        throw new Error(`bundle probe still has ${client} installed; the test would pass vacuously`)
      }
    }

    writeFileSync(
      join(root, 'config/database.ts'),
      "import { createPostgresDatabase } from '@guren/orm'\n\n"
        + 'export const { getDatabase, configureOrm } = createPostgresDatabase({\n'
        + "  connectionString: () => process.env.DATABASE_URL ?? 'postgres://localhost/probe',\n"
        + '})\n',
    )

    // The dev-only imports stand in for the ones Guren's own graph makes (the
    // disabled MCP endpoint, Vite when serving locally). Naming them directly
    // keeps the probe to two installed packages, and a bundler follows a literal
    // dynamic import either way.
    writeFileSync(
      join(root, 'src/lambda.ts'),
      "import { getDatabase } from '../config/database'\n\n"
        + 'export const http = async () => new Response(String(typeof (await getDatabase())))\n\n'
        + 'export const devOnly = async () => [\n'
        + "  await import('vite'),\n"
        + "  await import('@modelcontextprotocol/sdk/server/mcp.js'),\n"
        + ']\n',
    )
  })

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  async function bundle(dialects?: readonly DatabaseDialect[]): Promise<string> {
    await buildLambdaOutput({
      rootDir: root,
      outputDir: join(root, '.lambda'),
      skipAppBuild: true,
      databaseDialects: dialects,
    })
    return readFileSync(join(root, '.lambda/function/handler.js'), 'utf8')
  }

  test(
    'bundles a Postgres app that never installed the other dialects\' clients',
    async () => {
      // The defect itself: this threw `Could not resolve "mysql2"`, naming a
      // database the app did not choose.
      const bundled = await bundle()

      // And the client it *does* use came through as the real package: without
      // this half, stubbing all four would pass the assertion above just as well
      // and ship a function that cannot reach its own database.
      expect(bundled).toContain('class PostgresError')
    },
    120_000,
  )

  test(
    'bundles with none of the dev-only modules installed either',
    async () => {
      // Unconditional, unlike the clients: no app can make the Vite dev server or
      // the MCP endpoint's generators run here. The build succeeding is the only
      // observable difference — the stub's text is dropped with its branch.
      await bundle()
    },
    120_000,
  )

  test(
    'still fails to resolve an uninstalled client the app claims to use',
    async () => {
      // The mutation check: declaring every dialect leaves every client
      // unstubbed, the state this fix replaced. If it passed, the fixture would
      // not be reaching mysql2 at all and the assertion above would prove
      // nothing.
      const attempt = bundle(DATABASE_DIALECTS)

      await expect(attempt).rejects.toThrow(/Could not resolve.*mysql2/s)
    },
    120_000,
  )

  test(
    'stubs the Postgres client too once the app declares another dialect',
    async () => {
      // Without this, "postgres survives" is equally consistent with stubbing
      // being off entirely, or with postgres being special-cased.
      const bundled = await bundle(['sqlite'])

      expect(bundled).not.toContain('class PostgresError')
    },
    120_000,
  )
})
