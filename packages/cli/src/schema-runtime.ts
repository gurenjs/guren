/**
 * Reads `db/schema.ts` by importing it and asking drizzle's `getTableConfig()`, which sees
 * what the static reader marks opaque: spread columns, helper builders, the columns
 * callback, `pgTableCreator`, an extra config built elsewhere. Importing runs app code,
 * so edit hooks, `guren check` and the scaffolders stay on `parseSchemaTables()`.
 * Every failure is a per-file result, never a throw and never an empty table list.
 */
import { realpath, stat } from 'node:fs/promises'
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

export type SchemaSource = 'runtime' | 'static'

/** `sqlType` is drizzle's `getSQLType()`, the one type fact the runtime holds; `type` is the builder as written. */
export interface RuntimeSchemaColumn extends SchemaColumn {
  sqlType?: string
  /** Set when a chunk of the SQL default is one this reader cannot render, shown as `?` in its text. */
  opaqueDefault?: true
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

export interface SchemaRuntimeOptions {
  /** How long one `db/schema.ts` may take to import. Defaults to 5000. */
  importTimeoutMs?: number
  /** @internal Import boundary for deterministic timeout and failure tests. */
  importSchema?: (url: string) => Promise<Record<string, unknown>>
}

/**
 * Resolves with the ESM conditions the schema's own `import` gets, so both land on one
 * module instance. `createRequire().resolve` names the `.cjs` build, a second copy.
 */
function resolveFrom(specifier: string, directory: string): string {
  if (typeof Bun === 'undefined') throw new Error('reading a schema at runtime requires Bun')
  return Bun.resolveSync(specifier, directory)
}

/** `drizzle-orm` as the schema file sees it: its own dependency, or the one `@guren/orm` installs. */
function resolveDrizzle(specifier: string, schemaDir: string): string {
  try {
    return resolveFrom(specifier, schemaDir)
  } catch (error) {
    try {
      return resolveFrom(specifier, dirname(resolveFrom('@guren/orm/package.json', schemaDir)))
    } catch {
      throw error
    }
  }
}

async function loadDrizzle(schemaDir: string): Promise<DrizzleCopy> {
  const entry = resolveDrizzle('drizzle-orm', schemaDir)
  const core = (await import(pathToFileURL(entry).href)) as { is: DrizzleCopy['is'] }

  const dialects = await Promise.all(
    DIALECT_SUBPATHS.map(async ({ dialect, subpath, tableClass }): Promise<DialectModule> => {
      const loaded = (await import(pathToFileURL(resolveDrizzle(subpath, schemaDir)).href)) as Record<string, unknown>
      return { dialect, tableClass: loaded[tableClass], getTableConfig: loaded.getTableConfig as DialectModule['getTableConfig'] }
    }),
  )
  return { entry, is: core.is, dialects }
}

/** Bound the wait independently of the module loader's top-level-await behavior. */
export function withImportTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the import did not finish within ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}

function isSql(value: unknown): value is RuntimeSql {
  return typeof value === 'object' && value !== null && Array.isArray((value as RuntimeSql).queryChunks)
}

const TABLE_NAME = Symbol.for('drizzle:Name')

/**
 * A drizzle `sql` object as text, from its chunks: never through a dialect, never evaluated.
 * `opaque` is set for a chunk with no rendering here (a placeholder, a view), written `?`.
 */
function sqlText(sql: RuntimeSql): { text: string; opaque: boolean } {
  let opaque = false
  const text = sql.queryChunks
    .map((chunk): string => {
      if (typeof chunk !== 'object' || chunk === null) return String(chunk)
      if (isSql(chunk)) {
        const nested = sqlText(chunk)
        opaque ||= nested.opaque
        return nested.text
      }
      const record = chunk as { value?: unknown; name?: unknown; table?: unknown; [TABLE_NAME]?: unknown }
      if (Array.isArray(record.value)) return record.value.join('')
      // `name` alone is not a column: a placeholder carries one too.
      if (typeof record.name === 'string' && typeof record.table === 'object') return record.name
      if (typeof record[TABLE_NAME] === 'string') return record[TABLE_NAME]
      if ('value' in record) return literalText(record.value)
      opaque = true
      return '?'
    })
    .join('')
  return { text, opaque }
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
function columnDefault(column: RuntimeColumn): { default?: SchemaColumnDefault; opaqueDefault?: true } {
  if (column.default === undefined) return {}
  if (!isSql(column.default)) return { default: { kind: 'value', text: literalText(column.default) } }
  const { text, opaque } = sqlText(column.default)
  return { default: { kind: 'sql', text }, ...(opaque ? { opaqueDefault: true as const } : {}) }
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
    return {
      name,
      columnName: column.name,
      ...(column.getSQLType ? { sqlType: column.getSQLType() } : {}),
      notNull: column.notNull,
      primaryKey: column.primary,
      unique: column.isUnique,
      ...(single?.references ? { references: { table: single.references.table, column: single.references.columns[0] } } : {}),
      ...(typeof column.withTimezone === 'boolean' ? { withTimezone: column.withTimezone } : {}),
      ...columnDefault(column),
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

async function loadSchemaFile(appRoot: string, module: string | null, timeoutMs: number, importSchema: NonNullable<SchemaRuntimeOptions['importSchema']>): Promise<LoadedSchema | RuntimeSchemaFile | null> {
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
    exports = await withImportTimeout(importSchema(pathToFileURL(file).href), timeoutMs)
  } catch (error) {
    return unreadable(`${path} could not be imported: ${reasonOf(error)}`)
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

const moduleCache = createRequire(import.meta.url).cache
const importedAt = new Map<string, number>()

/**
 * Bun keeps ESM modules in `require.cache`, and a query string does not bust it. A schema
 * edited since this process imported it is evicted, or a long-lived process reports the
 * old tables as a runtime reading. Files the schema imports are not tracked.
 */
async function evictIfChanged(file: string): Promise<void> {
  try {
    const path = await realpath(file)
    const { mtimeMs } = await stat(path)
    const previous = importedAt.get(path)
    if (previous !== undefined && previous !== mtimeMs) {
      delete moduleCache[path]
      delete moduleCache[file]
    }
    importedAt.set(path, mtimeMs)
  } catch {
    // A file that cannot be stat'ed is reported by the import that follows.
  }
}

/**
 * One table object exported more than once (an alias, `export *` from another root's
 * schema) is the table of the export the static reader sees declared. With no declared
 * export to prefer, every export stays.
 */
function dropReexports(loaded: LoadedSchema[], staticTables: SchemaTable[]): void {
  const declared = (module: string | null, identifier: string): boolean =>
    staticTables.some((table) => table.module === module && table.identifier === identifier)

  const exportsOf = new Map<object, { file: LoadedSchema; entry: TableEntry }[]>()
  for (const file of loaded) {
    for (const entry of file.entries) exportsOf.set(entry.table, [...(exportsOf.get(entry.table) ?? []), { file, entry }])
  }

  for (const group of exportsOf.values()) {
    if (group.length < 2 || !group.some(({ file, entry }) => declared(file.module, entry.identifier))) continue
    for (const { file, entry } of group) {
      if (!declared(file.module, entry.identifier)) file.entries = file.entries.filter((candidate) => candidate !== entry)
    }
  }
}

async function readRuntimeFiles(appRoot: string, options: SchemaRuntimeOptions, staticTables: SchemaTable[]): Promise<RuntimeSchemaFile[]> {
  const roots = await listAppRoots(appRoot)
  const timeoutMs = options.importTimeoutMs ?? IMPORT_TIMEOUT_MS

  // Evicted together and before any import: a module schema importing the root's must not
  // pin the old root instance, whose tables a foreign key would then fail to match.
  await Promise.all(roots.map((root) => evictIfChanged(resolve(appRoot, schemaPathFor(root.module)))))
  const loaded = (await Promise.all(roots.map((root) => loadSchemaFile(appRoot, root.module, timeoutMs, options.importSchema ?? ((url) => import(url)))))).filter((file) => file !== null)

  const readable = loaded.filter((file): file is LoadedSchema => 'entries' in file)
  dropReexports(readable, staticTables)

  // A foreign key may point into another root's schema, so targets resolve across all of them.
  const all = readable.flatMap((file) => file.entries)

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

/** One result per `db/schema.ts` that exists, the root's and each module's. Never throws. */
export async function readSchemaAtRuntime(appRoot: string, options: SchemaRuntimeOptions = {}): Promise<RuntimeSchemaFile[]> {
  return readRuntimeFiles(appRoot, options, await parseSchemaTables(appRoot))
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
export async function readSchemaTables(appRoot: string, options: SchemaRuntimeOptions = {}): Promise<SchemaRead> {
  const staticTables = await parseSchemaTables(appRoot)
  const files = await readRuntimeFiles(appRoot, options, staticTables)
  const tables: SourcedSchemaTable[] = []
  const unmatched = [...staticTables]
  const claimStatic = (module: string | null, identifier: string): SchemaTable | undefined => {
    const index = unmatched.findIndex((table) => table.module === module && table.identifier === identifier)
    return index === -1 ? undefined : unmatched.splice(index, 1)[0]
  }

  for (const file of files) {
    if (file.status !== 'read') continue
    for (const table of file.tables) {
      tables.push({ ...withStaticType(table, claimStatic(file.module, table.identifier)), source: 'runtime' })
    }
  }

  for (const table of unmatched) {
    const file = files.find((candidate) => candidate.module === table.module)
    const runtimeUnreadable =
      file?.status === 'unreadable' ? file.reason : `${schemaPathFor(table.module)} does not export ${table.identifier} as a drizzle table`
    tables.push({ ...table, source: 'static', runtimeUnreadable })
  }

  return { tables, files }
}
