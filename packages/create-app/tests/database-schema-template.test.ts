import { describe, expect, it } from 'bun:test'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DATABASE_DRIVERS,
  databaseSchemaTemplatePath,
  scaffoldAppBlueprint,
  TEMPLATES_ROOT,
  templateDir,
  type DatabaseDriver,
} from '../src/blueprints'
import { createTempWorkspace } from './helpers'

/**
 * The generic `db/schema.ts` ships per driver under `templates/database/<driver>/`
 * and is copied into the app verbatim. Pinned: each file parses, imports its own
 * dialect's barrel, reaches the app byte-for-byte, and is packed into the tarball.
 * The last two cases guard the fallback's branch: a template's own
 * `db/schema.<driver>.ts` wins, and one missing the selected driver's variant throws.
 */
const EXPECTED_SCHEMA_MODULE = {
  postgres: '@guren/orm/drizzle/pg',
  mysql: '@guren/orm/drizzle/mysql',
  sqlite: '@guren/orm/drizzle/sqlite',
} as const satisfies Record<DatabaseDriver, string>

/**
 * The blueprints that ship no `db/schema.<driver>.ts` variant and so take the
 * fallback. `api` earns its place: nothing else in its template lives under
 * `db/`, so it is the only blueprint proving `applyDatabaseConfig` creates that
 * directory itself.
 */
const FALLBACK_BLUEPRINTS = ['default', 'api'] as const

const transpiler = new Bun.Transpiler({ loader: 'ts' })

describe('database schema templates', () => {
  for (const driver of DATABASE_DRIVERS) {
    it(`ships a parseable ${driver} schema built from its own dialect barrel`, async () => {
      const source = await readFile(databaseSchemaTemplatePath(driver), 'utf8')

      expect(() => transpiler.transformSync(source)).not.toThrow()

      // Drizzle's builders share names across dialects, so a schema built from
      // the wrong barrel still emits DDL and still typechecks — this is the
      // only assertion keeping each shipped file dialect-pure.
      expect(transpiler.scanImports(source).map((entry) => entry.path)).toEqual([
        EXPECTED_SCHEMA_MODULE[driver],
      ])
    })

    for (const blueprint of FALLBACK_BLUEPRINTS) {
      it(`scaffolds the ${driver} fallback schema verbatim into a ${blueprint} app`, async () => {
        const workspace = await createTempWorkspace(`guren-db-schema-${blueprint}-${driver}-`)

        try {
          const dest = join(workspace.dir, 'test-app')
          await scaffoldAppBlueprint({ blueprint, destination: dest, renderingMode: 'spa', database: driver })

          const scaffolded = await readFile(join(dest, 'db/schema.ts'), 'utf8')

          expect(scaffolded).toBe(await readFile(databaseSchemaTemplatePath(driver), 'utf8'))
        } finally {
          await workspace.cleanup()
        }
      })
    }

    it(`prefers a template's own ${driver} schema variant over the fallback`, async () => {
      const workspace = await createTempWorkspace(`guren-db-schema-variant-${driver}-`)

      try {
        const dest = join(workspace.dir, 'test-app')
        await scaffoldAppBlueprint({ blueprint: 'blog', destination: dest, renderingMode: 'spa', database: driver })

        const scaffolded = await readFile(join(dest, 'db/schema.ts'), 'utf8')

        expect(scaffolded).toBe(
          await readFile(join(templateDir('blog'), `db/schema.${driver}.ts`), 'utf8'),
        )
      } finally {
        await workspace.cleanup()
      }
    })
  }

  it('declares the same table across every driver', async () => {
    // Only sqlite is scaffolded by the packed and npm smokes, so a column added
    // to one file alone would reach postgres and mysql users unnoticed. Compared
    // dialect-agnostically: the builders differ by design, the shape must not.
    const shapes = await Promise.all(
      DATABASE_DRIVERS.map(async (driver) => {
        const source = await readFile(databaseSchemaTemplatePath(driver), 'utf8')

        return {
          driver,
          exports: [...transpiler.scan(source).exports].sort(),
          columns: [...source.matchAll(/^ {2}(\w+):/gmu)].map((match) => match[1]),
        }
      }),
    )

    for (const shape of shapes) {
      expect({ ...shape, driver: 'any' }).toEqual({ ...shapes[0], driver: 'any' })
    }

    // Pinned literally too: an edit that drops a column from all three files
    // agrees with itself, and the comparison above would still pass.
    expect(shapes[0].exports).toEqual(['users'])
    expect(shapes[0].columns).toEqual(['id', 'name', 'email', 'createdAt'])
  })

  it('ships no plain db/schema.ts from any template', async () => {
    // `applyDatabaseConfig` overwrites `db/schema.ts` unconditionally, so a
    // template carrying one is dead weight that still reads as the place to edit
    // the generic schema — a column added there reaches no scaffolded app with
    // every gate green. Only `db/schema.<driver>.ts` is live for a template.
    const layers = (await readdir(TEMPLATES_ROOT, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== 'database')
      .map((entry) => entry.name)

    expect(layers.length).toBeGreaterThan(0)

    for (const layer of layers) {
      const files = await readdir(join(TEMPLATES_ROOT, layer, 'db')).catch((): string[] => [])

      expect({ layer, plainSchema: files.includes('schema.ts') }).toEqual({ layer, plainSchema: false })
    }
  })

  it('refuses to fall back when a template ships variants but not the selected driver', async () => {
    const workspace = await createTempWorkspace('guren-db-schema-partial-')

    try {
      const dest = join(workspace.dir, 'test-app')

      // `resolveSchema` scans the destination, where a template's variants have
      // landed by then, so a lone pre-seeded variant reproduces the packaging
      // bug without a fixture template `TemplateName` would refuse to name.
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
  // The assertions above read the source tree, so none notices a
  // `files`/`.npmignore` narrowing; the packed/npm smokes scaffold sqlite only,
  // so postgres and mysql would break for real users alone.
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
