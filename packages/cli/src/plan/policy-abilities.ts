/**
 * A policy's abilities as `plan:status` reads them (RFC 0030 §6): the members of the class
 * `make:policy` writes (`extends Policy`), or the keys of a `definePolicy({ … })` object.
 * Members come from `classActionMembers`, the rule `Router` dispatch is read by; the Gate
 * looks an ability up on the instance by name the same way.
 */

import type { ClassDeclaration, File, Node, ObjectExpression } from '@babel/types'

import { memberKeyName, topLevelDeclaration, unwrapTypeAssertion } from '../ast-walk'
import { classActionMembers } from '../controller-methods'
import { extractClassDeclaration } from '../model-parser'
import { importsByLocal, type ImportEntry } from '../schema-binding'
import type { PlanAppUnreadable } from './unreadable'

export interface PlanAppPolicyAbilities {
  /** Ability names the class or definition declares as a function. */
  declared: string[]
  /** Members holding something other than a function literal (`delete = ownerOnly`, a getter): an ability by name, unread. */
  fields: string[]
  /** Why a name absent from both is no proof of absence: a computed key, a spread, a base class not read. */
  open?: string
  /** Set on a `definePolicy()` policy: the only abilities its class can have, whatever the definition holds. */
  exposes?: readonly string[]
}

const POLICY_PACKAGES = new Set(['@guren/core', '@guren/server'])

/**
 * The methods the class `definePolicy()` returns declares (packages/server/src/authorization/Policy.ts).
 * Any other key of the definition is dropped, and the Gate never finds it; a test pins the list.
 */
export const DEFINE_POLICY_ABILITIES = ['viewAny', 'view', 'create', 'update', 'delete', 'restore', 'forceDelete'] as const

/** Reads the abilities of `className` from its parsed file, or why it could not. */
export function readPolicyAbilities(ast: File, className: string): PlanAppPolicyAbilities | PlanAppUnreadable {
  const imports = importsByLocal(ast.program.body)
  let defaultClass: ClassDeclaration | undefined
  for (const node of ast.program.body) {
    const declaration = extractClassDeclaration(node)
    if (declaration?.id?.name === className) return classAbilities(declaration, imports)
    if (declaration && node.type === 'ExportDefaultDeclaration') defaultClass = declaration
    for (const declarator of topLevelDeclaration(node)?.declarations ?? []) {
      if (declarator.id.type !== 'Identifier' || declarator.id.name !== className || !declarator.init) continue
      const definition = definePolicyObject(declarator.init, imports)
      return definition ? objectAbilities(definition) : { unreadable: `${className} is not a class, and not a definePolicy({ … }) object literal` }
    }
  }
  if (defaultClass) return classAbilities(defaultClass, imports)
  return { unreadable: `the file declares no class ${className}` }
}

function classAbilities(declaration: ClassDeclaration, imports: Map<string, ImportEntry>): PlanAppPolicyAbilities {
  const declared = new Set<string>()
  const methods = new Set<unknown>()
  for (const { member, name } of classActionMembers(declaration)) {
    if (member.static || name === 'constructor' || ('kind' in member && member.kind !== 'method')) continue
    methods.add(member)
    declared.add(name)
  }
  const fields: string[] = []
  let open: string | undefined
  for (const member of declaration.body.body) {
    if (('static' in member && member.static) || methods.has(member) || !('key' in member)) continue
    const name = memberKeyName(member)
    if ('computed' in member && member.computed) open ??= 'a member has a computed name'
    else if (name !== undefined && name !== 'constructor') fields.push(name)
  }
  open ??= superClassOpen(declaration, imports)
  return { declared: [...declared], fields, ...(open ? { open } : {}) }
}

/** Why the base class may declare an ability; `undefined` for `Policy` itself or no base. */
function superClassOpen(declaration: ClassDeclaration, imports: Map<string, ImportEntry>): string | undefined {
  const superClass = declaration.superClass ? unwrapTypeAssertion(declaration.superClass) : null
  if (!superClass) return undefined
  if (superClass.type === 'Identifier') {
    const entry = imports.get(superClass.name)
    if (entry?.imported === 'Policy' && POLICY_PACKAGES.has(entry.source)) return undefined
    return `it extends ${superClass.name}, whose abilities are not read`
  }
  return 'it extends an expression, whose abilities are not read'
}

function definePolicyObject(init: Node, imports: Map<string, ImportEntry>): ObjectExpression | null {
  const call = unwrapTypeAssertion(init)
  if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier') return null
  const entry = imports.get(call.callee.name)
  if (entry?.imported !== 'definePolicy' || !POLICY_PACKAGES.has(entry.source)) return null
  const argument = call.arguments[0] ? unwrapTypeAssertion(call.arguments[0]) : null
  return argument?.type === 'ObjectExpression' ? argument : null
}

function objectAbilities(definition: ObjectExpression): PlanAppPolicyAbilities {
  const declared: string[] = []
  let open: string | undefined
  for (const property of definition.properties) {
    const name = property.type === 'SpreadElement' ? undefined : memberKeyName(property)
    if (name === undefined) open ??= property.type === 'SpreadElement' ? 'the definition spreads another object' : 'a key is computed'
    else declared.push(name)
  }
  return { declared, fields: [], ...(open ? { open } : {}), exposes: DEFINE_POLICY_ABILITIES }
}
