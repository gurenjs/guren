import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { parse } from '@babel/parser'
import type { Expression, CallExpression, ObjectExpression, Statement } from '@babel/types'
import { listAppRoots } from './discovery'

const TABLE_FACTORIES = new Set(['pgTable', 'sqliteTable', 'mysqlTable'])

/**
 * Local names the table factories are imported under — covers
 * `import { pgTable as table }` aliases. Namespace-qualified calls
 * (`p.pgTable(...)`) are matched by property name instead.
 */
function collectFactoryAliases(body: Statement[]): Set<string> {
  const aliases = new Set(TABLE_FACTORIES)
  for (const node of body) {
    if (node.type !== 'ImportDeclaration') continue
    for (const specifier of node.specifiers) {
      if (
        specifier.type === 'ImportSpecifier'
        && specifier.imported.type === 'Identifier'
        && TABLE_FACTORIES.has(specifier.imported.name)
      ) {
        aliases.add(specifier.local.name)
      }
    }
  }
  return aliases
}

function isTableFactoryCall(call: CallExpression, aliases: Set<string>): boolean {
  const callee = call.callee
  if (callee.type === 'Identifier') return aliases.has(callee.name)
  return (
    callee.type === 'MemberExpression'
    && callee.property.type === 'Identifier'
    && TABLE_FACTORIES.has(callee.property.name)
  )
}

export interface SchemaColumnReference {
  /** Exported table identifier the FK points at, e.g. `users`. */
  table: string
  column: string
}

export interface SchemaColumn {
  name: string
  /** Drizzle column builder name, e.g. `serial`, `text`, `varchar`. */
  type?: string
  notNull: boolean
  primaryKey: boolean
  references?: SchemaColumnReference
}

export interface SchemaTable {
  /** Exported variable identifier, e.g. `posts` — what models bind via `static table`. */
  identifier: string
  /** Database table name (the factory's string argument), when present. */
  tableName?: string
  columns: SchemaColumn[]
  /** Module whose `db/schema.ts` declares the table, or null for the root schema. */
  module: string | null
}

/**
 * Unwraps a column builder chain like
 * `text('title').notNull().references(() => users.id)` into the innermost
 * builder name plus the chained method calls.
 */
function unwrapColumnChain(
  expression: Expression,
): { type?: string; methods: Map<string, CallExpression> } {
  const methods = new Map<string, CallExpression>()
  let current: Expression = expression

  while (current.type === 'CallExpression') {
    const callee = current.callee
    if (callee.type === 'Identifier') {
      return { type: callee.name, methods }
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

    let name: string | undefined
    if (prop.key.type === 'Identifier') name = prop.key.name
    else if (prop.key.type === 'StringLiteral') name = prop.key.value
    if (!name) continue

    if (prop.value.type !== 'CallExpression') {
      columns.push({ name, notNull: false, primaryKey: false })
      continue
    }

    const { type, methods } = unwrapColumnChain(prop.value)
    columns.push({
      name,
      type: type && methods.has('array') ? `${type}[]` : type,
      notNull: methods.has('notNull'),
      primaryKey: methods.has('primaryKey'),
      references: extractReference(methods.get('references')),
    })
  }
  return columns
}

/**
 * Known limitation: the table factory's third argument (composite primary
 * keys / foreign keys declared via `(table) => [...]`) is not parsed —
 * only column-level `.primaryKey()` and `.references()` chains surface.
 */
async function parseSchemaFile(schemaPath: string, module: string | null): Promise<SchemaTable[]> {
  let source: string
  try {
    source = await readFile(schemaPath, 'utf-8')
  } catch {
    return []
  }

  let ast: ReturnType<typeof parse>
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  } catch {
    return []
  }

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
      if (!isTableFactoryCall(declarator.init, aliases)) continue

      const nameArg = declarator.init.arguments[0]
      const tableName = nameArg?.type === 'StringLiteral' ? nameArg.value : undefined

      const columnsArg = declarator.init.arguments.find(
        (arg): arg is ObjectExpression => arg.type === 'ObjectExpression',
      )
      if (!columnsArg) continue

      tables.push({
        identifier: declarator.id.name,
        tableName,
        columns: columnsFromObject(columnsArg),
        module,
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
 * Table identifier → column names, or null when no tables were found.
 * The narrow view the audit's sensitive-column check and the entity
 * context's column listing consume.
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
