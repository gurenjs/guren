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
 * The drizzle dialect a table is written in, resolved per table from the declaring
 * factory. `patch-helpers.ts` re-exports it for the writers, which answer the same
 * question by sniffing file content instead.
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
 * Local names the table factories are imported under, covering
 * `import { pgTable as table }`. Namespace calls (`p.pgTable(...)`) match by property name.
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
  /** The builder's string argument; absent for drizzle's name-less form. */
  columnName?: string
  /** Drizzle column builder name, e.g. `serial`, `text`, `varchar`. */
  type?: string
  notNull: boolean
  primaryKey: boolean
  references?: SchemaColumnReference
  /**
   * `withTimezone` as written; undefined when omitted or not a boolean literal. Reported
   * as-is — deciding what an omission means is the caller's job.
   */
  withTimezone?: boolean
  /**
   * Set when the options were passed as an expression (`timestamp('c', SHARED_OPTIONS)`),
   * so an absent option field above means "not visible", not "not set".
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
  /** Which factory declared the table. Per-table: one `db/schema.ts` may mix dialects. */
  dialect: SchemaDialect
}

/**
 * Unwraps `text('title').notNull().references(...)` into the innermost builder name, that
 * builder's own call (which carries its options), and the chained method calls.
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

function propertyKeyName(property: ObjectProperty): string | undefined {
  return memberKeyName(property)
}

/**
 * The first object-literal argument of a call. Scanned rather than indexed, since drizzle
 * accepts both `timestamp('created_at', { … })` and the name-less `timestamp({ … })`.
 */
function firstObjectArgument(call: CallExpression | undefined): ObjectExpression | undefined {
  for (const argument of call?.arguments ?? []) {
    const literal = objectLiteral(argument)
    if (literal) return literal
  }
  return undefined
}

/**
 * Whether a builder's options were passed as anything but an inline object literal.
 * Nothing about such a call reads statically, so callers must treat an absent option as
 * "unknown" rather than "not set".
 */
function hasOpaqueOptions(call: CallExpression | undefined): boolean {
  if (!call) return false
  return call.arguments.some((arg) => {
    // Both tests apply to the unwrapped node: reading `{ … } as const` as opaque turns a
    // fully static declaration into an unknown, and a written option stops being checked.
    const argument = unwrapTypeAssertion(arg)
    if (argument.type === 'StringLiteral') return false
    if (argument.type !== 'ObjectExpression') return true
    // A spread hides every option it carries, so `timestamp('c', { ...SHARED })` must
    // read as unknown rather than "withTimezone absent".
    return argument.properties.some((property) => property.type === 'SpreadElement')
  })
}

/**
 * A boolean option off the builder's options object; undefined when absent or not a
 * boolean literal. A `satisfies` / `as const` wrapper is unwrapped on both sides, since
 * `{ withTimezone: true } as const` is the same `true` to Postgres.
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
 * `.references(() => users.id)` → `{ table: 'users', column: 'id' }`. Accepts expression
 * arrows, block-bodied arrows, and function expressions — all valid Drizzle forms.
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
 * Two known limitations. The factory's third argument (composite keys via
 * `(table) => [...]`) is not parsed, so only column-level `.primaryKey()` /
 * `.references()` surface. And nothing resolves an identifier back to what it names, so
 * spread columns (`...timestamps`), aliased or namespaced builders, and re-exported
 * tables go unreported — indistinguishable to consumers from a clean schema.
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
 * Every Drizzle table declared in the project's and each module's `db/schema.ts` (parsed
 * via Babel AST — never executed). Missing or unparsable files contribute nothing.
 */
export async function parseSchemaTables(cwd: string): Promise<SchemaTable[]> {
  const roots = await listAppRoots(cwd)
  const groups = await Promise.all(
    roots.map((root) => parseSchemaFile(resolve(root.dir, 'db/schema.ts'), root.module)),
  )
  return groups.flat()
}

/**
 * The project-relative `db/schema.ts` a module's tables are declared in, or the root
 * schema for `null` — the path every consumer reports back to the user.
 */
export function schemaPathFor(module: string | null | undefined): string {
  return module ? `modules/${module}/db/schema.ts` : 'db/schema.ts'
}

/**
 * Table identifier → column names, or null when no tables were found. Every app root is
 * flattened into one map, so two modules declaring the same identifier collide, last one
 * winning; callers needing the declaring module read `parseSchemaTables` instead.
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
