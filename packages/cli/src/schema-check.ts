import { schemaPathFor, type SchemaTable } from './schema-parser'
import { check, type CheckResult } from './check-result'

/**
 * The Postgres builder whose offset-less form is the bug. `time` also takes
 * `withTimezone`, but it carries a time of day rather than an instant, so it
 * is deliberately out of scope.
 */
const TIMESTAMP_BUILDER = 'timestamp'

/**
 * Flags Postgres `timestamp` columns declared without `{ withTimezone: true }`.
 * `timestamp without time zone` stores a bare wall clock: `defaultNow()` records the
 * *database session's* zone while the app reads it back as UTC. Postgres only, matched per
 * table by the declaring factory. Silence is not proof — a column the parser cannot read
 * statically is skipped rather than guessed at, since the fix suggested is a migration.
 */
export function checkSchemaTimestamps(tables: SchemaTable[]): CheckResult[] {
  const results: CheckResult[] = []

  for (const table of tables) {
    if (table.dialect !== 'pg') continue

    const schemaPath = schemaPathFor(table.module)

    for (const column of table.columns) {
      // `.array()` appends the suffix; the options live on the same builder.
      if (column.type?.replace(/\[\]$/, '') !== TIMESTAMP_BUILDER) continue
      if (column.withTimezone === true) continue
      // Options passed as an expression hide every field, so "no withTimezone
      // here" would be a guess, not a reading.
      if (column.opaqueOptions) continue

      // The suggestion names the database column, not the object key it is declared
      // under (`createdAt: timestamp('created_at')`). Under drizzle's name-less form that
      // name comes from a casing config this parser does not read, so the hint is dropped.
      const declaration = column.columnName
        ? `timestamp('${column.columnName}', { withTimezone: true })`
        : `timestamp({ withTimezone: true })`
      const usingHint = column.columnName
        ? `, e.g. USING "${column.columnName}" AT TIME ZONE 'UTC'`
        : ''

      results.push(
        check(
          `schema-timestamptz:${table.identifier}.${column.name}`,
          `${table.identifier}.${column.name} time zone`,
          'warn',
          `Postgres column '${column.columnName ?? column.name}' is 'timestamp without time zone', which stores `
          + `a bare wall clock: defaultNow() writes the database session's zone while the app reads it back as `
          + `UTC, and any non-Drizzle reader sees a different instant than the app does.`,
          `In ${schemaPath}, set withTimezone on the column — ${declaration} — keeping any other options it `
          + `already carries, such as mode or precision. Then generate a migration: Drizzle's bare `
          + `'::timestamp with time zone' cast reinterprets stored rows against the session's zone, so name the `
          + `zone they were written in instead${usingHint}.`,
          schemaPath,
        ),
      )
    }
  }

  return results
}
