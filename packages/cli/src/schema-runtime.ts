import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileExists, listAppRoots } from './discovery'
import {
  parseSchemaTables,
  schemaPathFor,
  type SchemaColumn,
  type SchemaColumnDefault,
  type SchemaConstraint,
  type SchemaDialect,
  type SchemaTable,
} from './schema-parser'

/**
 * Reads `db/schema.ts` by importing it and asking drizzle's `getTableConfig()`, which sees
 * what the static reader marks opaque: spread columns, helper builders, the columns
 * callback, `pgTableCreator`, an extra config built elsewhere. Importing runs app code,
 * so edit hooks, `guren check` and the scaffolders stay on `parseSchemaTables()`.
 * Every failure is a per-file result, never a throw and never an empty table list.
 */

export type SchemaSource = 'runtime' | 'static'

/** `sqlType` is drizzle's `getSQLType()`, the one type fact the runtime holds; `type` is the builder as written. */
export interface RuntimeSchemaColumn extends SchemaColumn {
  sqlType?: string
}

export interface RuntimeSchemaTable extends SchemaTable {
  columns: RuntimeSchemaColumn[]
}

export type RuntimeSchemaFile =
  | { module: string | null; path: string; status: 'read'; tables: RuntimeSchemaTable[]; drizzleEntry: string }
  | { module: string | null; path: string; status: 'unreadable'; reason: string }

export interface SourcedSchemaTable extends RuntimeSchemaTable {
  source: SchemaSource
  /** `static` only: why the runtime reader did not report this table. */
  runtimeUnreadable?: string
}

export interface SchemaRead {
  tables: SourcedSchemaTable[]
  files: RuntimeSchemaFile[]
}

interface RuntimeColumn {
  name: string
  primary: boolean
  notNull: boolean
  hasDefault: boolean
  default: unknown
  defaultFn?: unknown
  isUnique: boolean
  withTimezone?: unknown
  getSQLType?: () => string
}

interface RuntimeSql {
  queryChunks: unknown[]
}

interface RuntimeForeignKey {
  getName(): string | undefined
  reference(): { columns: RuntimeColumn[]; foreignColumns: RuntimeColumn[]; foreignTable: object }
}

interface RuntimeTableConfig {
  name: string
  columns: RuntimeColumn[]
  indexes: { config: { name?: string; unique?: boolean; columns: unknown[] } }[]
  foreignKeys: RuntimeForeignKey[]
  checks: { name?: string }[]
  primaryKeys: { columns: RuntimeColumn[]; name?: string; getName?: () => string | undefined }[]
  uniqueConstraints: { columns: RuntimeColumn[]; name?: string; getName?: () => string | undefined }[]
}

interface DialectModule {
  dialect: SchemaDialect
  tableClass: unknown
  getTableConfig(table: object): RuntimeTableConfig
}

interface DrizzleCopy {
  entry: string
  is(value: unknown, type: unknown): boolean
  dialects: DialectModule[]
}

const DIALECT_SUBPATHS: { dialect: SchemaDialect; subpath: string; tableClass: string }[] = [
  { dialect: 'pg', subpath: 'drizzle-orm/pg-core', tableClass: 'PgTable' },
  { dialect: 'sqlite', subpath: 'drizzle-orm/sqlite-core', tableClass: 'SQLiteTable' },
  { dialect: 'mysql', subpath: 'drizzle-orm/mysql-core', tableClass: 'MySqlTable' },
]

// A schema awaiting a connection at top level never settles; the static reader answers instead.
const IMPORT_TIMEOUT_MS = 5000

/**
 * Resolves with the ESM conditions the schema's own `import` gets, so both land on one
 * module instance. `createRequire` alone would name the `.cjs` build, a second copy.
 */
function resolveFrom(specifier: string, directory: string): string {
  if (typeof Bun !== 'undefined') return Bun.resolveSync(specifier, directory)
  return createRequire(resolve(directory, 'noop.js')).resolve(specifier)
}

/** `drizzle-orm` as the schema file sees it: its own dependency, or the one `@guren/orm` installs. */
function resolveDrizzle(specifier: string, schemaDir: string): string {
  try {
    return resolveFrom(specifier, schemaDir)
  } catch {
    return resolveFrom(specifier, dirname(resolveFrom('@guren/orm/package.json', schemaDir)))
  }
}

async function loadDrizzle(schemaDir: string): Promise<DrizzleCopy> {
  const entry = resolveDrizzle('drizzle-orm', schemaDir)
  const core = (await import(pathToFileURL(entry).href)) as { is: DrizzleCopy['is'] }

  const dialects: DialectModule[] = []
  for (const { dialect, subpath, tableClass } of DIALECT_SUBPATHS) {
    const loaded = (await import(pathToFileURL(resolveDrizzle(subpath, schemaDir)).href)) as Record<string, unknown>
    dialects.push({
      dialect,
      tableClass: loaded[tableClass],
      getTableConfig: loaded.getTableConfig as DialectModule['getTableConfig'],
    })
  }
  return { entry, is: core.is, dialects }
}

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${IMPORT_TIMEOUT_MS}ms`)), IMPORT_TIMEOUT_MS)
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}

function isSql(value: unknown): value is RuntimeSql {
  return typeof value === 'object' && value !== null && Array.isArray((value as RuntimeSql).queryChunks)
}

/** A drizzle `sql` object as text, from its chunks: never through a dialect, never evaluated. */
function sqlText(sql: RuntimeSql): string {
  return sql.queryChunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      if (typeof chunk !== 'object' || chunk === null) return String(chunk)
      if (isSql(chunk)) return sqlText(chunk)
      const record = chunk as { value?: unknown; name?: unknown }
      if (Array.isArray(record.value)) return record.value.join('')
      if (typeof record.name === 'string') return record.name
      return 'value' in record ? literalText(record.value) : '?'
    })
    .join('')
}

function literalText(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** `.defaultNow()` and `.defaultRandom()` are stored as SQL, so they come back as `sql`. */
function columnDefault(column: RuntimeColumn): SchemaColumnDefault | undefined {
  if (column.default === undefined) return undefined
  if (isSql(column.default)) return { kind: 'sql', text: sqlText(column.default) }
  return { kind: 'value', text: literalText(column.default) }
}

interface TableEntry {
  identifier: string
  table: object
  config: RuntimeTableConfig
  dialect: SchemaDialect
  /** Database column name → the table object's key. */
  keys: Map<string, string>
}

function columnKeys(table: object, config: RuntimeTableConfig): Map<string, string> {
  const keys = new Map<string, string>()
  const owned = new Set<unknown>(config.columns)
  for (const [key, value] of Object.entries(table)) {
    if (owned.has(value)) keys.set((value as RuntimeColumn).name, key)
  }
  return keys
}

/** Property names for `columns`; an entry that is an expression, not a column, sets `opaque`. */
function propertyNames(columns: unknown[], keys: Map<string, string>): { names: string[]; opaque: boolean } {
  const names: string[] = []
  let opaque = false
  for (const column of columns) {
    const name = isSql(column) ? undefined : (column as { name?: unknown } | null)?.name
    const key = typeof name === 'string' ? keys.get(name) : undefined
    if (key === undefined) opaque = true
    else names.push(key)
  }
  return { names, opaque }
}

function constraint(
  kind: SchemaConstraint['kind'],
  name: string | undefined,
  columns: { names: string[]; opaque: boolean },
): SchemaConstraint {
  return {
    kind,
    ...(name ? { name } : {}),
    columns: columns.names,
    ...(columns.opaque ? { opaqueColumns: true as const } : {}),
  }
}

function foreignKeyConstraint(key: RuntimeForeignKey, entry: TableEntry, all: TableEntry[]): SchemaConstraint {
  const reference = key.reference()
  const target = all.find((candidate) => candidate.table === reference.foreignTable)
  const local = propertyNames(reference.columns, entry.keys)
  const foreign = target ? propertyNames(reference.foreignColumns, target.keys) : { names: [], opaque: true }
  return {
    ...constraint('foreignKey', key.getName(), { names: local.names, opaque: local.opaque || foreign.opaque }),
    ...(target ? { references: { table: target.identifier, columns: foreign.names } } : {}),
  }
}

/**
 * Every foreign key is a constraint, since drizzle keeps no record of whether one was
 * written as `.references()` or `foreignKey()`; a single-column one is also on its column.
 */
function toSchemaTable(entry: TableEntry, all: TableEntry[], module: string | null): RuntimeSchemaTable {
  const { config, keys } = entry
  const foreignKeys = config.foreignKeys.map((key) => foreignKeyConstraint(key, entry, all))

  const columns: RuntimeSchemaColumn[] = config.columns.map((column) => {
    const name = keys.get(column.name) ?? column.name
    const single = foreignKeys.find(
      (key) => !key.opaqueColumns && key.references?.columns.length === 1 && key.columns.length === 1 && key.columns[0] === name,
    )
    const defaultValue = columnDefault(column)
    return {
      name,
      columnName: column.name,
      ...(column.getSQLType ? { sqlType: column.getSQLType() } : {}),
      notNull: column.notNull,
      primaryKey: column.primary,
      unique: column.isUnique,
      ...(single?.references ? { references: { table: single.references.table, column: single.references.columns[0] } } : {}),
      ...(typeof column.withTimezone === 'boolean' ? { withTimezone: column.withTimezone } : {}),
      ...(defaultValue ? { default: defaultValue } : {}),
      ...(typeof column.defaultFn === 'function' ? { runtimeDefault: column.defaultFn.toString() } : {}),
    }
  })

  const constraints: SchemaConstraint[] = [
    ...config.indexes.map(({ config: index }) =>
      constraint(index.unique ? 'uniqueIndex' : 'index', index.name, propertyNames(index.columns, keys)),
    ),
    ...config.uniqueConstraints.map((unique) =>
      constraint('unique', unique.getName?.() ?? unique.name, propertyNames(unique.columns, keys)),
    ),
    ...config.primaryKeys.map((primary) =>
      constraint('primaryKey', primary.getName?.() ?? primary.name, propertyNames(primary.columns, keys)),
    ),
    ...foreignKeys,
    ...config.checks.map((check) => constraint('check', check.name, { names: [], opaque: false })),
  ]

  return { identifier: entry.identifier, tableName: config.name, columns, module, dialect: entry.dialect, constraints }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface LoadedSchema {
  module: string | null
  path: string
  drizzleEntry: string
  entries: TableEntry[]
}

async function loadSchemaFile(appRoot: string, module: string | null): Promise<LoadedSchema | RuntimeSchemaFile | null> {
  const path = schemaPathFor(module)
  const file = resolve(appRoot, path)
  if (!(await fileExists(appRoot, path))) return null
  const unreadable = (reason: string): RuntimeSchemaFile => ({ module, path, status: 'unreadable', reason })

  let drizzle: DrizzleCopy
  try {
    drizzle = await loadDrizzle(dirname(file))
  } catch (error) {
    return unreadable(`drizzle-orm could not be loaded from the app: ${reasonOf(error)}`)
  }

  let exports: Record<string, unknown>
  try {
    // The module cache keeps the first import for the life of the process.
    exports = await withTimeout(import(pathToFileURL(file).href) as Promise<Record<string, unknown>>, `importing ${path}`)
  } catch (error) {
    return unreadable(`${path} threw on import: ${reasonOf(error)}`)
  }

  const entries: TableEntry[] = []
  try {
    for (const [identifier, value] of Object.entries(exports)) {
      const dialect = drizzle.dialects.find((candidate) => drizzle.is(value, candidate.tableClass))
      if (!dialect) continue
      const table = value as object
      const config = dialect.getTableConfig(table)
      entries.push({ identifier, table, config, dialect: dialect.dialect, keys: columnKeys(table, config) })
    }
  } catch (error) {
    return unreadable(`getTableConfig() failed: ${reasonOf(error)}`)
  }

  if (entries.length === 0) return unreadable(`no export of ${path} is a drizzle table`)
  return { module, path, drizzleEntry: drizzle.entry, entries }
}

/** One result per `db/schema.ts` that exists, the root's and each module's. Never throws. */
export async function readSchemaAtRuntime(appRoot: string): Promise<RuntimeSchemaFile[]> {
  const roots = await listAppRoots(appRoot)
  const loaded = (await Promise.all(roots.map((root) => loadSchemaFile(appRoot, root.module)))).filter((file) => file !== null)

  // A foreign key may point into another root's schema, so targets resolve across all of them.
  const all = loaded.flatMap((file) => ('entries' in file ? file.entries : []))

  return loaded.map((file): RuntimeSchemaFile => {
    if (!('entries' in file)) return file
    const { module, path, drizzleEntry, entries } = file
    try {
      return { module, path, status: 'read', drizzleEntry, tables: entries.map((entry) => toSchemaTable(entry, all, module)) }
    } catch (error) {
      return { module, path, status: 'unreadable', reason: `getTableConfig() result could not be read: ${reasonOf(error)}` }
    }
  })
}

/** `type` names the builder as written, which drizzle does not keep; the static reader does. */
function withStaticType(table: RuntimeSchemaTable, staticTable: SchemaTable | undefined): RuntimeSchemaTable {
  if (!staticTable) return table
  const types = new Map(staticTable.columns.filter((column) => !column.opaqueBuilder).map((column) => [column.name, column.type]))
  return {
    ...table,
    columns: table.columns.map((column) => {
      const type = types.get(column.name)
      return type ? { ...column, type } : column
    }),
  }
}

/**
 * The runtime reading where a schema file allowed one, the static reading (opaque markers
 * intact) otherwise, each table saying which. A table only the static reader found, one
 * the file does not export, stays `static` beside its file's runtime tables.
 */
export async function readSchemaTables(appRoot: string): Promise<SchemaRead> {
  const [files, staticTables] = await Promise.all([readSchemaAtRuntime(appRoot), parseSchemaTables(appRoot)])
  const tables: SourcedSchemaTable[] = []
  const seen = new Set<SchemaTable>()
  const findStatic = (module: string | null, identifier: string): SchemaTable | undefined =>
    staticTables.find((table) => table.module === module && table.identifier === identifier)

  for (const file of files) {
    if (file.status !== 'read') continue
    for (const table of file.tables) {
      const staticTable = findStatic(file.module, table.identifier)
      if (staticTable) seen.add(staticTable)
      tables.push({ ...withStaticType(table, staticTable), source: 'runtime' })
    }
  }

  for (const table of staticTables) {
    if (seen.has(table)) continue
    const file = files.find((candidate) => candidate.module === table.module)
    const runtimeUnreadable =
      file?.status === 'unreadable' ? file.reason : `${schemaPathFor(table.module)} does not export ${table.identifier} as a drizzle table`
    tables.push({ ...table, source: 'static', runtimeUnreadable })
  }

  return { tables, files }
}
