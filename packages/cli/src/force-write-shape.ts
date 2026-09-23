import { type BabelNode, memberKeyName, unwrapTypeAssertion, walk } from './ast-walk'
import type { ControllerMemberName, ControllerMethodInfo } from './controller-methods'

/**
 * Where a `const` at the top of an action got its value. A name declared twice
 * anywhere in the action, or bound any other way, has no origin.
 */
type BindingOrigin =
  /** `const data = await this.validateBody(…)`, or the rest element of a pattern over it. */
  | 'validated-object'
  /** A field destructured out of the same call. */
  | 'validated-field'
  /** `const user = await this.auth.userOrFail(…)`. */
  | 'session'
  /** `const post = this.model(…)`, the record route model binding resolved. */
  | 'bound-model'

/**
 * Whether every forceCreate/forceUpdate in an action writes the owner shape of tutorial
 * chapter 6: an object literal spreading only a validated body and naming at least one
 * column the server sets from the session, a bound record or a literal. The schema chose
 * the spread keys and the author named the rest, so the request chose none. The schema is
 * trusted as the allowlist (a `.passthrough()` one is invisible here); unproven is false.
 */
export function forceWritesKeepServerOwnedColumns(method: Pick<ControllerMethodInfo, 'fn'>): boolean {
  const fn = method.fn as unknown as BabelNode
  const bindings = topLevelBindings(fn)
  const calls = forceWriteCalls(fn)
  return calls.length > 0 && calls.every((call) => isServerOwnedPayload(call, bindings))
}

function topLevelBindings(fn: BabelNode): Map<string, BindingOrigin> {
  const declared = new Map<string, number>()
  walk(fn, (node) => {
    for (const name of declaredNames(node)) declared.set(name, (declared.get(name) ?? 0) + 1)
  })

  const origins = new Map<string, BindingOrigin>()
  const body = fn.body as BabelNode | undefined
  if (body?.type !== 'BlockStatement') return origins

  for (const statement of body.body as BabelNode[]) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue
    for (const declarator of statement.declarations as BabelNode[]) {
      for (const [name, origin] of declaratorOrigins(declarator)) {
        if (declared.get(name) === 1) origins.set(name, origin)
      }
    }
  }

  // A validated object written to after validation holds keys the schema never saw.
  walk(fn, (node) => {
    const target = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument : undefined
    const root = target ? memberRoot(target as BabelNode) : undefined
    if (root && root !== target && origins.get(root.name as string) === 'validated-object') {
      origins.delete(root.name as string)
    }
  })
  return origins
}

/** Every name a node binds. Any function kind is recognised by its `params`, not by type name. */
function declaredNames(node: BabelNode): string[] {
  if (Array.isArray(node.params)) {
    const id = node.id && typeof node.id === 'object' ? patternNames(node.id as BabelNode) : []
    return [...(node.params as BabelNode[]).flatMap(patternNames), ...id]
  }
  switch (node.type) {
    case 'VariableDeclarator':
      return patternNames(node.id as BabelNode)
    case 'CatchClause':
      return node.param ? patternNames(node.param as BabelNode) : []
    case 'ClassDeclaration':
    case 'ClassExpression':
      return node.id ? patternNames(node.id as BabelNode) : []
    default:
      return []
  }
}

function patternNames(pattern: BabelNode): string[] {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name as string]
    case 'ObjectPattern':
      return (pattern.properties as BabelNode[]).flatMap((property) =>
        patternNames((property.type === 'RestElement' ? property.argument : property.value) as BabelNode))
    case 'ArrayPattern':
      return (pattern.elements as Array<BabelNode | null>).flatMap((element) => (element ? patternNames(element) : []))
    case 'RestElement':
      return patternNames(pattern.argument as BabelNode)
    case 'AssignmentPattern':
      return patternNames(pattern.left as BabelNode)
    case 'TSParameterProperty':
      return patternNames(pattern.parameter as BabelNode)
    default:
      return []
  }
}

function declaratorOrigins(declarator: BabelNode): Array<[string, BindingOrigin]> {
  const id = declarator.id as BabelNode
  const init = declarator.init ? unwrapTypeAssertion(declarator.init as BabelNode) : undefined
  if (!init) return []

  if (isAwaitedThisCall(init, 'validateBody')) {
    if (id.type === 'Identifier') return [[id.name as string, 'validated-object']]
    if (id.type !== 'ObjectPattern') return []
    const origins: Array<[string, BindingOrigin]> = []
    for (const property of id.properties as BabelNode[]) {
      const rest = property.type === 'RestElement'
      const target = (rest ? property.argument : property.value) as BabelNode
      if (target.type === 'Identifier') origins.push([target.name as string, rest ? 'validated-object' : 'validated-field'])
    }
    return origins
  }

  if (id.type !== 'Identifier') return []
  if (isAwaitedThisCall(init, 'auth', 'userOrFail')) return [[id.name as string, 'session']]
  if (isThisCall(init, 'model')) return [[id.name as string, 'bound-model']]
  return []
}

function isAwaitedThisCall(node: BabelNode, member: ControllerMemberName, ...rest: string[]): boolean {
  return node.type === 'AwaitExpression' && isThisCall(unwrapTypeAssertion(node.argument as BabelNode), member, ...rest)
}

/**
 * `this.<member>.<rest…>(…)` through plain property steps, the only way a protected member
 * is reached. The member is typed so a rename in `Controller` fails to compile here.
 */
function isThisCall(node: BabelNode, member: ControllerMemberName, ...rest: string[]): boolean {
  const path = [member, ...rest]
  if (node.type !== 'CallExpression') return false
  let current = node.callee as BabelNode
  for (let index = path.length - 1; index >= 0; index--) {
    if (current.type !== 'MemberExpression' || current.computed) return false
    if ((current.property as BabelNode).name !== path[index]) return false
    current = current.object as BabelNode
  }
  return current.type === 'ThisExpression'
}

interface ForceWriteCall {
  method: 'forceCreate' | 'forceUpdate'
  args: BabelNode[]
}

function forceWriteCalls(fn: BabelNode): ForceWriteCall[] {
  const calls: ForceWriteCall[] = []
  walk(fn, (node) => {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return
    const callee = unwrapTypeAssertion(node.callee as BabelNode)
    if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return
    const name = memberKeyName({ computed: Boolean(callee.computed), key: callee.property as never })
    if (name === 'forceCreate' || name === 'forceUpdate') {
      calls.push({ method: name, args: node.arguments as BabelNode[] })
    }
  })
  return calls
}

function isServerOwnedPayload(call: ForceWriteCall, bindings: Map<string, BindingOrigin>): boolean {
  const argument = call.args[call.method === 'forceCreate' ? 0 : 1]
  if (!argument) return false
  const payload = unwrapTypeAssertion(argument)
  if (payload.type !== 'ObjectExpression') return false

  let serverSet = 0
  for (const property of payload.properties as BabelNode[]) {
    if (property.type === 'SpreadElement') {
      const spread = unwrapTypeAssertion(property.argument as BabelNode)
      if (spread.type !== 'Identifier' || bindings.get(spread.name as string) !== 'validated-object') return false
      continue
    }
    if (property.type !== 'ObjectProperty' || property.computed) return false
    const source = valueSource(unwrapTypeAssertion(property.value as BabelNode), bindings)
    if (!source) return false
    if (source === 'server') serverSet++
  }
  return serverSet > 0
}

/** `server` for a value the request had no say in, `validated` for one the schema passed. */
function valueSource(node: BabelNode, bindings: Map<string, BindingOrigin>): 'server' | 'validated' | undefined {
  if (
    node.type === 'StringLiteral'
    || node.type === 'NumericLiteral'
    || node.type === 'BooleanLiteral'
    || node.type === 'NullLiteral'
  ) {
    return 'server'
  }

  const root = memberRoot(node)
  if (!root) return undefined
  const origin = bindings.get(root.name as string)
  const isMember = root !== node
  if ((origin === 'session' || origin === 'bound-model') && isMember) return 'server'
  if (origin === 'validated-field' || (origin === 'validated-object' && isMember)) return 'validated'
  return undefined
}

/** The identifier a non-computed member chain starts from, or the identifier itself. */
function memberRoot(node: BabelNode): BabelNode | undefined {
  let current = node
  while (current.type === 'MemberExpression' && !current.computed) current = current.object as BabelNode
  return current.type === 'Identifier' ? current : undefined
}
