import { describe, expect, it } from 'bun:test'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DATABASE_DEFAULTS,
  DATABASE_DRIVERS,
  databaseConfigTemplatePath,
  drizzleConfigTemplatePath,
  scaffoldAppBlueprint,
  type DatabaseDriver,
} from '../src/blueprints'
import { createTempWorkspace } from './helpers'

/**
 * `config/database.ts` and `drizzle.config.ts` both ship per driver under
 * `templates/database/<driver>/` and are copied into the app verbatim (see the
 * package CLAUDE.md). The pins here replace what the deleted string generators
 * enforced structurally: each file parses, hardcodes the driver-keyed constants
 * `DATABASE_DEFAULTS` holds (the url, which also reaches `.env`, and the
 * dialect, which reaches nothing else), calls its own dialect's factory,
 * agrees with its siblings on the fields no driver varies, reaches the app
 * byte-for-byte, and is actually packed into the npm tarball (the blog
 * blueprint once shipped layers no tarball contained).
 */
const EXPECTED_FACTORY = {
  postgres: 'createPostgresDatabase',
  mysql: 'createMySqlDatabase',
  sqlite: 'createSqliteDatabase',
} as const satisfies Record<DatabaseDriver, string>

const transpiler = new Bun.Transpiler({ loader: 'ts' })

describe('database config templates', () => {
  for (const driver of DATABASE_DRIVERS) {
    it(`ships a parseable ${driver} config aligned with DATABASE_DEFAULTS`, async () => {
      const source = await readFile(databaseConfigTemplatePath(driver), 'utf8')

      expect(() => transpiler.transformSync(source)).not.toThrow()

      // The generator interpolated these from DATABASE_DEFAULTS, so drift
      // between the table and the shipped file was impossible; now this is
      // the assertion that keeps them equal.
      expect(source).toContain(`'${DATABASE_DEFAULTS[driver].url}'`)
      expect(source).toContain(`${EXPECTED_FACTORY[driver]}({`)
    })

    it(`scaffolds the ${driver} config verbatim`, async () => {
      const workspace = await createTempWorkspace(`guren-db-config-${driver}-`)

      try {
        const dest = join(workspace.dir, 'test-app')
        await scaffoldAppBlueprint({ destination: dest, renderingMode: 'spa', database: driver })

        const scaffolded = await readFile(join(dest, 'config/database.ts'), 'utf8')

        expect(scaffolded).toBe(await readFile(databaseConfigTemplatePath(driver), 'utf8'))
      } finally {
        await workspace.cleanup()
      }
    })
  }
})

/**
 * The SQLite variant hardcodes the default URL twice — once as the fallback
 * `filename`, once in the guard's error text — so asserting every site is what
 * keeps a half-updated file from passing.
 */
/**
 * `schema` and `out` were single literals inside the deleted generator, so they
 * could not differ between drivers. Shipped as three files they can, and
 * nothing else would notice: the verbatim test compares a scaffold against the
 * same edited file, the guard test reads only `dbCredentials.url`, and no gate
 * anywhere runs drizzle-kit. Pinned here across the three, and against the
 * paths the scaffolder actually writes in the test below — a config agreeing
 * with its siblings about a directory none of them produces still breaks at
 * the user's first `db:migrate`.
 */
const SHARED_DRIZZLE_FIELDS = ["schema: './db/schema.ts',", "out: './db/migrations',"]

const EXPECTED_URL_SITES = {
  postgres: (url: string) => [`url: process.env.DATABASE_URL ?? '${url}',`],
  mysql: (url: string) => [`url: process.env.DATABASE_URL ?? '${url}',`],
  sqlite: (url: string) => [
    `const filename = process.env.DATABASE_URL ?? '${url}'`,
    `'Point it at a file such as ${url}, or use ":memory:".'`,
  ],
} as const satisfies Record<DatabaseDriver, (url: string) => string[]>

describe('drizzle config templates', () => {
  for (const driver of DATABASE_DRIVERS) {
    it(`ships a parseable ${driver} drizzle config aligned with DATABASE_DEFAULTS`, async () => {
      const source = await readFile(drizzleConfigTemplatePath(driver), 'utf8')

      expect(() => transpiler.transformSync(source)).not.toThrow()

      // The generator interpolated both of these from DATABASE_DEFAULTS, so
      // drift between the table and the shipped file was impossible; these are
      // the assertions that keep them equal. `dialect` is not the driver key —
      // postgres declares `postgresql`.
      for (const site of EXPECTED_URL_SITES[driver](DATABASE_DEFAULTS[driver].url)) {
        expect(source).toContain(site)
      }
      expect(source).toContain(`dialect: '${DATABASE_DEFAULTS[driver].dialect}',`)

      for (const field of SHARED_DRIZZLE_FIELDS) {
        expect(source).toContain(field)
      }
    })

    it(`scaffolds the ${driver} drizzle config verbatim`, async () => {
      const workspace = await createTempWorkspace(`guren-drizzle-config-${driver}-`)

      try {
        const dest = join(workspace.dir, 'test-app')
        await scaffoldAppBlueprint({ destination: dest, renderingMode: 'spa', database: driver })

        const scaffolded = await readFile(join(dest, 'drizzle.config.ts'), 'utf8')

        expect(scaffolded).toBe(await readFile(drizzleConfigTemplatePath(driver), 'utf8'))

        // `access` rather than a text match: what has to hold is that the paths
        // drizzle-kit will be handed exist in the app the scaffolder just
        // built, whatever the config happens to call them. The bare await is
        // the assertion — a missing path rejects with an ENOENT naming it,
        // which reads better than any boolean could. (Do not wrap it in
        // `.resolves.toBeUndefined()`: Bun's `access` resolves `null`.)
        for (const field of ['schema', 'out'] as const) {
          const declared = new RegExp(`${field}: '([^']+)'`).exec(scaffolded)?.[1]

          expect(declared).toBeDefined()
          await access(join(dest, declared!))
        }
      } finally {
        await workspace.cleanup()
      }
    })
  }
})

describe('shipped database config templates reach published users', () => {
  // The assertions above resolve against the source tree, so none of them
  // notices a `files`/`.npmignore` narrowing that drops these from the
  // tarball — and the packed/npm smokes scaffold sqlite, so postgres and
  // mysql would break only for real users.
  it('the npm tarball packs every driver config', async () => {
    const proc = Bun.spawn(['bun', 'pm', 'pack', '--dry-run'], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const listing = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)

    for (const driver of DATABASE_DRIVERS) {
      expect(listing).toContain(`templates/database/${driver}/config/database.ts`)
      expect(listing).toContain(`templates/database/${driver}/drizzle.config.ts`)
    }
  }, 30_000)
})
