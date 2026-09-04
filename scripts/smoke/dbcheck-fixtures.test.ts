// The dbcheck fixtures only run inside `smoke:golden-path`, one driver per
// invocation, and the server-backed ones need a container, so a fixture checking
// less than its siblings goes unnoticed until someone runs that driver by hand.
// The drift these pin: three copies of one table list, with sqlite asserting the
// migration tracker merely *existed* while postgres and mysql counted its rows.
import { describe, expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { tableNameFor } from '../../packages/cli/src/inflect'
import { DATABASE_DRIVERS } from '../../packages/create-app/src/blueprints'
import { MIGRATION_TRACKER, REQUIRED_APP_TABLES } from './fixtures/expected-tables'

const fixturesDir = join(import.meta.dir, 'fixtures')
const smokeScript = join(import.meta.dir, '..', 'smoke-golden-path.sh')

// Imported rather than restated: `$SMOKE_DB` goes straight to `create-app --db`,
// so a local copy would let a fourth driver be added with no fixture behind it
// while the count assertion below stayed green.
const DRIVERS = DATABASE_DRIVERS

// sqlite addresses a file, so it is the one driver with no URL to require.
const SERVER_BACKED = DRIVERS.filter((driver) => driver !== 'sqlite')

async function fixtureSource(driver: string): Promise<string> {
  return await readFile(join(fixturesDir, `dbcheck.${driver}.ts`), 'utf8')
}

describe('dbcheck fixtures', () => {
  test('there is exactly one fixture per driver the smoke dispatches on', async () => {
    const found = (await readdir(fixturesDir))
      .filter((name) => name.startsWith('dbcheck.'))
      .map((name) => name.replace(/^dbcheck\.|\.ts$/g, ''))

    expect(found.sort()).toEqual([...DRIVERS].sort())
  })

  test('the smoke resolves the fixture by driver name, with its shared module alongside', async () => {
    const script = await readFile(smokeScript, 'utf8')

    // The dispatch is what used to hold three inline copies. If it grows an
    // `if [ "$SMOKE_DB" = ... ]` around dbcheck again, the copies are back.
    expect(script).toContain('dbcheck.$SMOKE_DB.ts')
    // A relative import only resolves if expected-tables.ts travels with the
    // fixture, so the copy has to be of the directory, not of one file.
    expect(script).toMatch(/cp -R "\$FIXTURES_DIR"/)
  })

  for (const driver of DRIVERS) {
    describe(driver, () => {
      test('takes its required-table list from the shared module', async () => {
        const source = await fixtureSource(driver)

        expect(source).toContain("from './expected-tables.ts'")
        // The call, not the bare name, which the import alone satisfies — a
        // fixture that imports the helper and never calls it checks nothing.
        expect(source).toContain('assertRequiredTables(')
      })

      test('hard-codes no table names of its own', async () => {
        const source = await fixtureSource(driver)

        // Every table name must arrive through the shared module, the tracker
        // included: writing it into the presence list is how sqlite stopped
        // counting its rows.
        for (const table of [...REQUIRED_APP_TABLES, MIGRATION_TRACKER]) {
          expect(source).not.toContain(`'${table}'`)
          expect(source).not.toContain(`"${table}"`)
        }
      })

      test('asserts the migration tracker is non-empty, not merely present', async () => {
        const source = await fixtureSource(driver)

        expect(source).toContain('assertTrackerNonEmpty(')
        expect(source).toMatch(/count\(\*\)/)
      })

      test('does not smuggle the tracker into the required-table list', async () => {
        const source = await fixtureSource(driver)

        // Referencing the constant is fine; appending it to the presence list is
        // not, since the tracker exists as a side effect of opening the migrator.
        expect(source).not.toMatch(/REQUIRED_APP_TABLES\s*,\s*MIGRATION_TRACKER/)
      })
    })
  }

  for (const driver of SERVER_BACKED) {
    test(`${driver} does not fall back to a default database URL`, async () => {
      const source = await fixtureSource(driver)

      // A default is a fail-open: the smoke exports a dedicated database, so an
      // unset URL would inspect one no migration under test had touched.
      expect(source).toContain('requireDatabaseUrl()')
      expect(source).not.toMatch(/DATABASE_URL\s*\?\?/)
    })
  }

  test('the shared list keeps the tracker out', () => {
    // REQUIRED_APP_TABLES feeds a presence-only check, so the tracker must not
    // be a member of it however the fixtures are rewritten.
    expect(REQUIRED_APP_TABLES as readonly string[]).not.toContain(MIGRATION_TRACKER)
  })

  test('the required-table list still matches what the smoke scaffolds', async () => {
    const script = await readFile(smokeScript, 'utf8')

    // The list is hand-written on purpose: derived from the app's own schema, a
    // scaffolder that emitted no table would agree with itself and pass. This
    // cross-check keeps it from going stale. `users` comes from `add auth` rather
    // than from a resource, so it is excluded.
    const scaffolded = [...script.matchAll(/add resource (\w+)/g)].map((match) => tableNameFor(match[1]))

    expect(scaffolded.length).toBeGreaterThan(0)
    expect(scaffolded.sort()).toEqual(REQUIRED_APP_TABLES.filter((table) => table !== 'users').sort())
  })
})
