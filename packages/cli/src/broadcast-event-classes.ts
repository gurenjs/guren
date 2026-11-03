/**
 * The static reading of an app's broadcastable event classes (RFC 0037): the
 * name each is sent as and the channels it names, as `broadcastNameOf()` and
 * `broadcastChannelsOf()` in `@guren/server` compute them at runtime. `guren
 * check`'s live-props rule and `channels.gen.ts` both read it, so the two agree.
 */
import type { ClassDeclaration, ClassMethod, Node, Statement } from '@babel/types'
import { literalString, memberKeyName, unwrapTypeAssertion } from './ast-walk'
import { extractClassDeclaration } from './model-parser'

export interface BroadcastEventClass {
  name: string
  filePath: string
  /** `broadcastAs()` or a static `eventName`, so a bundle renaming the class cannot change the wire name. */
  pinned: boolean
  /** The literal name it is sent as; undefined when `broadcastAs()` computes it. */
  eventName: string | undefined
  /** Channel patterns, a template's `${this.orderId}` as `{orderId}`; undefined when `broadcastOn()` is not one literal array. */
  channels: string[] | undefined
  /** The object literal `broadcastWith()` returns, for codegen's payload type. */
  payload: Node | undefined
}

/** Every class in the parsed statements that declares `broadcastOn()`, by class name. */
export function readBroadcastEventClasses(
  statements: readonly Statement[],
  filePath: string,
  into: Map<string, BroadcastEventClass> = new Map(),
): Map<string, BroadcastEventClass> {
  for (const statement of statements) {
    const declaration = extractClassDeclaration(statement)
    if (!declaration?.id) continue
    const reading = readClass(declaration, filePath)
    if (reading) into.set(reading.name, reading)
  }
  return into
}

function readClass(declaration: ClassDeclaration, filePath: string): BroadcastEventClass | undefined {
  const name = declaration.id!.name
  let broadcastOn: ClassMethod | undefined
  let broadcastAs: ClassMethod | undefined
  let broadcastWith: ClassMethod | undefined
  let staticEventName: string | null | undefined

  for (const member of declaration.body.body) {
    const key = 'key' in member
      ? memberKeyName({ computed: Boolean((member as { computed?: boolean }).computed), key: member.key as unknown as { type: string; name?: string } })
      : undefined
    if (member.type === 'ClassMethod' && !member.static) {
      if (key === 'broadcastOn') broadcastOn = member
      else if (key === 'broadcastAs') broadcastAs = member
      else if (key === 'broadcastWith') broadcastWith = member
    } else if (member.type === 'ClassProperty' && member.static && key === 'eventName') {
      staticEventName = member.value ? literalString(member.value) : null
    }
  }
  if (!broadcastOn) return undefined

  const asName = broadcastAs ? literalString(returnedValue(broadcastAs)) : null
  return {
    name,
    filePath,
    pinned: broadcastAs !== undefined || staticEventName !== undefined,
    eventName: broadcastAs ? (asName ?? undefined) : staticEventName === undefined ? name : (staticEventName ?? undefined),
    channels: channelPatterns(returnedValue(broadcastOn)),
    payload: broadcastWith ? objectReturned(broadcastWith) : undefined,
  }
}

/** The expression a method's single `return` hands back. */
function returnedValue(method: ClassMethod): Node | undefined {
  const returns = method.body.body.filter((statement) => statement.type === 'ReturnStatement')
  if (returns.length !== 1) return undefined
  const argument = (returns[0] as { argument?: Node | null }).argument
  return argument ? unwrapTypeAssertion(argument) : undefined
}

function objectReturned(method: ClassMethod): Node | undefined {
  const value = returnedValue(method)
  return value?.type === 'ObjectExpression' ? value : undefined
}

function channelPatterns(value: Node | undefined): string[] | undefined {
  if (value?.type !== 'ArrayExpression') return undefined
  const patterns: string[] = []
  for (const element of value.elements) {
    const pattern = element ? channelPattern(unwrapTypeAssertion(element as Node)) : undefined
    if (pattern === undefined) return undefined
    patterns.push(pattern)
  }
  return patterns
}

function channelPattern(node: Node): string | undefined {
  if (node.type === 'StringLiteral') return node.value
  if (node.type !== 'TemplateLiteral') return undefined
  let pattern = ''
  node.quasis.forEach((quasi, index) => {
    pattern += quasi.value.cooked ?? quasi.value.raw
    const expression = node.expressions[index]
    if (expression) pattern += `{${placeholderName(expression as Node)}}`
  })
  return pattern
}

function placeholderName(expression: Node): string {
  if (expression.type === 'Identifier') return expression.name
  if (expression.type === 'MemberExpression' && !expression.computed && expression.property.type === 'Identifier') {
    return expression.property.name
  }
  return 'param'
}
