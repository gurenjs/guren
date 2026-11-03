/**
 * The static reading of an app's broadcastable event classes (RFC 0037): the
 * name each is sent as and the channels it names, as `broadcastNameOf()` and
 * `broadcastChannelsOf()` in `@guren/server` compute them at runtime. `guren
 * check`'s live-props rule and `channels.gen.ts` both read it, so the two agree.
 */
import type { ClassDeclaration, Node, Statement } from '@babel/types'
import { literalString, memberKeyName, soleReturnedValue, unwrapTypeAssertion } from './ast-walk'
import { classActionMembers, type ClassActionMember } from './controller-methods'
import { cachedFileProbe, resolveImportPath } from './import-resolution'
import { extractClassDeclaration } from './model-parser'
import { importsByLocal, specifierBase, type ImportEntry } from './schema-binding'

type MemberBody = ClassActionMember['body']

export interface BroadcastEventClass {
  name: string
  /** Absolute path of the file declaring it. */
  filePath: string
  /**
   * Whether a bundle renaming the class leaves the wire name alone: `broadcastAs()`
   * or an instance `eventName` (own or inherited), or an own static `eventName`.
   * Undefined when a base class the reader cannot see might pin it.
   */
  pinned: boolean | undefined
  /** The literal name it is sent as; undefined when computed or unknown. */
  eventName: string | undefined
  /** Channel patterns, a template's `${this.orderId}` as `{orderId}`; undefined when `broadcastOn()` is not one literal array. */
  channels: string[] | undefined
  /** The object literal `broadcastWith()` returns, for codegen's payload type. */
  payload: Node | undefined
}

export type BroadcastEventLookup = { kind: 'class'; reading: BroadcastEventClass } | { kind: 'unread'; reason: string }

/**
 * One step of `broadcastNameOf()` that answers, so the runtime goes no further:
 * its literal, or undefined for a value the reader cannot name (a computed one,
 * `''` or a function, the last two of which throw at runtime).
 */
type NameStep = { literal: string | undefined }

type Base = { kind: 'none' } | { kind: 'framework' } | { kind: 'opaque' } | { kind: 'local'; name: string }

/** One class as declared, before its base classes are followed. */
interface DeclaredClass {
  name: string
  filePath: string
  exportedAsDefault: boolean
  base: Base
  broadcastOn?: MemberBody
  broadcastAs?: MemberBody
  broadcastWith?: MemberBody
  /** `event.eventName`, which instances inherit. The framework `Event`'s own getter defers to the static. */
  instanceName?: NameStep
  /** An own static `eventName`, the only one `resolveEventName()` reads. */
  staticName?: NameStep
}

/** `@guren/core`, `@guren/server` and their subpaths, where the framework `Event` comes from. */
const FRAMEWORK_PACKAGE = /^@guren\/(core|server)(\/|$)/

/** Every class in a set of parsed files, each resolved through the imports of the file naming it. */
export class BroadcastEventIndex {
  private readonly files = new Map<string, { imports: Map<string, ImportEntry>; classes: DeclaredClass[] }>()
  private readonly byName = new Map<string, DeclaredClass[]>()
  private readonly readings = new Map<DeclaredClass, Promise<BroadcastEventClass | undefined>>()
  private readonly probe = cachedFileProbe()

  constructor(private readonly cwd: string) {}

  add(statements: readonly Statement[], filePath: string): void {
    if (this.files.has(filePath)) return
    const imports = importsByLocal([...statements])
    const classes: DeclaredClass[] = []
    for (const statement of statements) {
      const declaration = extractClassDeclaration(statement)
      if (!declaration?.id) continue
      const declared = declareClass(declaration, filePath, imports, statement.type === 'ExportDefaultDeclaration')
      classes.push(declared)
      this.byName.set(declared.name, [...(this.byName.get(declared.name) ?? []), declared])
    }
    this.files.set(filePath, { imports, classes })
  }

  /** The event class `new <local>(…)` constructs in `filePath`, through that file's import of the name. */
  async constructed(local: string, filePath: string): Promise<BroadcastEventLookup> {
    const declared = await this.declarationOf(local, filePath)
    if (typeof declared === 'string') return { kind: 'unread', reason: declared }
    const reading = await this.read(declared)
    return reading ? { kind: 'class', reading } : { kind: 'unread', reason: `${local}, whose class has no broadcastOn()` }
  }

  /** The class a name binds in a file, or why the reader cannot say which. */
  private async declarationOf(local: string, filePath: string): Promise<DeclaredClass | string> {
    const file = this.files.get(filePath)
    const entry = file?.imports.get(local)
    if (!entry) return file?.classes.find((declared) => declared.name === local) ?? this.onlyNamed(local)
    const base = specifierBase(this.cwd, filePath, entry.source)
    if (base === null) return `${local}, imported from ${entry.source}, which the check does not read`
    const target = await resolveImportPath(base, { probe: this.probe })
    const classes = target ? this.files.get(target)?.classes : undefined
    const found = classes?.find((declared) => (entry.kind === 'default' ? declared.exportedAsDefault : declared.name === entry.imported))
    // A barrel's `export *` is not followed; its one class of that name is the import's.
    return found ?? (entry.kind === 'named' ? this.onlyNamed(entry.imported) : `${local}, whose class the check cannot find in ${entry.source}`)
  }

  private onlyNamed(name: string): DeclaredClass | string {
    const named = this.byName.get(name) ?? []
    if (named.length === 1) return named[0]!
    return named.length > 1 ? `${name}, which more than one file under app/ declares` : `${name}, whose class the check cannot find under app/`
  }

  private read(declared: DeclaredClass): Promise<BroadcastEventClass | undefined> {
    let reading = this.readings.get(declared)
    if (!reading) this.readings.set(declared, (reading = this.resolve(declared)))
    return reading
  }

  /** `broadcastNameOf()`'s order: `broadcastAs()`, then `event.eventName`, then the own static, then the class name. */
  private async resolve(declared: DeclaredClass): Promise<BroadcastEventClass | undefined> {
    let { broadcastOn, broadcastAs, broadcastWith, instanceName } = declared
    let unseen = false
    const seen = new Set<DeclaredClass>([declared])
    let current = declared
    while (current.base.kind === 'local' || current.base.kind === 'opaque') {
      if (broadcastOn && broadcastAs && broadcastWith && instanceName) break
      const parent = current.base.kind === 'local' ? await this.declarationOf(current.base.name, current.filePath) : undefined
      if (!parent || typeof parent === 'string' || seen.has(parent)) {
        unseen = true
        break
      }
      seen.add(parent)
      broadcastOn ??= parent.broadcastOn
      broadcastAs ??= parent.broadcastAs
      broadcastWith ??= parent.broadcastWith
      instanceName ??= parent.instanceName
      current = parent
    }
    if (!broadcastOn && !unseen) return undefined

    const named = broadcastAs ? bodyStep(broadcastAs) : undefined
    const later = instanceName ?? declared.staticName
    // An unseen base may hold a broadcastAs() or an instance name that answers first.
    const pinned = named || later ? true : unseen ? undefined : false
    const eventName = named ? named.literal : unseen ? undefined : later ? later.literal : declared.name
    const payload = broadcastWith ? soleReturnedValue(broadcastWith) : undefined
    return {
      name: declared.name,
      filePath: declared.filePath,
      pinned,
      eventName,
      channels: broadcastOn ? channelPatterns(soleReturnedValue(broadcastOn)) : undefined,
      payload: payload?.type === 'ObjectExpression' ? payload : undefined,
    }
  }
}

function declareClass(declaration: ClassDeclaration, filePath: string, imports: Map<string, ImportEntry>, exportedAsDefault: boolean): DeclaredClass {
  const reading: DeclaredClass = { name: declaration.id!.name, filePath, exportedAsDefault, base: baseOf(declaration, imports) }

  // Both member forms, as at runtime: `broadcastOn() {}` and `broadcastOn = () => […]`.
  for (const { member, name, body } of classActionMembers(declaration)) {
    if (name === 'eventName') {
      // A getter answers with what it returns; a method or an arrow field is a function, which the runtime rejects.
      const step = 'kind' in member && member.kind === 'get' ? bodyStep(body) : { literal: undefined }
      if (member.static) reading.staticName = step
      else reading.instanceName = step
    } else if (member.static) {
      continue
    } else if (name === 'broadcastOn') reading.broadcastOn = body
    else if (name === 'broadcastAs') reading.broadcastAs = body
    else if (name === 'broadcastWith') reading.broadcastWith = body
  }
  for (const member of declaration.body.body) {
    if (member.type !== 'ClassProperty' || member.declare || memberKeyName(member) !== 'eventName') continue
    if (member.value?.type === 'ArrowFunctionExpression' || member.value?.type === 'FunctionExpression') continue
    const step = valueStep(member.value)
    if (!step) continue
    if (member.static) reading.staticName = step
    else reading.instanceName = step
  }
  return reading
}

function baseOf(declaration: ClassDeclaration, imports: Map<string, ImportEntry>): Base {
  if (!declaration.superClass) return { kind: 'none' }
  const superClass = unwrapTypeAssertion(declaration.superClass)
  if (superClass.type !== 'Identifier') return { kind: 'opaque' }
  const entry = imports.get(superClass.name)
  if (entry && FRAMEWORK_PACKAGE.test(entry.source)) return entry.imported === 'Event' ? { kind: 'framework' } : { kind: 'opaque' }
  return { kind: 'local', name: superClass.name }
}

/** A value the runtime reads as a name: none for an absent, `undefined` or `null` one, which it passes over. */
function valueStep(value: Node | null | undefined): NameStep | undefined {
  if (!value) return undefined
  const node = unwrapTypeAssertion(value)
  if (node.type === 'NullLiteral' || (node.type === 'Identifier' && node.name === 'undefined') || (node.type === 'UnaryExpression' && node.operator === 'void')) {
    return undefined
  }
  return { literal: literalString(node) || undefined }
}

/** A method's answer: what its one `return` hands back, unknown when it returns from more places or none. */
function bodyStep(body: MemberBody): NameStep | undefined {
  const value = soleReturnedValue(body)
  return value ? valueStep(value) : { literal: undefined }
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
