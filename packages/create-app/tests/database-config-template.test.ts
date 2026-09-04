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
 * `config/database.ts` and `drizzle.config.ts` ship per driver under
 * `templates/database/<driver>/` and are copied into the app verbatim. Pinned:
 * each file parses, hardcodes its `DATABASE_DEFAULTS` url and dialect, calls its
 * dialect's factory, agrees with its siblings on the invariant fields, reaches
 * the app byte-for-byte, and is packed into the npm tarball.
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

      // The one assertion keeping the shipped file equal to DATABASE_DEFAULTS.
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
 * Shipped as three files these can differ per driver, and nothing else would
 * notice: no gate anywhere runs drizzle-kit. Pinned across the three, and
 * against the paths the scaffolder actually writes in the test below.
 */
const SHARED_DRIZZLE_FIELDS = ["schema: './db/schema.ts',", "out: './db/migrations',"]

/**
 * The SQLite variant hardcodes the default URL twice — the fallback `filename`
 * and the guard's error text — so every site is asserted, or a half-updated
 * file passes.
 */
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

      // `dialect` is not the driver key — postgres declares `postgresql`.
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

        // `access` rather than a text match: the paths drizzle-kit is handed
        // must exist in the app just built, whatever the config calls them. The
        // bare await is the assertion — do not wrap it in
        // `.resolves.toBeUndefined()`, since Bun's `access` resolves `null`.
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
  // The assertions above read the source tree, so none notices a
  // `files`/`.npmignore` narrowing; the packed/npm smokes scaffold sqlite only,
  // so postgres and mysql would break for real users alone.
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
