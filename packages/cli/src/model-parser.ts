import { readFile } from 'node:fs/promises'
import type { Statement, Expression, ClassDeclaration, ClassBody, ClassProperty, CallExpression, Node, ObjectProperty, TSPropertySignature } from '@babel/types'
import { literalString, memberKeyName, objectLiteral, unwrapTypeAssertion } from './ast-walk'
import { extractDocsTags } from './docs-index'
import { classNameFromPath, discoverModelFiles, toPosixRelative, moduleNameFromRelPath } from './discovery'
import { parseSourceFile, type ParseCache } from './parse-cache'

const RELATION_METHODS = ['belongsTo', 'hasMany', 'hasOne', 'belongsToMany', 'hasManyThrough', 'morphMany', 'morphTo'] as const
const RELATION_METHOD_SET: ReadonlySet<string> = new Set(RELATION_METHODS)

function isRelationMethod(name: string): name is (typeof RELATION_METHODS)[number] {
  return RELATION_METHOD_SET.has(name)
}

export interface ModelRelationship {
  name: string
  type: (typeof RELATION_METHODS)[number]
  relatedModel?: string
}

/** One collection of the model's `Attachable(Base, { ... })` declaration (RFC 0013). */
export interface ModelAttachmentCollection {
  name: string
  /** `'one'` for `hasOneAttached(...)`, `'many'` for `hasManyAttached(...)`. */
  kind: 'one' | 'many'
  /** Declared variant names, in declaration order. Empty when none. */
  variants: string[]
}

export interface ModelInfo {
  className: string
  filePath: string
  tableName?: string
  relationships: ModelRelationship[]
  usesAuth: boolean
  hasSoftDeletes: boolean
  /**
   * The `Attachable(Base, { ... })` declaration: `null` when not Attachable, the
   * collections otherwise, `'unreadable'` when the mixin is there but its declaration
   * cannot be read (a spread, a computed key, an options object built elsewhere). One
   * field, not an array plus a flag: "attachable at all" is never conflated with "zero
   * collections", and a partial read (rejecting collections the runtime accepts) is unrepresentable.
   */
  attachments: ModelAttachmentCollection[] | 'unreadable' | null
  /**
   * Mass-assignment allowlist, from `static fillable` or the defineModel option.
   * `null` when neither is declared, `'unreadable'` when one is but its value is
   * not a literal array: the runtime still uses it, so it must not read as absent.
   */
  fillable: string[] | 'unreadable' | null
  /** Serialization denylist, resolved like {@link ModelInfo.fillable}. */
  hidden: string[] | 'unreadable' | null
  /** Serialization allowlist (wins over `hidden`), resolved like {@link ModelInfo.fillable}. */
  visible: string[] | 'unreadable' | null
  /** `static casts` as attribute → cast type; there is no defineModel option for it. */
  casts: Record<string, string> | 'unreadable' | null
  /** `@docs <path>` tags in the model source (code-side doc links). */
  docsTags: string[]
}

export async function parseModelFile(filePath: string): Promise<ModelInfo | null> {
  const source = await readFile(filePath, 'utf-8')
  return parseModelSource(source, filePath)
}

export interface DiscoveredModel {
  info: ModelInfo
  /** POSIX path relative to the app root. */
  relPath: string
  /** Module the model lives in, or null for the app root. */
  module: string | null
}

/**
 * The discovery+parse projection shared by the entity context, the domain spec
 * view and `make:adr --entity`. Unparsable files are dropped.
 */
export async function discoverParsedModels(cwd: string): Promise<DiscoveredModel[]> {
  const files = await discoverModelFiles(cwd)
  const parsed = await Promise.all(files.map((file) => parseModelFile(file)))
  return parsed.flatMap((info, index) => {
    if (!info) return []
    const relPath = toPosixRelative(cwd, files[index])
    return [{ info, relPath, module: moduleNameFromRelPath(relPath) }]
  })
}

export interface ModelClass {
  /** Absolute path of the model file. */
  filePath: string
  /** Module the model lives in, or null for the app root. */
  module: string | null
  className: string
  /** Null when the file parses to no named class: the name then comes from the file. */
  classDecl: ClassDeclaration | null
}

/**
 * Every named class of every model file through the run's parse cache, plus a
 * name-only entry for a file that declares none, so a model that will not parse
 * still names itself to a rule that fails closed on it.
 */
export async function discoverModelClasses(cwd: string, cache: ParseCache): Promise<ModelClass[]> {
  const classes: ModelClass[] = []
  for (const filePath of await discoverModelFiles(cwd)) {
    const module = moduleNameFromRelPath(toPosixRelative(cwd, filePath))
    const parsed = await cache.get(filePath)
    const declared = (parsed?.ast.program.body ?? [])
      .map((statement) => extractClassDeclaration(statement))
      .filter((classDecl): classDecl is ClassDeclaration & { id: { name: string } } => Boolean(classDecl?.id))
    if (declared.length === 0) {
      classes.push({ filePath, module, className: classNameFromPath(filePath), classDecl: null })
      continue
    }
    for (const classDecl of declared) classes.push({ filePath, module, className: classDecl.id.name, classDecl })
  }
  return classes
}

export function parseModelSource(source: string, filePath: string): ModelInfo | null {
  const ast = parseSourceFile(source, filePath)
  if (!ast) return null

  const classDecl = firstClassDeclaration(ast.program.body)
  if (!classDecl?.id) return null

  const className = classDecl.id.name
  const { tableName, usesAuth, hasSoftDeletes } = analyzeClassHeader(classDecl, source)
  const relationships = mergeRelationships(
    extractRelationshipsFromCalls(ast.program.body, classDecl),
    extractRelatedModels(classDecl.body, source),
  )

  return {
    className,
    filePath,
    tableName,
    relationships,
    usesAuth,
    hasSoftDeletes,
    attachments: extractModelAttachments(classDecl),
    fillable: readModelStringArrayConfig(classDecl, 'fillable'),
    hidden: readModelStringArrayConfig(classDecl, 'hidden'),
    visible: readModelStringArrayConfig(classDecl, 'visible'),
    casts: extractModelCasts(classDecl),
    docsTags: extractDocsTags(source),
  }
}

function readModelStringArrayConfig(classDecl: ClassDeclaration, name: string): string[] | 'unreadable' | null {
  if (!hasModelConfig(classDecl, name)) return null
  return resolveModelStringArrayConfig(classDecl, name) ?? 'unreadable'
}

/** A spread, a computed key or a non-literal cast type makes the whole map unreadable, never partial. */
function extractModelCasts(classDecl: ClassDeclaration): Record<string, string> | 'unreadable' | null {
  const property = findStaticClassProperty(classDecl, 'casts')
  if (!property) return null
  const declaration = objectLiteral(property.value)
  if (!declaration) return 'unreadable'

  const casts: Record<string, string> = {}
  for (const member of declaration.properties) {
    if (member.type !== 'ObjectProperty') return 'unreadable'
    const name = memberKeyName(member)
    const type = literalString(member.value)
    if (name === undefined || type === null) return 'unreadable'
    casts[name] = type
  }
  return casts
}

/** The class in a top-level statement: export named, export default, or bare. */
export function extractClassDeclaration(node: Statement): ClassDeclaration | null {
  if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration') {
    return node.declaration
  }
  if (node.type === 'ExportDefaultDeclaration' && node.declaration?.type === 'ClassDeclaration') {
    return node.declaration
  }
  if (node.type === 'ClassDeclaration') {
    return node
  }
  return null
}

/**
 * The one rule for "this file's class", following the model/controller/command
 * convention. First, not exported-first: a bare class still describes the
 * file. Callers needing the exported one resolve it by name instead.
 */
export function firstClassDeclaration(body: Statement[]): ClassDeclaration | null {
  for (const node of body) {
    const classDecl = extractClassDeclaration(node)
    if (classDecl) return classDecl
  }
  return null
}

/**
 * Whether an expression names `AuthenticatableModel`, bare or with type
 * arguments. Matching is by name only — an aliased import is not resolved.
 */
function isAuthenticatableBase(node: Node): boolean {
  const unwrapped = unwrapTypeAssertion(node)
  const target = unwrapped.type === 'TSInstantiationExpression' ? unwrapped.expression : unwrapped
  return target.type === 'Identifier' && target.name === 'AuthenticatableModel'
}

/** The name of an object property key, for both `{ base: X }` and `{ 'base': X }`. */
function propertyKeyName(property: ObjectProperty): string | undefined {
  return memberKeyName(property)
}

/**
 * Reached through any mixin wrapping it: `SoftDeletes(defineModel(posts))` is
 * a documented spelling and must not read as bindless.
 */
function defineModelTableArgument(node: Node): string | undefined {
  const firstArg = findMixinCall(node, 'defineModel')?.arguments[0]
  return firstArg?.type === 'Identifier' ? firstArg.name : undefined
}

/**
 * The one rule for a model's table, covering both spellings:
 * `defineModel(users, …)` and `static table = users`. The result is the model
 * file's *local* name, so a caller comparing it against a schema's exports
 * must account for an aliased import itself.
 */
export function extractTableIdentifier(classDecl: ClassDeclaration): string | undefined {
  let tableName = classDecl.superClass ? defineModelTableArgument(classDecl.superClass) : undefined

  // An explicit `static table` wins: a class may extend defineModel(x) and
  // still repoint the table.
  for (const member of classDecl.body.body) {
    if (
      member.type === 'ClassProperty' &&
      member.static &&
      member.key.type === 'Identifier' &&
      member.key.name === 'table' &&
      member.value?.type === 'Identifier'
    ) {
      tableName = member.value.name
    }
  }

  return tableName
}

/**
 * Extends `AuthenticatableModel` directly or receives it via `defineModel`'s
 * `base`. AST-based, so a comment mentioning the name does not count.
 */
export function classUsesAuthenticatableBase(classDecl: ClassDeclaration): boolean {
  const superClass = classDecl.superClass
  if (!superClass) return false

  // In `defineModel(users, { base: AuthenticatableModel })` the base is an
  // option rather than the superclass; resolved through findDefineModelOption
  // so mixin wrapping is covered as it is for the table.
  const baseOption = findDefineModelOption(classDecl, 'base')
  if (baseOption && isAuthenticatableBase(baseOption.value)) return true

  return isAuthenticatableBase(superClass)
}

/** The named static class property node, if the class declares one. */
export function findStaticClassProperty(classDecl: ClassDeclaration, name: string): ClassProperty | null {
  for (const member of classDecl.body.body) {
    if (member.type === 'ClassProperty' && member.static && member.key.type === 'Identifier' && member.key.name === name) {
      return member
    }
  }
  return null
}

/** Value of `static <name> = '<literal>'`, or undefined when absent or not a string literal. */
export function staticStringProperty(classDecl: ClassDeclaration, name: string): string | undefined {
  const property = findStaticClassProperty(classDecl, name)
  return literalString(property?.value) ?? undefined
}

/**
 * Entries of a declared list of strings, the one rule for reading one out of
 * source (an agent's `static scopes` reads through it too). Undefined for
 * anything but a fully-readable array literal, spreads and computed elements
 * included: a partial read is worse than none, since `visible: ['id', ...EXPOSED]`
 * read as `['id']` reports columns hidden that the runtime exposes.
 */
export function stringArrayEntries(node: Node | null | undefined): string[] | undefined {
  // Unwrapped because `static fillable = ['title'] as const` is the idiomatic
  // spelling and otherwise reads as a non-array.
  const array = node ? unwrapTypeAssertion(node) : null
  if (array?.type !== 'ArrayExpression') return undefined
  const entries: string[] = []
  for (const element of array.elements) {
    const entry = literalString(element)
    if (entry === null) return undefined
    entries.push(entry)
  }
  return entries
}

/** Entries of `static <name> = ['a', 'b']`, or undefined when absent or not an array literal. */
function staticStringArrayProperty(classDecl: ClassDeclaration, name: string): string[] | undefined {
  return stringArrayEntries(findStaticClassProperty(classDecl, name)?.value)
}

/**
 * The named call in an extends clause, however wrapped — `defineModel(posts)`
 * or `Attachable(defineModel(posts), {...})` directly, or inside another
 * mixin such as `SoftDeletes(Attachable(...))`. Matching is by name only,
 * like the other heritage-clause checks — an aliased import is not resolved.
 */
function findMixinCall(node: Node, mixinName: string): CallExpression | null {
  const unwrapped = unwrapTypeAssertion(node)
  if (unwrapped.type !== 'CallExpression') return null
  if (unwrapped.callee.type === 'Identifier' && unwrapped.callee.name === mixinName) return unwrapped
  for (const argument of unwrapped.arguments) {
    const nested = findMixinCall(argument, mixinName)
    if (nested) return nested
  }
  return null
}

/**
 * The second argument of the heritage clause's `Attachable(...)` call (RFC
 * 0013). `'unreadable'` rather than a partial list, which would misreport the
 * model's contract — see {@link ModelInfo.attachments}.
 */
export function extractModelAttachments(
  classDecl: ClassDeclaration,
): ModelAttachmentCollection[] | 'unreadable' | null {
  const call = classDecl.superClass ? findMixinCall(classDecl.superClass, 'Attachable') : null
  if (!call) return null

  const declaration = objectLiteral(call.arguments[1])
  if (!declaration) return 'unreadable'

  const collections: ModelAttachmentCollection[] = []
  for (const property of declaration.properties) {
    if (property.type !== 'ObjectProperty') return 'unreadable'
    const name = memberKeyName(property)
    if (!name) return 'unreadable'
    const spec = parseAttachmentSpec(unwrapTypeAssertion(property.value))
    if (!spec) return 'unreadable'
    collections.push({ name, ...spec })
  }
  return collections
}

/**
 * Null for any shape but a `hasOneAttached(...)` / `hasManyAttached(...)`
 * call, an unreadable options argument included: the variants may be hiding
 * inside it, so it must not read as "no variants".
 */
function parseAttachmentSpec(node: Node): { kind: 'one' | 'many'; variants: string[] } | null {
  if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return null
  const kind =
    node.callee.name === 'hasOneAttached' ? 'one'
    : node.callee.name === 'hasManyAttached' ? 'many'
    : null
  if (!kind) return null

  const options = node.arguments[0] === undefined ? undefined : unwrapTypeAssertion(node.arguments[0])
  if (options === undefined) return { kind, variants: [] }
  if (options.type !== 'ObjectExpression') return null

  let variants: string[] = []
  for (const property of options.properties) {
    if (property.type !== 'ObjectProperty') return null
    const key = memberKeyName(property)
    if (!key) return null
    if (key !== 'variants') continue
    const names = attachmentVariantNames(property.value)
    if (!names) return null
    variants = names
  }
  return { kind, variants }
}

/** Keys of a `variants: { thumb: {...}, og: {...} }` object literal, or null when not fully readable. */
function attachmentVariantNames(node: Node): string[] | null {
  const variants = objectLiteral(node)
  if (!variants) return null
  const names: string[] = []
  for (const property of variants.properties) {
    if (property.type !== 'ObjectProperty') return null
    const name = memberKeyName(property)
    if (!name) return null
    names.push(name)
  }
  return names
}

/**
 * A literal `name: undefined` counts as absent: the runtime skips the
 * assignment, so the model is configured by neither spelling.
 */
export function findDefineModelOption(classDecl: ClassDeclaration, name: string): ObjectProperty | null {
  if (!classDecl.superClass) return null
  const call = findMixinCall(classDecl.superClass, 'defineModel')
  const options = objectLiteral(call?.arguments[1])
  if (!options) return null
  for (const property of options.properties) {
    if (property.type !== 'ObjectProperty' || propertyKeyName(property) !== name) continue
    // Unwrapped, because `fillable: undefined as string[] | undefined` is the
    // same skipped assignment and would otherwise read as a declared option.
    const value = unwrapTypeAssertion(property.value)
    if (value.type === 'Identifier' && value.name === 'undefined') return null
    return property
  }
  return null
}

/** Entries of a string-array defineModel option (e.g. `fillable: ['a', 'b']`). */
function defineModelStringArrayOption(classDecl: ClassDeclaration, name: string): string[] | undefined {
  return stringArrayEntries(findDefineModelOption(classDecl, name)?.value)
}

/**
 * The one rule for a string-array model config (`fillable`, `hidden`, …),
 * resolved as the runtime does: a `static` on the subclass shadows the
 * same-named defineModel option.
 */
export function resolveModelStringArrayConfig(classDecl: ClassDeclaration, name: string): string[] | undefined {
  // Precedence follows declaration presence, not parseability: a static whose
  // value cannot be read (`static hidden = HIDDEN`) still shadows the option
  // at runtime, so falling back would report a list nothing uses.
  if (findStaticClassProperty(classDecl, name)) return staticStringArrayProperty(classDecl, name)
  return defineModelStringArrayOption(classDecl, name)
}

/**
 * Declared in either spelling, parseable or not. The presence twin of
 * `resolveModelStringArrayConfig`; keep the two composition rules together.
 */
export function hasModelConfig(classDecl: ClassDeclaration, name: string): boolean {
  return findStaticClassProperty(classDecl, name) !== null || findDefineModelOption(classDecl, name) !== null
}

function analyzeClassHeader(
  classDecl: ClassDeclaration,
  source: string,
): { tableName?: string; usesAuth: boolean; hasSoftDeletes: boolean } {
  return {
    tableName: extractTableIdentifier(classDecl),
    usesAuth: classUsesAuthenticatableBase(classDecl),
    hasSoftDeletes: source.includes('SoftDeletes'),
  }
}

const RELATION_RECORD_TYPES = [
  'BelongsToRecord',
  'BelongsToRequiredRecord',
  'HasManyRecord',
  'HasOneRecord',
  'BelongsToManyRecord',
  'HasManyThroughRecord',
  'MorphManyRecord',
  'MorphToRecord',
]

/** Relationship name → target model, from `static override relationTypes: { author: BelongsToRecord<UserRecord> }`. */
function extractRelatedModels(body: ClassBody, source: string): Map<string, string> {
  const related = new Map<string, string>()
  for (const member of body.body) {
    if (
      member.type !== 'ClassProperty' ||
      !member.static ||
      member.key.type !== 'Identifier' ||
      member.key.name !== 'relationTypes' ||
      member.typeAnnotation?.type !== 'TSTypeAnnotation' ||
      member.typeAnnotation.typeAnnotation.type !== 'TSTypeLiteral'
    ) continue
    for (const prop of member.typeAnnotation.typeAnnotation.members) {
      if (prop.type !== 'TSPropertySignature' || prop.key.type !== 'Identifier') continue
      const model = relatedModelOf(prop, source)
      if (model) related.set(prop.key.name, model)
    }
  }
  return related
}

function relatedModelOf(prop: TSPropertySignature, source: string): string | undefined {
  const typeAnn = prop.typeAnnotation?.typeAnnotation
  if (!typeAnn) return undefined
  const typeStr = source.slice(typeAnn.start!, typeAnn.end!)
  const prefix = RELATION_RECORD_TYPES.find((candidate) => typeStr.includes(candidate))
  // BelongsToRecord<UserRecord> → User
  return prefix ? typeStr.match(new RegExp(`${prefix}<([A-Z]\\w*?)(?:Record)?(?:[,>])`))?.[1] : undefined
}

/**
 * From the calls that register a relationship at runtime: module-level
 * `Post.belongsTo('author', ...)`, the same inside `if (typeof Post.belongsTo === 'function')`,
 * and `this.hasMany(...)` / `Post.hasMany(...)` in a `static {}` block of the class.
 */
function extractRelationshipsFromCalls(body: Statement[], classDecl: ClassDeclaration): ModelRelationship[] {
  if (!classDecl.id) return []
  const className = classDecl.id.name
  const relationships = relationshipCallsIn(body, className, false)
  for (const member of classDecl.body.body) {
    if (member.type === 'StaticBlock') relationships.push(...relationshipCallsIn(member.body, className, true))
  }
  return relationships
}

/** A statement's own expression, or those of an `if` block's statements. */
function statementExpressions(node: Statement): Expression[] {
  if (node.type === 'ExpressionStatement') return [node.expression]
  if (node.type !== 'IfStatement' || node.consequent.type !== 'BlockStatement') return []
  return node.consequent.body.flatMap((stmt) => (stmt.type === 'ExpressionStatement' ? [stmt.expression] : []))
}

function relationshipCallsIn(statements: Statement[], className: string, thisIsTheClass: boolean): ModelRelationship[] {
  const relationships: ModelRelationship[] = []
  for (const expr of statements.flatMap(statementExpressions)) {
    if (expr.type !== 'CallExpression' || expr.callee.type !== 'MemberExpression') continue
    const { object, property } = expr.callee
    const onClass = (object.type === 'Identifier' && object.name === className) || (thisIsTheClass && object.type === 'ThisExpression')
    if (!onClass || property.type !== 'Identifier' || !isRelationMethod(property.name)) continue
    const name = literalString(expr.arguments[0])
    if (name !== null) relationships.push({ name, type: property.name })
  }
  return relationships
}

/**
 * The call is the declaration: it alone registers the relationship, so it decides that
 * one exists and its kind. `relationTypes` is a type annotation, and only names the target.
 */
function mergeRelationships(calls: ModelRelationship[], relatedModels: Map<string, string>): ModelRelationship[] {
  const merged = new Map<string, ModelRelationship>()
  for (const call of calls) {
    const relatedModel = relatedModels.get(call.name)
    merged.set(call.name, relatedModel ? { ...call, relatedModel } : call)
  }
  return Array.from(merged.values())
}
