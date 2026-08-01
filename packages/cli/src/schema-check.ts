import { parseSchemaTables, schemaPathFor } from './schema-parser'
import { check, type CheckResult } from './check-result'

/**
 * The Postgres builder whose offset-less form is the bug. `time` also takes
 * `withTimezone`, but it carries a time of day rather than an instant, so it
 * is deliberately out of scope.
 */
const TIMESTAMP_BUILDER = 'timestamp'

/**
 * Flags Postgres `timestamp` columns declared without `{ withTimezone: true }`.
 *
 * `timestamp without time zone` stores a bare wall clock, and who reads it
 * decides what that clock meant: `defaultNow()` records the wall clock of the
 * *database session's* zone while the app reads the column back as UTC, so on
 * a non-UTC session the stored instant is simply wrong — and any non-Drizzle
 * reader (psql, a report, another service) sees a different instant than the
 * app does for values the app wrote itself.
 *
 * Postgres only. MySQL has no `timestamptz` and its TIMESTAMP is already
 * UTC-normalized; sqlite stores epoch integers via `integer(..., { mode })`.
 * Both are matched by the declaring table's factory, not by the file, so a
 * schema mixing dialects is judged a table at a time.
 *
 * Silence is not proof: a column the parser cannot read statically is skipped
 * rather than guessed at, and `schema-parser.ts` documents the spellings it
 * does not resolve. Reporting a column that is actually fine costs more here
 * than missing one — the fix this suggests is a migration.
 *
 * Emits one result per offending column and nothing when a schema is clean —
 * the shape the per-file checks in `check.ts` use, since a pass per column
 * would bury everything else in the report.
 */
export async function checkSchemaTimestamps(cwd: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  for (const table of await parseSchemaTables(cwd)) {
    if (table.dialect !== 'pg') continue

    const schemaPath = schemaPathFor(table.module)

    for (const column of table.columns) {
      // `.array()` appends the suffix; the options live on the same builder.
      if (column.type?.replace(/\[\]$/, '') !== TIMESTAMP_BUILDER) continue
      if (column.withTimezone === true) continue
      // Options passed as an expression hide every field, so "no withTimezone
      // here" would be a guess, not a reading.
      if (column.opaqueOptions) continue

      // The suggestion has to name the database column, not the object key it
      // is declared under — they differ in every scaffolded schema
      // (`createdAt: timestamp('created_at')`). Under drizzle's name-less form
      // the database name is derived from a casing config this parser does not
      // read, so the SQL hint is dropped rather than quoting a name that would
      // not resolve.
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
