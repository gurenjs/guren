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
  const policy = findPolicy(ast, className)
  if ('unreadable' in policy) return policy
  return 'declaration' in policy ? classAbilities(policy.declaration, policy.imports) : objectAbilities(policy.definition)
}

type FoundPolicy =
  | { declaration: ClassDeclaration; imports: Map<string, ImportEntry> }
  | { definition: ObjectExpression }
  | PlanAppUnreadable

function findPolicy(ast: File, className: string): FoundPolicy {
  const imports = importsByLocal(ast.program.body)
  let defaultClass: ClassDeclaration | undefined
  for (const node of ast.program.body) {
    const declaration = extractClassDeclaration(node)
    if (declaration?.id?.name === className) return { declaration, imports }
    if (declaration && node.type === 'ExportDefaultDeclaration') defaultClass = declaration
    for (const declarator of topLevelDeclaration(node)?.declarations ?? []) {
      if (declarator.id.type !== 'Identifier' || declarator.id.name !== className || !declarator.init) continue
      const definition = definePolicyObject(declarator.init, imports)
      return definition ? { definition } : { unreadable: `${className} is not a class, and not a definePolicy({ … }) object literal` }
    }
  }
  if (defaultClass) return { declaration: defaultClass, imports }
  return { unreadable: `the file declares no class ${className}` }
}

/** How an ability's parameter after the user is declared: what the gate would call it without, for a bare class. */
export type PolicyParameter = 'required' | 'optional' | 'rest'

/**
 * The parameters of one ability's function, the user included, as the gate calls it: a class
 * method or function field, or a `definePolicy({ … })` key. `undefined` when the policy declares
 * no such function; why it is unread when the name is a field or the policy is not read.
 */
export function readPolicyAbilityParameters(ast: File, className: string, ability: string): PolicyParameter[] | PlanAppUnreadable | undefined {
  const policy = findPolicy(ast, className)
  if ('unreadable' in policy) return policy
  if ('definition' in policy) {
    for (const property of policy.definition.properties) {
      if (property.type === 'SpreadElement' || memberKeyName(property) !== ability) continue
      if (property.type === 'ObjectMethod') return parameterKinds(property.params)
      const value = unwrapTypeAssertion(property.value as Node)
      if (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression') return parameterKinds(value.params)
      return { unreadable: `${className}.${ability} is not a function written in place` }
    }
    return undefined
  }
  for (const { member, name } of classActionMembers(policy.declaration)) {
    if (name !== ability || member.static) continue
    if (member.type === 'ClassMethod') {
      if (member.kind !== 'method') return { unreadable: `${className}.${ability} is an accessor` }
      return parameterKinds(member.params)
    }
    const value = member.value
    if (value && (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression')) return parameterKinds(value.params)
  }
  return undefined
}

function parameterKinds(params: readonly Node[]): PolicyParameter[] {
  return params.map((param) => {
    const node = param.type === 'TSParameterProperty' ? param.parameter : param
    if (node.type === 'RestElement') return 'rest'
    if (node.type === 'AssignmentPattern') return 'optional'
    return 'optional' in node && node.optional ? 'optional' : 'required'
  })
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
