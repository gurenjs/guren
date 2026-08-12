// The dbcheck fixtures only ever run inside `smoke:golden-path`, one driver per
// invocation, and the two server-backed drivers need a container — so a fixture
// that quietly started checking less than its siblings would go unnoticed for as
// long as nobody ran that driver by hand. That is the history here: three copies
// of one table list, and sqlite drifted into asserting the migration tracker
// merely *existed* while postgres and mysql counted its rows. These run in a
// second and pin the shape that made the drift possible.
import { describe, expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { tableNameFor } from '../../packages/cli/src/inflect'
import { DATABASE_DRIVERS } from '../../packages/create-app/src/blueprints'
import { MIGRATION_TRACKER, REQUIRED_APP_TABLES } from './fixtures/expected-tables'

const fixturesDir = join(import.meta.dir, 'fixtures')
const smokeScript = join(import.meta.dir, '..', 'smoke-golden-path.sh')

// The drivers the smoke can be asked for, imported rather than restated:
// `$SMOKE_DB` goes straight to `create-app --db`, so this set and the fixture
// set have to move together. A local copy would let a fourth driver be added
// with no fixture behind it while the count assertion below stayed green.
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

        // The exact drift: a private list beside the shared one. Every table
        // name must arrive through the shared module, so none may appear as a
        // literal here. The tracker is included because writing it into the
        // presence list is precisely how sqlite stopped counting its rows.
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

        // Referencing the constant is fine; appending it to the list the
        // presence check reads is not, because presence is a side effect of
        // opening the migrator and proves no migration ran.
        expect(source).not.toMatch(/REQUIRED_APP_TABLES\s*,\s*MIGRATION_TRACKER/)
      })
    })
  }

  for (const driver of SERVER_BACKED) {
    test(`${driver} does not fall back to a default database URL`, async () => {
      const source = await fixtureSource(driver)

      // A default is a fail-open: postgres used to default to the *development*
      // database while the smoke exports a dedicated one, so an unset URL would
      // have inspected a database no migration under test had touched.
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

    // The list is hand-written on purpose: it is the smoke's independent
    // statement of intent, and deriving it from the app's own schema would let a
    // scaffolder that emitted no table agree with itself and pass. What must not
    // happen is that statement going stale in silence, so the resources the
    // script actually asks for are cross-checked against it here. `users` comes
    // from `add auth` rather than from a resource, so it is excluded.
    const scaffolded = [...script.matchAll(/add resource (\w+)/g)].map((match) => tableNameFor(match[1]))

    expect(scaffolded.length).toBeGreaterThan(0)
    expect(scaffolded.sort()).toEqual(REQUIRED_APP_TABLES.filter((table) => table !== 'users').sort())
  })
})
