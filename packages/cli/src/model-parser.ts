import { readFile } from 'node:fs/promises'
import type { Statement, Expression, ClassDeclaration, ClassBody, ClassProperty, CallExpression, Node, ObjectProperty } from '@babel/types'
import { memberKeyName } from './ast-walk'
import { extractDocsTags } from './docs-index'
import { discoverModelFiles, toPosixRelative, moduleNameFromRelPath } from './discovery'
import { parseSourceFile } from './parse-cache'

export interface ModelRelationship {
  name: string
  type: 'belongsTo' | 'hasMany' | 'hasOne' | 'belongsToMany' | 'hasManyThrough' | 'morphMany' | 'morphTo'
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
   * The `Attachable(Base, { ... })` declaration in the heritage clause:
   * `null` when the model is not Attachable, the collections otherwise
   * (empty for `Attachable(Base, {})`, which is still an Attachable model),
   * and `'unreadable'` when the mixin is present but its declaration cannot
   * be read (a spread, a computed key, an options object built elsewhere).
   * One field rather than an array+flag pair so "attachable at all" —
   * what `guren check` asks — is not conflated with "zero collections",
   * and a partial read is never representable: a map claiming `cover` is
   * the only collection makes every consumer reject the `gallery` the
   * runtime accepts (the same reason the allowlist checks resolve to
   * undefined).
   */
  attachments: ModelAttachmentCollection[] | 'unreadable' | null
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
 * Every parsable model with its location — the shared discovery+parse
 * projection behind the entity context, the domain spec view, and
 * `make:adr --entity`. Unparsable files are dropped.
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

export function parseModelSource(source: string, filePath: string): ModelInfo | null {
  const ast = parseSourceFile(source, filePath)
  if (!ast) return null

  const classDecl = firstClassDeclaration(ast.program.body)
  if (!classDecl?.id) return null

  const className = classDecl.id.name
  const { tableName, usesAuth, hasSoftDeletes } = analyzeClassHeader(classDecl, source)
  const bodyRelationships = extractRelationshipsFromBody(classDecl.body, source)
  const callRelationships = extractRelationshipsFromCalls(ast.program.body, className, source)

  const relationships = mergeRelationships(bodyRelationships, callRelationships)

  return {
    className,
    filePath,
    tableName,
    relationships,
    usesAuth,
    hasSoftDeletes,
    attachments: extractModelAttachments(classDecl),
    docsTags: extractDocsTags(source),
  }
}

/**
 * The `ClassDeclaration` in a top-level statement — export named, export
 * default, or bare. Shared AST-shape knowledge for "the class in this file".
 */
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
 * The first class declared in a file — the convention every model, controller,
 * and command file follows, so callers that want "this file's class" ask for
 * it here rather than each walking `program.body` themselves.
 *
 * First, not exported-first: a bare class still counts, since a file that
 * declares one is describing that class whatever it does with it. Callers
 * needing the exported one specifically (the entity context, the screens spec)
 * resolve it by name instead.
 */
export function firstClassDeclaration(body: Statement[]): ClassDeclaration | null {
  for (const node of body) {
    const classDecl = extractClassDeclaration(node)
    if (classDecl) return classDecl
  }
  return null
}

/**
 * Whether an expression names `AuthenticatableModel`, as a bare identifier or
 * with type arguments (`AuthenticatableModel<UserRecord>`). Both the superclass
 * and `defineModel`'s `base` option accept either spelling, so both go through
 * here. Matching is by name only — an aliased import is not resolved.
 */
function isAuthenticatableBase(node: Node): boolean {
  const target = node.type === 'TSInstantiationExpression' ? node.expression : node
  return target.type === 'Identifier' && target.name === 'AuthenticatableModel'
}

/** The name of an object property key, for both `{ base: X }` and `{ 'base': X }`. */
function propertyKeyName(property: ObjectProperty): string | undefined {
  return memberKeyName(property)
}

/**
 * The table `defineModel(users, …)` binds, reached through any mixin wrapping
 * it — `SoftDeletes(defineModel(posts))` is the documented spelling, and a
 * model written that way must not read as bindless.
 */
function defineModelTableArgument(node: Node): string | undefined {
  const firstArg = findMixinCall(node, 'defineModel')?.arguments[0]
  return firstArg?.type === 'Identifier' ? firstArg.name : undefined
}

/**
 * The identifier a model binds its table to, from either supported spelling:
 * `defineModel(users, …)` or `static table = users`. Callers that only look
 * for the latter silently stop covering every model written the modern way,
 * so anything resolving a model's table goes through here.
 *
 * The identifier is the model file's local name for the table. A caller
 * comparing it against a schema's exported names has to account for an
 * aliased import (`import { posts as postTable }`) itself.
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
 * Whether the class is authenticatable: it extends `AuthenticatableModel`
 * directly or receives it via `defineModel`'s `base` option. AST-based, so a
 * comment or import merely mentioning the name does not count.
 */
export function classUsesAuthenticatableBase(classDecl: ClassDeclaration): boolean {
  const superClass = classDecl.superClass
  if (!superClass) return false

  // defineModel(users, { base: AuthenticatableModel }) — the auth base
  // arrives as an option rather than as the superclass itself. Resolved
  // through findDefineModelOption so mixin wrapping is covered the same way
  // it is for the table and the allowlist options.
  const baseOption = findDefineModelOption(classDecl, 'base')
  if (baseOption && isAuthenticatableBase(baseOption.value)) return true

  // AuthenticatableModel pattern
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
  return property?.value?.type === 'StringLiteral' ? property.value.value : undefined
}

/**
 * String-literal entries of an array-literal node, or undefined for any
 * other node — including an array with a spread or computed element. A
 * partial read is worse than none for the allowlist checks: `visible:
 * ['id', ...EXPOSED]` read as `['id']` reports columns hidden that the
 * runtime exposes.
 */
function stringArrayEntries(node: Node | null | undefined): string[] | undefined {
  if (node?.type !== 'ArrayExpression') return undefined
  const entries: string[] = []
  for (const element of node.elements) {
    if (element?.type !== 'StringLiteral') return undefined
    entries.push(element.value)
  }
  return entries
}

/** Entries of `static <name> = ['a', 'b']`, or undefined when absent or not an array literal. */
function staticStringArrayProperty(classDecl: ClassDeclaration, name: string): string[] | undefined {
  return stringArrayEntries(findStaticClassProperty(classDecl, name)?.value)
}

/**
 * The expression under any transparent TypeScript wrapping — `x as const`,
 * `x satisfies T`, `x!`, `<T>x`, `(x)`. These change nothing about what the
 * runtime receives, so every heritage-clause reader unwraps them before
 * judging shape; treating `{...} as const` as unreadable would misreport a
 * fully static declaration.
 */
function unwrapExpression(node: Node): Node {
  let current = node
  while (
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSNonNullExpression' ||
    current.type === 'TSTypeAssertion' ||
    current.type === 'ParenthesizedExpression'
  ) {
    current = current.expression
  }
  return current
}

/**
 * The named call in an extends clause, however wrapped — `defineModel(posts)`
 * or `Attachable(defineModel(posts), {...})` directly, or inside another
 * mixin such as `SoftDeletes(Attachable(...))`. Matching is by name only,
 * like the other heritage-clause checks — an aliased import is not resolved.
 */
function findMixinCall(node: Node, mixinName: string): CallExpression | null {
  const unwrapped = unwrapExpression(node)
  if (unwrapped.type !== 'CallExpression') return null
  if (unwrapped.callee.type === 'Identifier' && unwrapped.callee.name === mixinName) return unwrapped
  for (const argument of unwrapped.arguments) {
    const nested = findMixinCall(argument, mixinName)
    if (nested) return nested
  }
  return null
}

/**
 * The class's attachment declaration — the second argument of the
 * `Attachable(...)` call in its heritage clause (RFC 0013). `'unreadable'`
 * reports a declaration this could not fully parse rather than a partial
 * collection list, because a partial map misreports the model's contract
 * (see {@link ModelInfo.attachments}).
 */
export function extractModelAttachments(
  classDecl: ClassDeclaration,
): ModelAttachmentCollection[] | 'unreadable' | null {
  const call = classDecl.superClass ? findMixinCall(classDecl.superClass, 'Attachable') : null
  if (!call) return null

  const declaration = call.arguments[1] === undefined ? undefined : unwrapExpression(call.arguments[1])
  if (declaration?.type !== 'ObjectExpression') return 'unreadable'

  const collections: ModelAttachmentCollection[] = []
  for (const property of declaration.properties) {
    if (property.type !== 'ObjectProperty') return 'unreadable'
    const name = memberKeyName(property)
    if (!name) return 'unreadable'
    const spec = parseAttachmentSpec(unwrapExpression(property.value))
    if (!spec) return 'unreadable'
    collections.push({ name, ...spec })
  }
  return collections
}

/**
 * One collection's `hasOneAttached(...)` / `hasManyAttached(...)` call, or
 * null for any other shape. An options argument that is not an object
 * literal — or one carrying a spread or computed key — is unreadable rather
 * than "no variants": the variants may be hiding inside it.
 */
function parseAttachmentSpec(node: Node): { kind: 'one' | 'many'; variants: string[] } | null {
  if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return null
  const kind =
    node.callee.name === 'hasOneAttached' ? 'one'
    : node.callee.name === 'hasManyAttached' ? 'many'
    : null
  if (!kind) return null

  const options = node.arguments[0] === undefined ? undefined : unwrapExpression(node.arguments[0])
  if (options === undefined) return { kind, variants: [] }
  if (options.type !== 'ObjectExpression') return null

  let variants: string[] = []
  for (const property of options.properties) {
    if (property.type !== 'ObjectProperty') return null
    const key = memberKeyName(property)
    if (!key) return null
    if (key !== 'variants') continue
    const names = attachmentVariantNames(unwrapExpression(property.value))
    if (!names) return null
    variants = names
  }
  return { kind, variants }
}

/** Keys of a `variants: { thumb: {...}, og: {...} }` object literal, or null when not fully readable. */
function attachmentVariantNames(node: Node): string[] | null {
  if (node.type !== 'ObjectExpression') return null
  const names: string[] = []
  for (const property of node.properties) {
    if (property.type !== 'ObjectProperty') return null
    const name = memberKeyName(property)
    if (!name) return null
    names.push(name)
  }
  return names
}

/**
 * The named property of the class's `defineModel(table, { ... })` options
 * object, if present. A literal `name: undefined` counts as absent — the
 * runtime skips the assignment, so the model is configured by neither
 * spelling.
 */
export function findDefineModelOption(classDecl: ClassDeclaration, name: string): ObjectProperty | null {
  if (!classDecl.superClass) return null
  const call = findMixinCall(classDecl.superClass, 'defineModel')
  const options = call?.arguments[1]
  if (options?.type !== 'ObjectExpression') return null
  for (const property of options.properties) {
    if (property.type !== 'ObjectProperty' || propertyKeyName(property) !== name) continue
    if (property.value.type === 'Identifier' && property.value.name === 'undefined') return null
    return property
  }
  return null
}

/** Entries of a string-array defineModel option (e.g. `fillable: ['a', 'b']`). */
function defineModelStringArrayOption(classDecl: ClassDeclaration, name: string): string[] | undefined {
  return stringArrayEntries(findDefineModelOption(classDecl, name)?.value)
}

/**
 * Resolve a string-array model config (`fillable`, `hidden`, `visible`, …)
 * the way the runtime does: a `static` declaration on the subclass shadows
 * the same-named defineModel option. Callers that read only the static
 * spelling silently stop covering models written the option way, so
 * anything resolving these allowlists goes through here.
 */
export function resolveModelStringArrayConfig(classDecl: ClassDeclaration, name: string): string[] | undefined {
  // Precedence follows declaration presence, not parseability: a static
  // whose value we cannot read (`static hidden = HIDDEN`) still shadows the
  // option at runtime, so falling back to the option would report a list the
  // runtime does not use. Unreadable resolves to undefined and the checks
  // stay conservative.
  if (findStaticClassProperty(classDecl, name)) return staticStringArrayProperty(classDecl, name)
  return defineModelStringArrayOption(classDecl, name)
}

/**
 * Whether the model declares the named config in either spelling — a static
 * class property or a defineModel option — regardless of whether its value
 * is a parseable array literal. The presence twin of
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

/**
 * Extract relationships from static relationTypes property.
 * Pattern: static override relationTypes: { author: BelongsToRecord<...> }
 */
function extractRelationshipsFromBody(body: ClassBody, source: string): ModelRelationship[] {
  const relationships: ModelRelationship[] = []

  for (const member of body.body) {
    if (
      member.type === 'ClassProperty' &&
      member.static &&
      member.key.type === 'Identifier' &&
      member.key.name === 'relationTypes' &&
      member.typeAnnotation?.type === 'TSTypeAnnotation'
    ) {
      const typeAnn = member.typeAnnotation.typeAnnotation
      if (typeAnn.type === 'TSTypeLiteral') {
        for (const prop of typeAnn.members) {
          if (prop.type === 'TSPropertySignature' && prop.key.type === 'Identifier') {
            const relName = prop.key.name
            const relType = extractRelationType(prop, source)
            if (relType) {
              relationships.push({
                name: relName,
                type: relType.type,
                relatedModel: relType.model,
              })
            }
          }
        }
      }
    }
  }

  return relationships
}

function extractRelationType(
  prop: any,
  source: string,
): { type: ModelRelationship['type']; model?: string } | null {
  const typeAnn = prop.typeAnnotation?.typeAnnotation
  if (!typeAnn) return null

  const typeStr = source.slice(typeAnn.start!, typeAnn.end!)

  const typeMap: Record<string, ModelRelationship['type']> = {
    BelongsToRecord: 'belongsTo',
    HasManyRecord: 'hasMany',
    HasOneRecord: 'hasOne',
    BelongsToManyRecord: 'belongsToMany',
    HasManyThroughRecord: 'hasManyThrough',
    MorphManyRecord: 'morphMany',
    MorphToRecord: 'morphTo',
  }

  for (const [prefix, relType] of Object.entries(typeMap)) {
    if (typeStr.includes(prefix)) {
      // Try to extract model name from generic: BelongsToRecord<UserRecord> → User
      const match = typeStr.match(new RegExp(`${prefix}<([A-Z]\\w*?)(?:Record)?(?:[,>])`))
      const model = match?.[1]
      return { type: relType, model }
    }
  }

  return null
}

/**
 * Extract relationships from module-level calls like:
 *   Post.belongsTo('author', ...)
 *   User.hasMany('posts', ...)
 */
function extractRelationshipsFromCalls(
  body: Statement[],
  className: string,
  _source: string,
): ModelRelationship[] {
  const relationships: ModelRelationship[] = []
  const relMethods = new Set(['belongsTo', 'hasMany', 'hasOne', 'belongsToMany', 'hasManyThrough', 'morphMany', 'morphTo'])

  for (const node of body) {
    let expr: Expression | null = null

    if (node.type === 'ExpressionStatement') {
      expr = node.expression
    }
    // if (typeof ClassName.method === 'function') { ClassName.method(...) }
    if (node.type === 'IfStatement' && node.consequent.type === 'BlockStatement') {
      for (const stmt of node.consequent.body) {
        if (stmt.type === 'ExpressionStatement') {
          const call = stmt.expression
          if (call.type === 'CallExpression' && call.callee.type === 'MemberExpression') {
            const obj = call.callee.object
            const prop = call.callee.property
            if (
              obj.type === 'Identifier' &&
              obj.name === className &&
              prop.type === 'Identifier' &&
              relMethods.has(prop.name)
            ) {
              const relName = call.arguments[0]
              if (relName?.type === 'StringLiteral') {
                relationships.push({
                  name: relName.value,
                  type: prop.name as ModelRelationship['type'],
                })
              }
            }
          }
        }
      }
    }

    if (
      expr?.type === 'CallExpression' &&
      expr.callee.type === 'MemberExpression' &&
      expr.callee.object.type === 'Identifier' &&
      expr.callee.object.name === className &&
      expr.callee.property.type === 'Identifier' &&
      relMethods.has(expr.callee.property.name)
    ) {
      const relName = expr.arguments[0]
      if (relName?.type === 'StringLiteral') {
        relationships.push({
          name: relName.value,
          type: expr.callee.property.name as ModelRelationship['type'],
        })
      }
    }
  }

  return relationships
}

/**
 * Merge relationships from body (relationTypes) and calls, preferring body info.
 */
function mergeRelationships(
  bodyRels: ModelRelationship[],
  callRels: ModelRelationship[],
): ModelRelationship[] {
  const merged = new Map<string, ModelRelationship>()

  for (const rel of callRels) {
    merged.set(rel.name, rel)
  }

  for (const rel of bodyRels) {
    const existing = merged.get(rel.name)
    if (existing) {
      // Body has richer info (model name from type annotation)
      merged.set(rel.name, { ...existing, ...rel })
    } else {
      merged.set(rel.name, rel)
    }
  }

  return Array.from(merged.values())
}
