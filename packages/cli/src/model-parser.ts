import { readFile } from 'node:fs/promises'
import { parse } from '@babel/parser'
import type { Statement, Expression, ClassDeclaration, ClassBody } from '@babel/types'
import { extractDocsTags } from './docs-index'

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

export function parseModelSource(source: string, filePath: string): ModelInfo | null {
  let ast: ReturnType<typeof parse>
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript'],
    })
  } catch {
    return null
  }

  let classDecl: ClassDeclaration | null = null

  for (const node of ast.program.body) {
    classDecl = extractClassDeclaration(node)
    if (classDecl) break
  }

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

function analyzeClassHeader(
  classDecl: ClassDeclaration,
  source: string,
): { tableName?: string; usesAuth: boolean; hasSoftDeletes: boolean } {
  let tableName: string | undefined
  let usesAuth = false
  const hasSoftDeletes = source.includes('SoftDeletes')

  const superClass = classDecl.superClass
  if (superClass) {
    // defineModel(posts) pattern
    if (superClass.type === 'CallExpression') {
      const callee = superClass.callee
      if (callee.type === 'Identifier' && callee.name === 'defineModel') {
        const firstArg = superClass.arguments[0]
        if (firstArg?.type === 'Identifier') {
          tableName = firstArg.name
        }
      }
    }
    // AuthenticatableModel pattern
    if (superClass.type === 'Identifier' && superClass.name === 'AuthenticatableModel') {
      usesAuth = true
    }
    if (superClass.type === 'TSInstantiationExpression' && superClass.expression.type === 'Identifier' && superClass.expression.name === 'AuthenticatableModel') {
      usesAuth = true
    }
  }

  // Check for static table = xxx
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

  return { tableName, usesAuth, hasSoftDeletes }
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
