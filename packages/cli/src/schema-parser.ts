import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type {
  CallExpression,
  File,
  Node,
  ObjectExpression,
  ObjectProperty,
  Statement,
} from '@babel/types'
import { literalString, memberKeyName, objectLiteral, propertyValue, topLevelDeclaration, unwrapTypeAssertion, walk } from './ast-walk'
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

export type SchemaConstraintKind = 'index' | 'uniqueIndex' | 'unique' | 'primaryKey' | 'foreignKey' | 'check'

const CONSTRAINT_BUILDERS = new Set<SchemaConstraintKind>(['index', 'uniqueIndex', 'unique', 'primaryKey', 'foreignKey', 'check'])

/**
 * What the file imports from drizzle, the evidence a call is drizzle's own builder.
 * A local helper (`idColumn()`, `timestamps.createdAt()`) may chain anything inside it,
 * so a call outside these names hides its modifiers rather than lacking them.
 */
interface DrizzleImports {
  /** Local name → imported name, for named imports from `drizzle-orm/*`. */
  named: Map<string, string>
  /** Local names of `import * as p from 'drizzle-orm/*'`. */
  namespaces: Set<string>
}

function collectDrizzleImports(body: Statement[]): DrizzleImports {
  const imports: DrizzleImports = { named: new Map(), namespaces: new Set() }
  for (const node of body) {
    if (node.type !== 'ImportDeclaration') continue
    if (node.source.value !== 'drizzle-orm' && !node.source.value.startsWith('drizzle-orm/')) continue
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') imports.namespaces.add(specifier.local.name)
      if (specifier.type !== 'ImportSpecifier') continue
      const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
      imports.named.set(specifier.local.name, imported)
    }
  }
  return imports
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

/**
 * Every top-level `const <identifier> = <factory>(…)` a parsed schema declares. The one
 * scan behind both readers below, so "is this a table declaration" cannot answer
 * differently depending on which one asked.
 */
function* tableDeclarations(ast: File): Generator<{ identifier: string; call: CallExpression; dialect: SchemaDialect }> {
  const aliases = collectFactoryAliases(ast.program.body)

  for (const node of ast.program.body) {
    const declaration = topLevelDeclaration(node)
    if (!declaration) continue
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== 'Identifier') continue
      if (declarator.init?.type !== 'CallExpression') continue
      const dialect = tableFactoryDialect(declarator.init, aliases)
      if (!dialect) continue
      yield { identifier: declarator.id.name, call: declarator.init, dialect }
    }
  }
}

/**
 * The table identifiers a parsed `db/schema.ts` declares. Needs no columns, so unlike
 * `parseSchemaTables` it keeps a table whose columns are passed as an identifier rather
 * than a literal — the difference that decides which tables an aggregate is asked for.
 */
function declaredTableIdentifiers(ast: File): Set<string> {
  return new Set([...tableDeclarations(ast)].map((table) => table.identifier))
}

export interface SchemaAggregate {
  /** The object literal, for a caller that needs its span. */
  object: ObjectExpression
  /** The statement declaring it, whose start a table's own declaration must precede. */
  statement: Statement
  /** Table identifiers the object lists, in source order. */
  keys: string[]
  /** Every table the same file declares. */
  declared: Set<string>
  /**
   * The file's own evidence that this object is the schema drizzle is handed: named
   * `schema`, or read by a `typeof`. False leaves a caller holding a shape match alone,
   * which a grouping of table shorthands satisfies just as well.
   */
  confident: boolean
}

/** Whether the file reads `name` in a `typeof` position — `export type X = typeof schema`. */
function typeQueried(ast: File, name: string): boolean {
  let found = false
  walk(ast.program, (node) => {
    if (found) return false
    if (node.type !== 'TSTypeQuery') return
    const exprName = node.exprName as { type?: string; name?: string } | undefined
    if (exprName?.type === 'Identifier' && exprName.name === name) found = true
  })
  return found
}

/**
 * The app's hand-kept aggregate of its own tables — `export const schema = { posts, users }`,
 * handed to drizzle for relational queries. Nothing the framework generates reads it, so a
 * table missing a key here leaves it incomplete with nothing to notice. Positive evidence only:
 * every property a shorthand (or `name: name`) reference to a table this file declares,
 * `extraKey` excepted; a second candidate answers null, and `confident` grades what is left.
 */
export function findSchemaAggregate(ast: File, extraKey?: string): SchemaAggregate | null {
  const declared = declaredTableIdentifiers(ast)
  if (declared.size === 0) return null

  let found: SchemaAggregate | null = null

  for (const node of ast.program.body) {
    const declaration = topLevelDeclaration(node)
    if (!declaration) continue

    for (const declarator of declaration.declarations) {
      const object = objectLiteral(declarator.init)
      if (!object || object.properties.length === 0) continue
      if (declarator.id.type !== 'Identifier') continue

      const keys: string[] = []
      let isAggregate = true

      for (const property of object.properties) {
        if (property.type !== 'ObjectProperty') {
          isAggregate = false
          break
        }
        const key = memberKeyName(property)
        const referencesKey =
          property.shorthand || (property.value.type === 'Identifier' && property.value.name === key)
        if (!key || !referencesKey || !(declared.has(key) || key === extraKey)) {
          isAggregate = false
          break
        }
        keys.push(key)
      }
      if (!isAggregate) continue

      // A second candidate means the file's shape does not identify one aggregate,
      // so neither can this.
      if (found) return null

      const name = declarator.id.name
      found = { object, statement: node, keys, declared, confident: name === 'schema' || typeQueried(ast, name) }
    }
  }

  return found
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
  /** `.unique()` on the column; a table-level `unique().on(...)` is a `SchemaConstraint`. */
  unique: boolean
  /** Absent when the chain declares none. */
  default?: SchemaColumnDefault
  /**
   * Set when the chain does not start at a builder the file imports from drizzle (a
   * shared column, a local helper), so `notNull`, `primaryKey`, `unique`, `references`
   * and `default` report only the modifiers written here: false means "not visible".
   */
  opaqueBuilder?: true
}

/**
 * A column default as written, never evaluated. `text` is the argument's source text.
 * `value` is `.default(<expression>)`, `sql` is `.default(sql\`…\`)`, `now` and `random`
 * are `.defaultNow()` / `.defaultRandom()`, and `runtime` is `.$defaultFn()` / `.$default()`,
 * which the database never sees. A database default wins over a runtime one written beside it.
 */
export type SchemaColumnDefault =
  | { kind: 'value' | 'sql' | 'runtime'; text: string }
  | { kind: 'now' | 'random' }

export interface SchemaConstraint {
  kind: SchemaConstraintKind
  name?: string
  /** Set when a name argument is written but is not a static string. */
  opaqueName?: true
  /** Column property names (`SchemaColumn.name`), in the order written. Empty for `check`. */
  columns: string[]
  /** `foreignKey` only: the target table identifier and its column property names. */
  references?: { table: string; columns: string[] }
  /**
   * Set when a column is an expression (`lower(table.email)`, a spread, a variable), so
   * `columns` and `references` list only what was readable and must not be compared.
   */
  opaqueColumns?: true
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
  /** Indexes and constraints the factory's extra-config callback returns. */
  constraints: SchemaConstraint[]
  /**
   * Set when the extra config, or an entry in it, is not a literal this reader follows (a
   * helper call, a spread, a variable): an empty or short `constraints` means "not visible".
   */
  opaqueConstraints?: true
  /** Set when the columns object carries a spread or a computed key, which hides columns. */
  opaqueColumns?: true
}

/**
 * Unwraps `text('title').notNull().references(...)` into the innermost builder name, that
 * builder's own call (which carries its options), and the chained method calls. `rooted`
 * is whether the chain starts at a call the file's drizzle imports account for.
 */
function unwrapColumnChain(
  expression: Node,
  imports: DrizzleImports,
): { type?: string; builder?: CallExpression; methods: Map<string, CallExpression>; rooted: boolean } {
  const methods = new Map<string, CallExpression>()
  let current = unwrapTypeAssertion(expression)

  while (current.type === 'CallExpression') {
    const callee = current.callee
    if (callee.type === 'Identifier') {
      return { type: callee.name, builder: current, methods, rooted: imports.named.has(callee.name) }
    }
    if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') {
      break
    }
    methods.set(callee.property.name, current)
    const object = unwrapTypeAssertion(callee.object)
    if (object.type !== 'CallExpression') {
      return { methods, rooted: object.type === 'Identifier' && imports.namespaces.has(object.name) }
    }
    current = object
  }

  return { methods, rooted: false }
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

/** What a callback returns: an arrow's expression body, or a block's first `return`. */
function returnedExpression(node: Node | undefined): Node | undefined {
  const callback = node ? unwrapTypeAssertion(node) : undefined
  if (callback?.type !== 'ArrowFunctionExpression' && callback?.type !== 'FunctionExpression') return undefined
  if (callback.body.type !== 'BlockStatement') return unwrapTypeAssertion(callback.body)

  for (const statement of callback.body.body) {
    if (statement.type === 'ReturnStatement' && statement.argument) return unwrapTypeAssertion(statement.argument)
  }
  return undefined
}

/**
 * `.references(() => users.id)` → `{ table: 'users', column: 'id' }`. Accepts expression
 * arrows, block-bodied arrows, and function expressions — all valid Drizzle forms.
 */
function extractReference(call: CallExpression | undefined): SchemaColumnReference | undefined {
  const returned = returnedExpression(call?.arguments[0])
  if (
    returned?.type !== 'MemberExpression'
    || returned.object.type !== 'Identifier'
    || returned.property.type !== 'Identifier'
  ) {
    return undefined
  }
  return { table: returned.object.name, column: returned.property.name }
}

function sourceText(source: string, node: Node): string {
  return source.slice(node.start!, node.end!)
}

function isSqlTemplate(node: Node): boolean {
  if (node.type !== 'TaggedTemplateExpression') return false
  const tag = unwrapTypeAssertion(node.tag)
  return tag.type === 'Identifier' && tag.name === 'sql'
}

function extractDefault(methods: Map<string, CallExpression>, source: string): SchemaColumnDefault | undefined {
  const written = methods.get('default')?.arguments[0]
  if (written) {
    return { kind: isSqlTemplate(unwrapTypeAssertion(written)) ? 'sql' : 'value', text: sourceText(source, written) }
  }
  if (methods.has('defaultNow')) return { kind: 'now' }
  if (methods.has('defaultRandom')) return { kind: 'random' }

  const runtime = (methods.get('$defaultFn') ?? methods.get('$default'))?.arguments[0]
  return runtime ? { kind: 'runtime', text: sourceText(source, runtime) } : undefined
}

function columnsFromObject(columnsArg: ObjectExpression, source: string, imports: DrizzleImports): SchemaColumn[] {
  const columns: SchemaColumn[] = []
  for (const prop of columnsArg.properties) {
    if (prop.type !== 'ObjectProperty') continue

    const name = propertyKeyName(prop)
    if (!name) continue

    const { type, builder, methods, rooted } = unwrapColumnChain(prop.value, imports)
    if (!builder && methods.size === 0) {
      columns.push({ name, notNull: false, primaryKey: false, unique: false, opaqueBuilder: true })
      continue
    }

    const nameArg = builder?.arguments[0]
    const columnDefault = extractDefault(methods, source)

    columns.push({
      name,
      columnName: literalString(nameArg) ?? undefined,
      type: type && methods.has('array') ? `${type}[]` : type,
      notNull: methods.has('notNull'),
      primaryKey: methods.has('primaryKey'),
      references: extractReference(methods.get('references')),
      withTimezone: booleanOption(builder, 'withTimezone'),
      ...(hasOpaqueOptions(builder) ? { opaqueOptions: true as const } : {}),
      unique: methods.has('unique'),
      ...(columnDefault ? { default: columnDefault } : {}),
      ...(rooted ? {} : { opaqueBuilder: true as const }),
    })
  }
  return columns
}

/** The names a callback's first parameter binds the table's columns under. */
type ColumnBinding = { table?: string; destructured: Map<string, string> }

function columnBinding(callback: Node): ColumnBinding {
  const binding: ColumnBinding = { destructured: new Map() }
  if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression') return binding

  const param = callback.params[0]
  if (param?.type === 'Identifier') binding.table = param.name
  if (param?.type !== 'ObjectPattern') return binding

  for (const property of param.properties) {
    if (property.type !== 'ObjectProperty' || property.value.type !== 'Identifier') continue
    const key = memberKeyName(property)
    if (key) binding.destructured.set(property.value.name, key)
  }
  return binding
}

function memberName(node: Node): { object: string; property: string } | undefined {
  if (node.type !== 'MemberExpression' || node.object.type !== 'Identifier') return undefined
  const property = node.computed ? literalString(node.property) : node.property.type === 'Identifier' ? node.property.name : null
  return property ? { object: node.object.name, property } : undefined
}

/** `table.email`, `table.email.desc()`, or a destructured `email` → `email`. */
function ownColumn(node: Node, binding: ColumnBinding): string | undefined {
  let current = unwrapTypeAssertion(node)
  while (current.type === 'CallExpression' && current.callee.type === 'MemberExpression') {
    current = unwrapTypeAssertion(current.callee.object)
  }
  if (current.type === 'Identifier') return binding.destructured.get(current.name)
  const member = memberName(current)
  return member && member.object === binding.table ? member.property : undefined
}

/** Resolves every node or reports the list as not fully readable. */
function readList<T>(nodes: ReadonlyArray<Node | null> | undefined, read: (node: Node) => T | undefined): { items: T[]; opaque: boolean } {
  if (!nodes) return { items: [], opaque: true }
  const items: T[] = []
  let opaque = false
  for (const node of nodes) {
    const item = node ? read(node) : undefined
    if (item === undefined) opaque = true
    else items.push(item)
  }
  return { items, opaque }
}

function arrayElements(node: Node | undefined): ReadonlyArray<Node | null> | undefined {
  const array = node ? unwrapTypeAssertion(node) : undefined
  return array?.type === 'ArrayExpression' ? array.elements : undefined
}

function constraintKind(callee: Node, imports: DrizzleImports): SchemaConstraintKind | undefined {
  const name = callee.type === 'Identifier'
    ? imports.named.get(callee.name)
    : callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && imports.namespaces.has(callee.object.name)
      ? memberName(callee)?.property
      : undefined
  return CONSTRAINT_BUILDERS.has(name as SchemaConstraintKind) ? (name as SchemaConstraintKind) : undefined
}

/** One extra-config entry, or undefined when it is not a drizzle constraint builder chain. */
function readConstraint(entry: Node, binding: ColumnBinding, table: string, imports: DrizzleImports): SchemaConstraint | undefined {
  const methods = new Map<string, CallExpression>()
  let current = unwrapTypeAssertion(entry)
  let kind: SchemaConstraintKind | undefined

  while (current.type === 'CallExpression') {
    kind = constraintKind(current.callee, imports)
    if (kind || current.callee.type !== 'MemberExpression' || current.callee.property.type !== 'Identifier') break
    methods.set(current.callee.property.name, current)
    current = unwrapTypeAssertion(current.callee.object)
  }
  if (!kind || current.type !== 'CallExpression') return undefined

  const options = kind === 'primaryKey' || kind === 'foreignKey' ? objectLiteral(current.arguments[0]) : null
  const nameNode = options ? propertyValue(options, 'name') : kind === 'primaryKey' ? undefined : current.arguments[0]
  const name = literalString(nameNode) ?? undefined

  let columnNodes: ReadonlyArray<Node | null> | undefined
  if (kind === 'check') columnNodes = []
  else if (options) columnNodes = arrayElements(propertyValue(options, 'columns'))
  else if (kind === 'primaryKey') columnNodes = current.arguments
  // `.using(method, ...columns)` is Postgres's spelling of `.on(...columns)`.
  else columnNodes = (methods.get('on') ?? methods.get('onOnly'))?.arguments ?? methods.get('using')?.arguments.slice(1)

  const columns = readList(columnNodes, (node) => ownColumn(node, binding))
  const constraint: SchemaConstraint = { kind, ...(name ? { name } : {}), columns: columns.items }
  if (nameNode && !name) constraint.opaqueName = true
  let opaque = columns.opaque

  if (kind === 'foreignKey') {
    const targets = readList(arrayElements(options ? propertyValue(options, 'foreignColumns') : undefined), (node) => memberName(unwrapTypeAssertion(node)))
    const tables = new Set(targets.items.map((target) => (target.object === binding.table ? table : target.object)))
    if (tables.size === 1) constraint.references = { table: [...tables][0], columns: targets.items.map((target) => target.property) }
    opaque ||= targets.opaque || tables.size !== 1
  }

  if (opaque) constraint.opaqueColumns = true
  return constraint
}

function readConstraints(
  extraConfig: Node | undefined,
  table: string,
  imports: DrizzleImports,
): Pick<SchemaTable, 'constraints' | 'opaqueConstraints'> {
  if (!extraConfig) return { constraints: [] }

  const returned = returnedExpression(extraConfig)
  const entries: Array<Node | null> | undefined =
    returned?.type === 'ArrayExpression'
      ? returned.elements
      : returned?.type === 'ObjectExpression'
        ? returned.properties.map((property) => (property.type === 'ObjectProperty' ? property.value : null))
        : undefined

  const binding = columnBinding(unwrapTypeAssertion(extraConfig))
  const { items, opaque } = readList(entries, (entry) => readConstraint(entry, binding, table, imports))
  return { constraints: items, ...(opaque ? { opaqueConstraints: true as const } : {}) }
}

/**
 * Nothing resolves an identifier back to what it names: a spread column set, a shared
 * builder and an extra config built elsewhere are marked not visible (`opaqueColumns`,
 * `opaqueBuilder`, `opaqueConstraints`), never read. A table whose columns argument is
 * not a literal, and a re-exported table, go unreported altogether.
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

  const tables: SchemaTable[] = []
  const imports = collectDrizzleImports(ast.program.body)

  for (const { identifier, call, dialect } of tableDeclarations(ast)) {
    // Columns passed as an identifier rather than a literal: this reader exists to
    // report them, so a table it cannot read contributes nothing.
    const columnsArg = firstObjectArgument(call)
    if (!columnsArg) continue

    tables.push({
      identifier,
      tableName: literalString(call.arguments[0]) ?? undefined,
      columns: columnsFromObject(columnsArg, source, imports),
      module,
      dialect,
      ...readConstraints(call.arguments[call.arguments.findIndex((arg) => objectLiteral(arg) === columnsArg) + 1], identifier, imports),
      ...(columnsArg.properties.some((property) => property.type !== 'ObjectProperty' || property.computed)
        ? { opaqueColumns: true as const }
        : {}),
    })
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
 * The table the `db/schema.ts` of `module` (null for the root) exports bound as
 * `identifier`. Parses that one file, not every app root.
 */
export async function findDeclaredTable(cwd: string, identifier: string, module: string | null = null): Promise<SchemaTable | undefined> {
  const tables = await parseSchemaFile(resolve(cwd, schemaPathFor(module)), module)
  return tables.find((table) => table.identifier === identifier)
}

export async function schemaDeclaresTable(cwd: string, identifier: string, module: string | null = null): Promise<boolean> {
  return (await findDeclaredTable(cwd, identifier, module)) !== undefined
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
