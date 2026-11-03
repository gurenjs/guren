/**
 * The static reading of an app's broadcastable event classes (RFC 0037): the
 * name each is sent as and the channels it names, as `broadcastNameOf()` and
 * `broadcastChannelsOf()` in `@guren/server` compute them at runtime. `guren
 * check`'s live-props rule and `channels.gen.ts` both read it, so the two agree.
 */
import type { ClassDeclaration, Node, Statement } from '@babel/types'
import { literalString, memberKeyName, unwrapTypeAssertion } from './ast-walk'
import { classActionMembers, type ClassActionMember } from './controller-methods'
import { extractClassDeclaration } from './model-parser'

type MemberBody = ClassActionMember['body']

export interface BroadcastEventClass {
  name: string
  /** Absolute path of the file declaring it. */
  filePath: string
  /**
   * `broadcastAs()` (own or inherited), an own static `eventName`, or an own
   * instance `eventName`, so a bundle renaming the class cannot change the wire
   * name. Undefined when a base class the reader cannot see might pin it.
   */
  pinned: boolean | undefined
  /** The literal name it is sent as; undefined when computed or unknown. */
  eventName: string | undefined
  /** Channel patterns, a template's `${this.orderId}` as `{orderId}`; undefined when `broadcastOn()` is not one literal array. */
  channels: string[] | undefined
  /** The object literal `broadcastWith()` returns, for codegen's payload type. */
  payload: Node | undefined
}

/** One class as declared, before its base classes are followed. */
interface DeclaredClass {
  name: string
  filePath: string
  /** The base class's name; `null` for a base the reader cannot name (`extends mixin(X)`). */
  base: string | null | undefined
  broadcastOn?: MemberBody
  broadcastAs?: MemberBody
  broadcastWith?: MemberBody
  /** An own static or instance `eventName`, which `resolveEventName()` and `event.eventName` read. */
  ownEventName?: { literal: string | undefined }
}

/** The framework base: its `eventName` getter answers the class name, so it pins nothing. */
const FRAMEWORK_EVENT = 'Event'

/** Every class in a set of parsed files, by name; two files may declare one name. */
export class BroadcastEventIndex {
  private readonly declared = new Map<string, DeclaredClass[]>()

  add(statements: readonly Statement[], filePath: string): void {
    for (const statement of statements) {
      const declaration = extractClassDeclaration(statement)
      if (!declaration?.id) continue
      const reading = declareClass(declaration, filePath)
      this.declared.set(reading.name, [...(this.declared.get(reading.name) ?? []), reading])
    }
  }

  /** The event classes declared under `name`, each with its base classes followed. */
  lookup(name: string): BroadcastEventClass[] {
    return (this.declared.get(name) ?? [])
      .map((declared) => this.resolve(declared))
      .filter((reading): reading is BroadcastEventClass => reading !== undefined)
  }

  /** The one event class of a name, or undefined when none or several are. */
  unique(name: string): BroadcastEventClass | undefined {
    const readings = this.lookup(name)
    return readings.length === 1 ? readings[0] : undefined
  }

  private resolve(declared: DeclaredClass): BroadcastEventClass | undefined {
    let { broadcastOn, broadcastAs, broadcastWith } = declared
    let baseUnseen = false
    const seen = new Set<DeclaredClass>([declared])
    let current = declared
    while (current.base !== undefined && (!broadcastOn || !broadcastAs || !broadcastWith)) {
      if (current.base === FRAMEWORK_EVENT && !this.declared.has(FRAMEWORK_EVENT)) break
      const parents = current.base === null ? [] : (this.declared.get(current.base) ?? [])
      const parent = parents.length === 1 ? parents[0] : undefined
      if (!parent || seen.has(parent)) {
        baseUnseen = true
        break
      }
      seen.add(parent)
      broadcastOn ??= parent.broadcastOn
      broadcastAs ??= parent.broadcastAs
      broadcastWith ??= parent.broadcastWith
      current = parent
    }
    if (!broadcastOn) return undefined

    const pinned = broadcastAs !== undefined || declared.ownEventName !== undefined ? true : baseUnseen ? undefined : false
    const eventName = broadcastAs
      ? (literalString(returnedValue(broadcastAs)) ?? undefined)
      : declared.ownEventName
        ? declared.ownEventName.literal
        : pinned === false
          ? declared.name
          : undefined
    return {
      name: declared.name,
      filePath: declared.filePath,
      pinned,
      eventName,
      channels: channelPatterns(returnedValue(broadcastOn)),
      payload: broadcastWith ? objectReturned(broadcastWith) : undefined,
    }
  }
}

function declareClass(declaration: ClassDeclaration, filePath: string): DeclaredClass {
  const superClass = declaration.superClass ? unwrapTypeAssertion(declaration.superClass) : undefined
  const reading: DeclaredClass = {
    name: declaration.id!.name,
    filePath,
    base: superClass === undefined ? undefined : superClass.type === 'Identifier' ? superClass.name : null,
  }

  // Both member forms, as at runtime: `broadcastOn() {}` and `broadcastOn = () => […]`.
  for (const { member, name, body } of classActionMembers(declaration)) {
    if (name === 'eventName') {
      // A `static get eventName()` is an own static `resolveEventName()` reads; an instance one is `event.eventName`.
      reading.ownEventName = { literal: literalString(returnedValue(body)) ?? undefined }
    } else if (member.static) {
      continue
    } else if (name === 'broadcastOn') reading.broadcastOn = body
    else if (name === 'broadcastAs') reading.broadcastAs = body
    else if (name === 'broadcastWith') reading.broadcastWith = body
  }
  for (const member of declaration.body.body) {
    if (member.type !== 'ClassProperty' || memberKeyName(member) !== 'eventName') continue
    if (member.value?.type === 'ArrowFunctionExpression' || member.value?.type === 'FunctionExpression') continue
    reading.ownEventName = { literal: member.value ? (literalString(member.value) ?? undefined) : undefined }
  }
  return reading
}

/** The expression a member's single `return` hands back, or an arrow's expression body. */
function returnedValue(body: MemberBody): Node | undefined {
  if (body.type !== 'BlockStatement') return unwrapTypeAssertion(body)
  const returns = body.body.filter((statement) => statement.type === 'ReturnStatement')
  if (returns.length !== 1) return undefined
  const argument = (returns[0] as { argument?: Node | null }).argument
  return argument ? unwrapTypeAssertion(argument) : undefined
}

function objectReturned(body: MemberBody): Node | undefined {
  const value = returnedValue(body)
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
