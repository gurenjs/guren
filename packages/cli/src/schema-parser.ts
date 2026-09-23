import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type {
  CallExpression,
  File,
  Node,
  ObjectExpression,
  Statement,
} from '@babel/types'
import {
  literalString,
  memberKeyName,
  nodeText,
  objectLiteral,
  propertyValue,
  staticProperty,
  topLevelDeclaration,
  unwrapTypeAssertion,
  walk,
} from './ast-walk'
import { listAppRoots } from './discovery'
import { importsByLocal, schemaModuleFor } from './schema-binding'
import { camelCase } from './utils'
import { isDrizzleBuilderSpecifier } from './drizzle-specifiers'
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
  /** Local name → imported name, for named imports from a drizzle builder module. */
  named: Map<string, string>
  /** Local names of `import * as p from '<drizzle builder module>'`. */
  namespaces: Set<string>
}

function collectDrizzleImports(body: Statement[]): DrizzleImports {
  const imports: DrizzleImports = { named: new Map(), namespaces: new Set() }
  for (const node of body) {
    if (node.type !== 'ImportDeclaration') continue
    if (!isDrizzleBuilderSpecifier(node.source.value)) continue
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') imports.namespaces.add(specifier.local.name)
      if (specifier.type !== 'ImportSpecifier') continue
      const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
      imports.named.set(specifier.local.name, imported)
    }
  }
  return imports
}

/** The drizzle export a callee names, through a local alias or a namespace member. */
function drizzleName(callee: Node, imports: DrizzleImports): string | undefined {
  if (callee.type === 'Identifier') return imports.named.get(callee.name)
  const member = memberName(callee)
  return member && imports.namespaces.has(member.object) ? member.property : undefined
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
      const init = declarator.init ? unwrapTypeAssertion(declarator.init) : undefined
      if (init?.type !== 'CallExpression') continue
      const dialect = tableFactoryDialect(init, aliases)
      if (!dialect) continue
      yield { identifier: declarator.id.name, call: init, dialect }
    }
  }
}

/**
 * The table identifiers a parsed `db/schema.ts` declares. Needs no columns, so unlike
 * `parseSchemaTables` it keeps a table whose columns are passed as an identifier rather
 * than a literal — the difference that decides which tables an aggregate is asked for.
 */
export function declaredTableIdentifiers(ast: File): Set<string> {
  return new Set([...tableDeclarations(ast)].map((table) => table.identifier))
}

export interface SchemaAggregate {
  /** The object literal, for a caller that needs its span. */
  object: ObjectExpression
  /** The statement declaring it, whose start a table's own declaration must precede. */
  statement: Statement
  /** Keys the object lists, in source order: tables the file declares and ones it imports. */
  keys: string[]
  /** Every table the same file declares. */
  declared: Set<string>
  /** Module → the names of its tables the object lists as keys imported from that module's schema. */
  listed: Map<string, Set<string>>
  /** Module → the export the object spreads (`...billingSchema`), `''` for a namespace import. */
  delegated: Map<string, string>
  /**
   * The file's own evidence that this object is the schema drizzle is handed: named
   * `schema` or `identifiedAs`, or read by a `typeof`. False leaves a caller holding a shape
   * match alone, which a grouping of table shorthands satisfies just as well.
   */
  confident: boolean
}

export interface FindSchemaAggregateOptions {
  /** A key accepted as if the file declared it: the table a writer is about to add. */
  extraKey?: string
  /**
   * Where the file sits, so an import can be resolved to the module schema it names.
   * Without it, a key or spread reaching another file is not evidence of an aggregate.
   */
  location?: { cwd: string; file: string }
  /** A name another file vouches for: the export the root schema object spreads from this module. */
  identifiedAs?: string
}

/** The names the file reads in a `typeof` position — `export type X = typeof schema`. */
function typeQueriedNames(ast: File): Set<string> {
  const names = new Set<string>()
  walk(ast.program, (node) => {
    if (node.type !== 'TSTypeQuery') return
    const exprName = node.exprName as { type?: string; name?: string } | undefined
    if (exprName?.type === 'Identifier' && exprName.name) names.add(exprName.name)
  })
  return names
}

/**
 * The app's hand-kept aggregate of its tables (`export const schema = { posts, users }`), handed
 * to drizzle for relational queries; nothing generated reads it, so a missing key goes unnoticed.
 * Positive evidence only: every property a table this file declares (shorthand or `name: name`),
 * a key or spread imported from a module's schema, or `extraKey`; `{}` only when `confident`.
 * A second candidate answers null, and `confident` grades what is left.
 */
export function findSchemaAggregate(ast: File, options: FindSchemaAggregateOptions = {}): SchemaAggregate | null {
  const { extraKey, location, identifiedAs } = options
  const declared = declaredTableIdentifiers(ast)
  // `name` is the export a local binds, `''` for a namespace import.
  const moduleImports = new Map<string, { module: string; name: string }>()
  if (location) {
    for (const [local, entry] of importsByLocal(ast.program.body)) {
      if (entry.kind === 'default') continue
      const module = schemaModuleFor(location.cwd, location.file, entry.source)
      if (typeof module === 'string') moduleImports.set(local, { module, name: entry.imported })
    }
  }

  let typeQueried: Set<string> | undefined
  let found: SchemaAggregate | null = null

  for (const node of ast.program.body) {
    const declaration = topLevelDeclaration(node)
    if (!declaration) continue

    for (const declarator of declaration.declarations) {
      const object = objectLiteral(declarator.init)
      if (!object || declarator.id.type !== 'Identifier') continue

      const keys: string[] = []
      const listed = new Map<string, Set<string>>()
      const delegated = new Map<string, string>()
      let isAggregate = true

      for (const property of object.properties) {
        if (property.type === 'SpreadElement') {
          const source = property.argument.type === 'Identifier' ? moduleImports.get(property.argument.name) : undefined
          if (!source) {
            isAggregate = false
            break
          }
          delegated.set(source.module, source.name)
          continue
        }
        if (property.type !== 'ObjectProperty') {
          isAggregate = false
          break
        }
        const key = memberKeyName(property)
        const referencesKey =
          property.shorthand || (property.value.type === 'Identifier' && property.value.name === key)
        const source = key && !declared.has(key) ? moduleImports.get(key) : undefined
        const listable = key !== undefined && (declared.has(key) || key === extraKey || Boolean(source?.name))
        if (!listable || !referencesKey) {
          isAggregate = false
          break
        }
        if (source) listed.set(source.module, (listed.get(source.module) ?? new Set()).add(source.name))
        keys.push(key)
      }
      if (!isAggregate) continue

      const name = declarator.id.name
      typeQueried ??= typeQueriedNames(ast)
      const confident = name === 'schema' || name === identifiedAs || typeQueried.has(name)
      if (object.properties.length === 0 && !confident) continue

      // A second candidate means the file's shape does not identify one aggregate,
      // so neither can this.
      if (found) return null

      found = { object, statement: node, keys, declared, listed, delegated, confident }
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
  /** The database default; absent when the chain declares none. */
  default?: SchemaColumnDefault
  /** Source text of a `.$defaultFn()` / `.$default()` argument, which the database never sees. */
  runtimeDefault?: string
  /**
   * Set when the chain does not start at a builder the file imports from drizzle (a
   * shared column, a local helper), so `notNull`, `primaryKey`, `unique`, `references`
   * and `default` report only the modifiers written here: false means "not visible".
   */
  opaqueBuilder?: true
}

/**
 * A database default as written, never evaluated. `text` is the argument's source text.
 * `value` is `.default(<expression>)`, `sql` is `.default(sql\`…\`)`, `now` and `random`
 * are `.defaultNow()` / `.defaultRandom()`. All three write one slot, so the last call wins.
 */
export type SchemaColumnDefault =
  | { kind: 'value' | 'sql'; text: string }
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
      return { type: callee.name, builder: current, methods, rooted: drizzleName(callee, imports) !== undefined }
    }
    if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') {
      break
    }
    // Walked outermost first, and drizzle lets a repeated modifier's last call win.
    if (!methods.has(callee.property.name)) methods.set(callee.property.name, current)
    const object = unwrapTypeAssertion(callee.object)
    if (object.type !== 'CallExpression') {
      return { methods, rooted: drizzleName(callee, imports) !== undefined }
    }
    current = object
  }

  return { methods, rooted: false }
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
    if (prop.type !== 'ObjectProperty' || memberKeyName(prop) !== option) continue
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

function isSqlTemplate(node: Node, imports: DrizzleImports): boolean {
  if (node.type !== 'TaggedTemplateExpression') return false
  const tag = unwrapTypeAssertion(node.tag)
  return (tag.type === 'Identifier' && tag.name === 'sql') || drizzleName(tag, imports) === 'sql'
}

function extractDefault(methods: Map<string, CallExpression>, source: string, imports: DrizzleImports): SchemaColumnDefault | undefined {
  for (const [method, call] of methods) {
    if (method === 'defaultNow') return { kind: 'now' }
    if (method === 'defaultRandom') return { kind: 'random' }
    const written = call.arguments[0]
    if (method !== 'default' || !written) continue
    return { kind: isSqlTemplate(unwrapTypeAssertion(written), imports) ? 'sql' : 'value', text: nodeText(source, written) }
  }
  return undefined
}

function columnsFromObject(columnsArg: ObjectExpression, source: string, imports: DrizzleImports): SchemaColumn[] {
  const columns: SchemaColumn[] = []
  for (const prop of columnsArg.properties) {
    if (prop.type !== 'ObjectProperty') continue

    const name = memberKeyName(prop)
    if (!name) continue

    const { type, builder, methods, rooted } = unwrapColumnChain(prop.value, imports)
    if (!builder && methods.size === 0) {
      columns.push({ name, notNull: false, primaryKey: false, unique: false, opaqueBuilder: true })
      continue
    }

    const nameArg = builder?.arguments[0]
    const columnDefault = extractDefault(methods, source, imports)
    const runtimeDefault = (methods.get('$defaultFn') ?? methods.get('$default'))?.arguments[0]

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
      ...(runtimeDefault ? { runtimeDefault: nodeText(source, runtimeDefault) } : {}),
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
  if (node.type !== 'MemberExpression') return undefined
  const object = unwrapTypeAssertion(node.object)
  if (object.type !== 'Identifier') return undefined
  const property = node.computed ? literalString(node.property) : node.property.type === 'Identifier' ? node.property.name : null
  return property ? { object: object.name, property } : undefined
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

/** `opaque` when the list itself is missing or any node in it does not read. */
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
  const name = drizzleName(callee, imports) as SchemaConstraintKind | undefined
  return name && CONSTRAINT_BUILDERS.has(name) ? name : undefined
}

function constraintColumnNodes(
  kind: SchemaConstraintKind,
  root: CallExpression,
  options: ObjectExpression | null,
  methods: Map<string, CallExpression>,
): ReadonlyArray<Node | null> | undefined {
  if (kind === 'check') return []
  if (options) return arrayElements(propertyValue(options, 'columns'))
  if (kind === 'primaryKey') return root.arguments
  // `.using(method, ...columns)` is Postgres's spelling of `.on(...columns)`.
  return (methods.get('on') ?? methods.get('onOnly'))?.arguments ?? methods.get('using')?.arguments.slice(1)
}

/** One extra-config entry, or undefined when it is not a drizzle constraint builder chain. */
function readConstraint(entry: Node, binding: ColumnBinding, table: string, imports: DrizzleImports): SchemaConstraint | undefined {
  const methods = new Map<string, CallExpression>()
  let current = unwrapTypeAssertion(entry)
  let kind: SchemaConstraintKind | undefined

  while (current.type === 'CallExpression') {
    const callee = current.callee
    kind = constraintKind(callee, imports)
    if (kind || callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') break
    methods.set(callee.property.name, current)
    current = unwrapTypeAssertion(callee.object)
  }
  if (!kind || current.type !== 'CallExpression') return undefined

  const options = kind === 'primaryKey' || kind === 'foreignKey' ? objectLiteral(current.arguments[0]) : null
  const nameNode = options ? propertyValue(options, 'name') : kind === 'primaryKey' ? undefined : current.arguments[0]
  const name = literalString(nameNode) ?? undefined

  const columns = readList(constraintColumnNodes(kind, current, options, methods), (node) => ownColumn(node, binding))
  const constraint: SchemaConstraint = { kind, ...(name ? { name } : {}), columns: columns.items }
  // A spread or computed key may override any option.
  const hiddenOptions = options?.properties.some((property) => !staticProperty(property)) ?? false
  // `primaryKey(OPTIONS)` reads as one unreadable positional column, and may carry a name.
  const hiddenName = hiddenOptions || (!options && (kind === 'primaryKey' || kind === 'foreignKey') && columns.opaque)
  if ((nameNode && !name) || hiddenName) constraint.opaqueName = true
  let opaque = columns.opaque || hiddenOptions

  if (kind === 'foreignKey') {
    const foreignColumns = options ? propertyValue(options, 'foreignColumns') : undefined
    const targets = readList(arrayElements(foreignColumns), (node) => memberName(unwrapTypeAssertion(node)))
    const tables = new Set(targets.items.map((target) => (target.object === binding.table ? table : target.object)))
    if (tables.size === 1) constraint.references = { table: [...tables][0], columns: targets.items.map((target) => target.property) }
    opaque ||= targets.opaque || tables.size !== 1
  }

  if (opaque) constraint.opaqueColumns = true
  return constraint
}

/** The entries of the array form or the object form; a hidden key is a null entry. */
function constraintEntries(returned: Node | undefined): Array<Node | null> | undefined {
  if (returned?.type === 'ArrayExpression') return returned.elements
  if (returned?.type !== 'ObjectExpression') return undefined
  return returned.properties.map((property) => staticProperty(property)?.value ?? null)
}

function readConstraints(
  extraConfig: Node | undefined,
  table: string,
  imports: DrizzleImports,
): Pick<SchemaTable, 'constraints' | 'opaqueConstraints'> {
  if (!extraConfig) return { constraints: [] }

  const callback = unwrapTypeAssertion(extraConfig)
  // A block with anything beside its `return` may branch or bind the names the literal uses.
  const busyBlock =
    (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression')
    && callback.body.type === 'BlockStatement'
    && callback.body.body.length !== 1
  const entries = busyBlock ? undefined : constraintEntries(returnedExpression(callback))

  const binding = columnBinding(callback)
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
    const columnsIndex = call.arguments.findIndex((argument) => objectLiteral(argument))
    const columnsArg = objectLiteral(call.arguments[columnsIndex])
    if (!columnsArg) continue

    tables.push({
      identifier,
      tableName: literalString(call.arguments[0]) ?? undefined,
      columns: columnsFromObject(columnsArg, source, imports),
      module,
      dialect,
      ...readConstraints(call.arguments[columnsIndex + 1], identifier, imports),
      ...(columnsArg.properties.some((property) => !staticProperty(property)) ? { opaqueColumns: true as const } : {}),
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

/** How the root `db/schema.ts` imports and re-exports a module's schema. */
export function moduleSchemaSpecifier(module: string): string {
  return `../modules/${module}/db/schema`
}

/** The aggregate object `make:module` gives a module for the root schema object to spread. */
export function moduleSchemaAggregateName(module: string): string {
  return `${camelCase(module)}Schema`
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
