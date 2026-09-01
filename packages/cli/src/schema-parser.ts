import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type {
  Expression,
  CallExpression,
  ObjectExpression,
  ObjectProperty,
  Statement,
} from '@babel/types'
import { literalString, memberKeyName, objectLiteral, unwrapTypeAssertion } from './ast-walk'
import { listAppRoots } from './discovery'
import { parseSourceFile } from './parse-cache'

/**
 * The drizzle dialect a table (or an app's `db/schema.ts`) is written in.
 * Lives here, with the parser that resolves it per table from the declaring
 * factory; `patch-helpers.ts` re-exports it for the writers, which answer the
 * same question by sniffing file content instead.
 */
export type SchemaDialect = 'sqlite' | 'pg' | 'mysql'

// A Map rather than a Record so a miss types as undefined —
// `noUncheckedIndexedAccess` is off, and every lookup here is a miss away.
const TABLE_FACTORIES = new Map<string, SchemaDialect>([
  ['pgTable', 'pg'],
  ['sqliteTable', 'sqlite'],
  ['mysqlTable', 'mysql'],
])

/**
 * Local names the table factories are imported under, mapped to the dialect
 * each one declares — covers `import { pgTable as table }` aliases.
 * Namespace-qualified calls (`p.pgTable(...)`) are matched by property name
 * instead.
 */
function collectFactoryAliases(body: Statement[]): Map<string, SchemaDialect> {
  const aliases = new Map<string, SchemaDialect>(TABLE_FACTORIES)
  for (const node of body) {
    if (node.type !== 'ImportDeclaration') continue
    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || specifier.imported.type !== 'Identifier') continue
      const dialect = TABLE_FACTORIES.get(specifier.imported.name)
      if (dialect) aliases.set(specifier.local.name, dialect)
    }
  }
  return aliases
}

/** The dialect a table factory call declares, or undefined if it isn't one. */
function tableFactoryDialect(
  call: CallExpression,
  aliases: Map<string, SchemaDialect>,
): SchemaDialect | undefined {
  const callee = call.callee
  if (callee.type === 'Identifier') return aliases.get(callee.name)
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    return TABLE_FACTORIES.get(callee.property.name)
  }
  return undefined
}

export interface SchemaColumnReference {
  /** Exported table identifier the FK points at, e.g. `users`. */
  table: string
  column: string
}

export interface SchemaColumn {
  name: string
  /**
   * Database column name (the builder's string argument), when present.
   * Absent for drizzle's name-less form, where it is derived from `name`.
   */
  columnName?: string
  /** Drizzle column builder name, e.g. `serial`, `text`, `varchar`. */
  type?: string
  notNull: boolean
  primaryKey: boolean
  references?: SchemaColumnReference
  /**
   * The builder's `withTimezone` option as written: `true`, `false`, or
   * undefined when it was omitted (or written as something other than a
   * boolean literal). Reported as-is — deciding what an omission means is
   * the caller's job.
   */
  withTimezone?: boolean
  /**
   * Set when the builder's options were passed as an expression rather than
   * an inline object (`timestamp('created_at', SHARED_OPTIONS)`). None of the
   * option fields above can be read in that case, so an absent one means
   * "not visible", not "not set".
   */
  opaqueOptions?: true
}

export interface SchemaTable {
  /** Exported variable identifier, e.g. `posts` — what models bind via `static table`. */
  identifier: string
  /** Database table name (the factory's string argument), when present. */
  tableName?: string
  columns: SchemaColumn[]
  /** Module whose `db/schema.ts` declares the table, or null for the root schema. */
  module: string | null
  /**
   * Which factory declared the table. Per-table rather than per-file because
   * drizzle's table builders accept a foreign dialect's column builders, so
   * one `db/schema.ts` can legally mix them.
   */
  dialect: SchemaDialect
}

/**
 * Unwraps a column builder chain like
 * `text('title').notNull().references(() => users.id)` into the innermost
 * builder name, that builder's own call (which carries its options), and
 * the chained method calls.
 */
function unwrapColumnChain(
  expression: Expression,
): { type?: string; builder?: CallExpression; methods: Map<string, CallExpression> } {
  const methods = new Map<string, CallExpression>()
  let current: Expression = expression

  while (current.type === 'CallExpression') {
    const callee = current.callee
    if (callee.type === 'Identifier') {
      return { type: callee.name, builder: current, methods }
    }
    if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') {
      break
    }
    methods.set(callee.property.name, current)
    if (callee.object.type !== 'CallExpression') break
    current = callee.object
  }

  return { type: undefined, methods }
}

/** The name of an object property key, for both `{ k: v }` and `{ 'k': v }`. */
function propertyKeyName(property: ObjectProperty): string | undefined {
  return memberKeyName(property)
}

/**
 * The first object-literal argument of a call — a table factory's column map,
 * or a column builder's options. Found by scanning rather than indexing,
 * since drizzle accepts both `timestamp('created_at', { … })` and the
 * name-less `timestamp({ … })`.
 */
function firstObjectArgument(call: CallExpression | undefined): ObjectExpression | undefined {
  for (const argument of call?.arguments ?? []) {
    const literal = objectLiteral(argument)
    if (literal) return literal
  }
  return undefined
}

/**
 * Whether a builder's options were passed as anything other than an inline
 * object literal — `timestamp('created_at', SHARED_OPTIONS)`. Nothing about
 * such a call can be read statically, so an option that looks absent may
 * simply be invisible. Callers that would otherwise conclude "not set" have
 * to treat this as "unknown" instead.
 */
function hasOpaqueOptions(call: CallExpression | undefined): boolean {
  if (!call) return false
  return call.arguments.some((arg) => {
    // Both tests apply to the unwrapped node: `{ … } as const` is the same
    // object drizzle receives, and `timestamp('x' as const)` is the same
    // name — reading either as opaque turns a fully static declaration into
    // an unknown, which is how a written option stops being checked.
    const argument = unwrapTypeAssertion(arg)
    if (argument.type === 'StringLiteral') return false
    if (argument.type !== 'ObjectExpression') return true
    // A spread hides every option it carries, so an inline object holding one
    // proves no more than an identifier does: `timestamp('c', { ...SHARED })`
    // has to read as unknown, not as "withTimezone absent", or the check
    // warns about a column the runtime already got right.
    return argument.properties.some((property) => property.type === 'SpreadElement')
  })
}

/**
 * A boolean option off the builder's own options object, e.g. the
 * `withTimezone` in `timestamp('created_at', { withTimezone: true })`.
 * Undefined when absent or not written as a boolean literal. A `satisfies`
 * or `as const` wrapper is unwrapped on both sides — the options object via
 * {@link firstObjectArgument} and the value here — because
 * `{ withTimezone: true } as const` is the same `true` to Postgres either
 * way, and reading it as "unset" would be a false alarm.
 */
function booleanOption(builder: CallExpression | undefined, option: string): boolean | undefined {
  const options = firstObjectArgument(builder)
  if (!options) return undefined

  for (const prop of options.properties) {
    if (prop.type !== 'ObjectProperty' || propertyKeyName(prop) !== option) continue
    const value = unwrapTypeAssertion(prop.value)
    return value.type === 'BooleanLiteral' ? value.value : undefined
  }
  return undefined
}

/**
 * `.references(() => users.id)` → `{ table: 'users', column: 'id' }`.
 * Accepts expression arrows, block-bodied arrows, and plain function
 * expressions — all valid Drizzle forms.
 */
function extractReference(call: CallExpression | undefined): SchemaColumnReference | undefined {
  const arg = call?.arguments[0]
  if (!arg || (arg.type !== 'ArrowFunctionExpression' && arg.type !== 'FunctionExpression')) {
    return undefined
  }

  let returned: Expression | null = null
  if (arg.body.type === 'BlockStatement') {
    for (const statement of arg.body.body) {
      if (statement.type === 'ReturnStatement' && statement.argument) {
        returned = statement.argument
        break
      }
    }
  } else {
    returned = arg.body
  }

  if (
    !returned
    || returned.type !== 'MemberExpression'
    || returned.object.type !== 'Identifier'
    || returned.property.type !== 'Identifier'
  ) {
    return undefined
  }
  return { table: returned.object.name, column: returned.property.name }
}

function columnsFromObject(columnsArg: ObjectExpression): SchemaColumn[] {
  const columns: SchemaColumn[] = []
  for (const prop of columnsArg.properties) {
    if (prop.type !== 'ObjectProperty') continue

    const name = propertyKeyName(prop)
    if (!name) continue

    if (prop.value.type !== 'CallExpression') {
      columns.push({ name, notNull: false, primaryKey: false })
      continue
    }

    const { type, builder, methods } = unwrapColumnChain(prop.value)
    const nameArg = builder?.arguments[0]

    columns.push({
      name,
      columnName: literalString(nameArg) ?? undefined,
      type: type && methods.has('array') ? `${type}[]` : type,
      notNull: methods.has('notNull'),
      primaryKey: methods.has('primaryKey'),
      references: extractReference(methods.get('references')),
      withTimezone: booleanOption(builder, 'withTimezone'),
      ...(hasOpaqueOptions(builder) ? { opaqueOptions: true as const } : {}),
    })
  }
  return columns
}

/**
 * Known limitation: the table factory's third argument (composite primary
 * keys / foreign keys declared via `(table) => [...]`) is not parsed —
 * only column-level `.primaryKey()` and `.references()` chains surface.
 *
 * Known limitation: nothing here resolves an identifier back to what it
 * names, so several legal spellings go unreported rather than misreported —
 * columns introduced by a spread (`...timestamps`, the shared-column idiom),
 * column builders reached through an alias (`timestamp as ts`) or a namespace
 * (`p.timestamp(...)`), and tables declared in a file the schema merely
 * re-exports. Every consumer treats an absent column as one with nothing to
 * say, which is indistinguishable from a clean one — a schema written any of
 * those ways is under-reported, not verified.
 */
async function parseSchemaFile(schemaPath: string, module: string | null): Promise<SchemaTable[]> {
  let source: string
  try {
    source = await readFile(schemaPath, 'utf-8')
  } catch {
    return []
  }

  const ast = parseSourceFile(source, schemaPath)
  if (!ast) return []

  const aliases = collectFactoryAliases(ast.program.body)
  const tables: SchemaTable[] = []

  for (const node of ast.program.body) {
    const declaration =
      node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration'
        ? node.declaration
        : node.type === 'VariableDeclaration'
          ? node
          : null
    if (!declaration) continue

    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== 'Identifier') continue
      if (declarator.init?.type !== 'CallExpression') continue
      const dialect = tableFactoryDialect(declarator.init, aliases)
      if (!dialect) continue

      const tableName = literalString(declarator.init.arguments[0]) ?? undefined

      const columnsArg = firstObjectArgument(declarator.init)
      if (!columnsArg) continue

      tables.push({
        identifier: declarator.id.name,
        tableName,
        columns: columnsFromObject(columnsArg),
        module,
        dialect,
      })
    }
  }

  return tables
}

/**
 * Every Drizzle table declared in `db/schema.ts` plus each module's
 * `db/schema.ts` (parsed via Babel AST — never executed). Missing or
 * unparsable files contribute nothing rather than failing, so consumers
 * degrade the same way the audit's hidden-column check always has.
 */
export async function parseSchemaTables(cwd: string): Promise<SchemaTable[]> {
  const roots = await listAppRoots(cwd)
  const groups = await Promise.all(
    roots.map((root) => parseSchemaFile(resolve(root.dir, 'db/schema.ts'), root.module)),
  )
  return groups.flat()
}

/**
 * The project-relative `db/schema.ts` a module's tables are declared in, or
 * the root schema for `null`. The path every consumer reports back to the
 * user, kept next to `parseSchemaTables` — which is what decides that a
 * module's tables live under `modules/<name>/`.
 */
export function schemaPathFor(module: string | null | undefined): string {
  return module ? `modules/${module}/db/schema.ts` : 'db/schema.ts'
}

/**
 * Table identifier → column names, or null when no tables were found.
 * The narrow view the audit's sensitive-column check and the entity
 * context's column listing consume.
 *
 * Every app root is flattened into one map, so two modules declaring the same
 * identifier collide, last one winning. Callers that need the declaring module
 * (`guren check`'s model-table binding does) read `parseSchemaTables` instead.
 */
export async function parseSchemaTableColumns(cwd: string): Promise<Map<string, string[]> | null> {
  const tables = await parseSchemaTables(cwd)
  if (tables.length === 0) return null

  const columns = new Map<string, string[]>()
  for (const table of tables) {
    columns.set(table.identifier, table.columns.map((column) => column.name))
  }
  return columns
}
