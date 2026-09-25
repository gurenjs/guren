/**
 * Per-dialect drizzle column builders: the builder and options a column of each type is
 * written with. `guren add resource` (a `--fields` type) and `guren plan:scaffold` (a plan
 * column type, RFC 0030 §5) both write through here, so a dialect rule lives once.
 * `plan/status.ts` (`COLUMN_TYPE_BUILDERS`) judges these builders back to plan types: a
 * builder changed here must still be one it accepts for the type.
 */

import type { FieldDefinition, FieldType } from './fields'
import type { PlanColumn } from './plan/schema'
import type { SchemaDialect } from './schema-parser'

export interface ColumnCode {
  code: string
  /** The builder names the code calls, imported from the dialect's barrel. */
  imports: string[]
}

export type PlanColumnType = PlanColumn['type']

/** What a builder takes beyond its SQL name. */
export interface ColumnSpec {
  withTimezone?: boolean
  precision?: number
  scale?: number
}

type Builder = (sqlName: string, spec: ColumnSpec) => ColumnCode

export function quoteSqlName(name: string): string {
  return `'${name.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

function call(builder: string, sqlName: string, options?: string): ColumnCode {
  return { code: `${builder}(${quoteSqlName(sqlName)}${options ? `, ${options}` : ''})`, imports: [builder] }
}

function sized(spec: ColumnSpec): string | undefined {
  const entries = [
    ...(spec.precision !== undefined ? [`precision: ${spec.precision}`] : []),
    ...(spec.scale !== undefined ? [`scale: ${spec.scale}`] : []),
  ]
  return entries.length > 0 ? `{ ${entries.join(', ')} }` : undefined
}

/**
 * `Record<PlanColumnType, …>` so a type without a builder fails to compile: a switch with a
 * `default:` arm is how sqlite once shipped without a `date` case and emitted text for it.
 */
export const COLUMN_BUILDERS: Record<SchemaDialect, Record<PlanColumnType, Builder>> = {
  pg: {
    string: (name) => call('text', name),
    text: (name) => call('text', name),
    integer: (name) => call('integer', name),
    number: (name) => call('doublePrecision', name),
    decimal: (name, spec) => call('numeric', name, sized(spec)),
    boolean: (name) => call('boolean', name),
    date: (name) => call('date', name),
    // `timestamptz` unless the plan says otherwise. Drizzle writes `Date.toISOString()`, so
    // `timestamp without time zone` drops the offset: drizzle reads it back as UTC and stays
    // self-consistent, but psql and any other client see a different instant.
    datetime: (name, spec) => call('timestamp', name, `{ withTimezone: ${spec.withTimezone ?? true} }`),
    json: (name) => call('jsonb', name),
    uuid: (name) => call('uuid', name),
  },
  mysql: {
    string: (name) => call('varchar', name, '{ length: 255 }'),
    text: (name) => call('text', name),
    integer: (name) => call('int', name),
    number: (name) => call('double', name),
    decimal: (name, spec) => call('decimal', name, sized(spec)),
    boolean: (name) => call('boolean', name),
    date: (name) => call('date', name),
    // Bare `timestamp` on purpose: MySQL has no `timestamptz`, and its TIMESTAMP is already
    // stored as UTC and converted per session, so it round-trips the instant. `datetime`
    // is the one that would drop the offset here.
    datetime: (name) => call('timestamp', name),
    json: (name) => call('json', name),
    uuid: (name) => call('varchar', name, '{ length: 36 }'),
  },
  sqlite: {
    string: (name) => call('text', name),
    text: (name) => call('text', name),
    integer: (name) => call('integer', name),
    number: (name) => call('real', name),
    // SQLite's numeric affinity takes no precision or scale.
    decimal: (name) => call('numeric', name),
    boolean: (name) => call('integer', name, "{ mode: 'boolean' }"),
    // An ISO `YYYY-MM-DD` string, the value pg's and mysql's `date` builders read back.
    date: (name) => call('text', name),
    // Timestamp mode keeps the record type a `Date`, matching pg/mysql: a bare text column
    // would reject the `Date` that `z.coerce.date()` produces.
    datetime: (name) => call('integer', name, "{ mode: 'timestamp' }"),
    json: (name) => call('text', name, "{ mode: 'json' }"),
    uuid: (name) => call('text', name),
  },
}

/**
 * The column type a `--fields` type is written as. A `text` field is `varchar(255)` on
 * MySQL, as the resource blueprint has always written it, where a plan's `text` column is `text`.
 */
function fieldColumnType(dialect: SchemaDialect, type: FieldType): PlanColumnType {
  switch (type) {
    case 'number':
      return 'integer'
    case 'date':
      return 'datetime'
    case 'text':
      return dialect === 'mysql' ? 'string' : 'text'
    default:
      return type
  }
}

/**
 * Column name for a field. Deliberately separate from `tableNameFor()`, which
 * goes through `kebabCase()` and collapses `[_\s]+` to one separator: a field
 * name is taken verbatim from the user and `__dunder__` must survive intact.
 */
function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/** An integer primary key the database numbers: `serial` on pg, `AUTO_INCREMENT` on MySQL, `AUTOINCREMENT` on SQLite. */
export function autoIncrementPrimaryKey(dialect: SchemaDialect, sqlName: string): ColumnCode {
  switch (dialect) {
    case 'pg':
      return { code: `${call('serial', sqlName).code}.primaryKey()`, imports: ['serial'] }
    case 'mysql':
      return { code: `${call('int', sqlName).code}.primaryKey().autoincrement()`, imports: ['int'] }
    case 'sqlite':
      return { code: `${call('integer', sqlName).code}.primaryKey({ autoIncrement: true })`, imports: ['integer'] }
  }
}

/** A `--fields` entry as the resource blueprint appends it: snake-cased SQL name, `.notNull()` unless `?`. */
export function buildFieldColumn(dialect: SchemaDialect, field: FieldDefinition): ColumnCode {
  const column = COLUMN_BUILDERS[dialect][fieldColumnType(dialect, field.type)](snakeCase(field.name), {})
  return { code: `${column.code}${field.nullable ? '' : '.notNull()'}`, imports: column.imports }
}
