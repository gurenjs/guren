import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DATABASE_DEFAULTS,
  DATABASE_DRIVERS,
  databaseConfigTemplatePath,
  scaffoldAppBlueprint,
  type DatabaseDriver,
} from '../src/blueprints'
import { createTempWorkspace } from './helpers'

/**
 * `config/database.ts` ships per driver under `templates/database/<driver>/`
 * and is copied into the app verbatim (see the package CLAUDE.md). The pins
 * here replace what the deleted string generator enforced structurally: each
 * file parses, hardcodes the same constants `DATABASE_DEFAULTS` feeds into
 * `.env` and `drizzle.config.ts`, calls its own dialect's factory, reaches
 * the app byte-for-byte, and is actually packed into the npm tarball (the
 * blog blueprint once shipped layers no tarball contained).
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
    }
  }, 30_000)
})
