import { readFile } from 'node:fs/promises'
import type { Statement, Expression, ClassDeclaration, ClassBody, ClassProperty, Node, ObjectProperty } from '@babel/types'
import { extractDocsTags } from './docs-index'
import { discoverModelFiles, toPosixRelative, moduleNameFromRelPath } from './discovery'
import { parseSourceFile } from './parse-cache'

export interface ModelRelationship {
  name: string
  type: 'belongsTo' | 'hasMany' | 'hasOne' | 'belongsToMany' | 'hasManyThrough' | 'morphMany' | 'morphTo'
  relatedModel?: string
}

export interface ModelInfo {
  className: string
  filePath: string
  tableName?: string
  relationships: ModelRelationship[]
  usesAuth: boolean
  hasSoftDeletes: boolean
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
  if (property.computed) return undefined
  if (property.key.type === 'Identifier') return property.key.name
  if (property.key.type === 'StringLiteral') return property.key.value
  return undefined
}

/**
 * The table `defineModel(users, …)` binds, reached through any mixin wrapping
 * it — `SoftDeletes(defineModel(posts))` is the documented spelling, and a
 * model written that way must not read as bindless.
 */
function defineModelTableArgument(node: Node): string | undefined {
  if (node.type !== 'CallExpression') return undefined

  const callee = node.callee
  if (callee.type === 'Identifier' && callee.name === 'defineModel') {
    const firstArg = node.arguments[0]
    return firstArg?.type === 'Identifier' ? firstArg.name : undefined
  }

  for (const argument of node.arguments) {
    const nested = defineModelTableArgument(argument)
    if (nested) return nested
  }
  return undefined
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
  // arrives as an option rather than as the superclass itself.
  if (superClass.type === 'CallExpression') {
    const callee = superClass.callee
    if (callee.type === 'Identifier' && callee.name === 'defineModel') {
      const options = superClass.arguments[1]
      if (options?.type === 'ObjectExpression') {
        const viaBase = options.properties.some(
          (property) =>
            property.type === 'ObjectProperty' &&
            propertyKeyName(property) === 'base' &&
            isAuthenticatableBase(property.value),
        )
        if (viaBase) return true
      }
    }
  }
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

/** Entries of `static <name> = ['a', 'b']`, or undefined when absent or not an array literal. */
export function staticStringArrayProperty(classDecl: ClassDeclaration, name: string): string[] | undefined {
  const property = findStaticClassProperty(classDecl, name)
  if (property?.value?.type !== 'ArrayExpression') return undefined
  const entries: string[] = []
  for (const element of property.value.elements) {
    if (element?.type === 'StringLiteral') entries.push(element.value)
  }
  return entries
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
