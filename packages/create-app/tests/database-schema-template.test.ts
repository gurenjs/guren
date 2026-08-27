import { describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DATABASE_DRIVERS,
  databaseSchemaTemplatePath,
  scaffoldAppBlueprint,
  TEMPLATES_ROOT,
  type DatabaseDriver,
} from '../src/blueprints'
import { createTempWorkspace } from './helpers'

/**
 * The generic `db/schema.ts` ships per driver under
 * `templates/database/<driver>/db/schema.ts` and is copied into the app
 * verbatim, the same shape `config/database.ts` uses. The pins here replace
 * what the deleted string generator enforced structurally: each file parses,
 * imports from its own dialect's barrel, reaches the app byte-for-byte, and
 * is actually packed into the npm tarball.
 *
 * The last two cases guard the branch this fallback sits in: a template that
 * ships its own `db/schema.<driver>.ts` must win over it, and a template
 * shipping *some* variants but not the selected one must still throw rather
 * than scaffold an app whose models reference tables that do not exist.
 */
const EXPECTED_SCHEMA_MODULE = {
  postgres: '@guren/orm/drizzle/pg',
  mysql: '@guren/orm/drizzle/mysql',
  sqlite: '@guren/orm/drizzle/sqlite',
} as const satisfies Record<DatabaseDriver, string>

const transpiler = new Bun.Transpiler({ loader: 'ts' })

describe('database schema templates', () => {
  for (const driver of DATABASE_DRIVERS) {
    it(`ships a parseable ${driver} schema built from its own dialect barrel`, async () => {
      const source = await readFile(databaseSchemaTemplatePath(driver), 'utf8')

      expect(() => transpiler.transformSync(source)).not.toThrow()

      // Drizzle's builders share names across dialects, so a schema built from
      // the wrong barrel still emits DDL and still typechecks. The generator's
      // three driver-keyed branches made mixing them impossible; this is the
      // assertion that keeps each shipped file dialect-pure.
      expect(transpiler.scanImports(source).map((entry) => entry.path)).toEqual([
        EXPECTED_SCHEMA_MODULE[driver],
      ])
    })

    it(`scaffolds the ${driver} fallback schema verbatim`, async () => {
      const workspace = await createTempWorkspace(`guren-db-schema-${driver}-`)

      try {
        const dest = join(workspace.dir, 'test-app')
        await scaffoldAppBlueprint({ destination: dest, renderingMode: 'spa', database: driver })

        const scaffolded = await readFile(join(dest, 'db/schema.ts'), 'utf8')

        expect(scaffolded).toBe(await readFile(databaseSchemaTemplatePath(driver), 'utf8'))
      } finally {
        await workspace.cleanup()
      }
    })

    it(`prefers a template's own ${driver} schema variant over the fallback`, async () => {
      const workspace = await createTempWorkspace(`guren-db-schema-variant-${driver}-`)

      try {
        const dest = join(workspace.dir, 'test-app')
        await scaffoldAppBlueprint({ blueprint: 'blog', destination: dest, renderingMode: 'spa', database: driver })

        const scaffolded = await readFile(join(dest, 'db/schema.ts'), 'utf8')

        expect(scaffolded).toBe(
          await readFile(join(TEMPLATES_ROOT, 'blog', `db/schema.${driver}.ts`), 'utf8'),
        )
      } finally {
        await workspace.cleanup()
      }
    })
  }

  it('refuses to fall back when a template ships variants but not the selected driver', async () => {
    const workspace = await createTempWorkspace('guren-db-schema-partial-')

    try {
      const dest = join(workspace.dir, 'test-app')

      // `resolveSchema` scans the destination, which is where a template's
      // variants have landed by the time it runs — so a lone pre-seeded
      // variant reproduces the packaging bug without a fixture template
      // that `TemplateName` would refuse to name.
      await mkdir(join(dest, 'db'), { recursive: true })
      await writeFile(join(dest, 'db/schema.postgres.ts'), '// partial variant\n', 'utf8')

      await expect(
        scaffoldAppBlueprint({ destination: dest, renderingMode: 'spa', database: 'mysql' }),
      ).rejects.toThrow(/ships a database schema for postgres but not for mysql/u)
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('shipped database schema templates reach published users', () => {
  // The assertions above resolve against the source tree, so none of them
  // notices a `files`/`.npmignore` narrowing that drops these from the
  // tarball — and the packed/npm smokes scaffold sqlite, so postgres and
  // mysql would break only for real users.
  it('the npm tarball packs every driver schema', async () => {
    const proc = Bun.spawn(['bun', 'pm', 'pack', '--dry-run'], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const listing = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)

    for (const driver of DATABASE_DRIVERS) {
      expect(listing).toContain(`templates/database/${driver}/db/schema.ts`)
    }
  }, 30_000)
})
