/**
 * Where the application's source dispatches, registers or sends a side-effect class, the
 * evidence `plan:status` reads a side effect's `wired` from (RFC 0030 §6). A use is a call
 * of the framework's own API taking the class, or an instance of it, as its subject:
 * `Job.dispatch()`, `queue.dispatch(Job)`, `schedule.job(Job)`, `events.emit(new E())`,
 * `events.listen(L)` or `events.on(E, …)` holding `L`, `mail.send()` on a `new M()`,
 * `notifications.send(to, new N())`. Anything else naming the class is a mention only.
 * Read off the AST, so a comment, a string, an import and a type position never count.
 */

import { readdir } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import type { File } from '@babel/types'

import { topLevelDeclaration, unwrapTypeAssertion, walk, type BabelNode } from '../ast-walk'
import { collectFiles, IMPORTABLE_EXTENSIONS, listAppRoots, toPosixRelative } from '../discovery'
import { extractClassDeclaration } from '../model-parser'
import type { ParseCache } from '../parse-cache'
import { importsByLocal, specifierBase, withoutExtension, type ImportEntry } from '../schema-binding'
import type { PlanAppSideEffectKind } from './app-detail'

export interface SideEffectTarget {
  kind: PlanAppSideEffectKind
  className: string
  /** App-relative, as the detail reports it. */
  file: string
}

/** How a file refers to a class: a use, a use this cannot confirm, or a name only. Stronger first. */
type Reference = 'use' | 'unproven' | 'mention'
const REFERENCE_STRENGTH: Record<Reference, number> = { use: 2, unproven: 1, mention: 0 }
const REFERENCE_FIELD = { use: 'usedIn', unproven: 'unprovenIn', mention: 'mentionedIn' } as const

export interface SideEffectUses {
  /** Per target file: the app files that use it, that may use it, and that only name it. */
  byFile: Map<string, Record<(typeof REFERENCE_FIELD)[Reference], string[]>>
  /** App files that did not parse, where a use would go unseen. */
  unparsed: string[]
  /** App files constructing `AutoDiscovery`, whose listeners are registered by no name the source spells. */
  discoversListeners: string[]
}

/** Directories of an app root holding server code; tests, pages, migrations and seeders are not the application. */
const SERVER_DIRS = ['app', 'routes', 'src', 'config']
/** `.spec` too, unlike discovery's test pattern: a Playwright spec beside the code is no more the application. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
/** `@guren/core`, `@guren/server` and their subpaths (`@guren/server/events`). */
const FRAMEWORK_PACKAGE = /^@guren\/(core|server)(\/|$)/

const JOB_STATICS = new Set(['dispatch', 'dispatchAfter'])
const EMITS = new Set(['emit', 'emitParallel'])
const LISTENS_WITH_HANDLER = new Set(['on', 'once'])
const MAIL_SENDS = new Set(['send', 'queue'])
const NOTIFICATION_SENDS = new Set(['send', 'sendNow', 'sendToMany', 'sendNowToMany'])

/** TypeScript nodes wrapping a value, whose `expression` is walked; every other `TS*` node is a type. */
const TS_VALUE_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'TSExportAssignment'])
const TYPE_KEYS = new Set(['typeAnnotation', 'typeParameters', 'typeArguments', 'returnType', 'superTypeParameters', 'implements'])
const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement'])
const INVOKERS = new Set(['call', 'apply'])
const BIND = new Set(['bind'])
/** Members every object and function has: calling one on a listener says nothing of handling an event. */
const INHERITED_MEMBERS = new Set([
  'constructor',
  'toString',
  'toLocaleString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  ...BIND,
  ...INVOKERS,
])

interface Target extends SideEffectTarget {
  /** Absolute path without its extension, which is what an import specifier resolves to. */
  base: string
  /** A mail module declaring no class: the functions it exports, each call of which is a send. */
  sendingFunctions?: Set<string>
}

/** A local binding: the targets it holds an instance of (`const e = new E()`), empty for any other. */
type Scope = Map<string, Target[]>

export async function scanSideEffectUses(root: string, cache: ParseCache, targets: SideEffectTarget[]): Promise<SideEffectUses> {
  if (targets.length === 0) return { byFile: new Map(), unparsed: [], discoversListeners: [] }
  const indexed = await Promise.all(targets.map((target) => indexTarget(root, cache, target)))
  const byFile = new Map(targets.map((target) => [target.file, { usedIn: new Set<string>(), unprovenIn: new Set<string>(), mentionedIn: new Set<string>() }]))
  const unparsed: string[] = []
  const discoversListeners: string[] = []

  for (const filePath of await applicationSources(root)) {
    const file = toPosixRelative(root, filePath)
    const parsed = await cache.get(filePath)
    if (!parsed) {
      unparsed.push(file)
      continue
    }
    const scan = scanFile(root, filePath, parsed.ast, indexed)
    if (scan.discoversListeners) discoversListeners.push(file)
    for (const [target, kind] of scan.found) {
      if (target.file === file) continue
      byFile.get(target.file)![REFERENCE_FIELD[kind]].add(file)
    }
  }

  return {
    byFile: new Map([...byFile].map(([file, found]) => [file, { usedIn: [...found.usedIn], unprovenIn: [...found.unprovenIn], mentionedIn: [...found.mentionedIn] }])),
    unparsed,
    discoversListeners,
  }
}

async function indexTarget(root: string, cache: ParseCache, target: SideEffectTarget): Promise<Target> {
  const absolute = resolve(root, target.file)
  const indexed: Target = { ...target, base: withoutExtension(absolute) }
  if (target.kind !== 'mail') return indexed
  const parsed = await cache.get(absolute)
  return parsed && !declaresClass(parsed.ast, target.className) ? { ...indexed, sendingFunctions: exportedFunctions(parsed.ast) } : indexed
}

function declaresClass(ast: File, className: string): boolean {
  return ast.program.body.some((node) => {
    const declaration = extractClassDeclaration(node)
    return declaration !== null && (declaration.id?.name === className || node.type === 'ExportDefaultDeclaration')
  })
}

function exportedFunctions(ast: File): Set<string> {
  const names = new Set<string>()
  for (const node of ast.program.body) {
    if (node.type !== 'ExportNamedDeclaration' || node.source) continue
    if (node.declaration?.type === 'FunctionDeclaration' && node.declaration.id) names.add(node.declaration.id.name)
    for (const declarator of topLevelDeclaration(node)?.declarations ?? []) {
      const init = declarator.init ? unwrapTypeAssertion(declarator.init) : undefined
      if (declarator.id.type === 'Identifier' && (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression')) names.add(declarator.id.name)
    }
  }
  return names
}

/** Every server source file of every app root: its `app/`, `routes/`, `src/`, `config/` and top-level files. */
async function applicationSources(root: string): Promise<string[]> {
  const roots = await listAppRoots(root)
  const groups = await Promise.all(
    roots.flatMap((appRoot) => [
      ...SERVER_DIRS.map((dir) => collectFiles(resolve(appRoot.dir, dir), IMPORTABLE_EXTENSIONS)),
      topLevelSources(appRoot.dir),
    ]),
  )
  return groups.flat().filter((file) => !TEST_FILE.test(file))
}

async function topLevelSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !entry.name.endsWith('.d.ts') && IMPORTABLE_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => join(dir, entry.name))
}

/** A function of any form, methods included: the node that opens a scope of its own. A signature has no body. */
function isFunction(node: BabelNode): boolean {
  return Array.isArray(node.params) && node.body != null
}

function memberName(node: BabelNode): string | undefined {
  const property = node.property as BabelNode
  if (!node.computed && property.type === 'Identifier') return property.name as string
  if (node.computed && property.type === 'StringLiteral') return property.value as string
  return undefined
}

/** The patterns a destructuring pattern holds directly; an `AssignmentPattern` is its caller's to split. */
function nestedPatterns(pattern: BabelNode): Array<BabelNode | null> {
  switch (pattern.type) {
    case 'RestElement':
      return [pattern.argument as BabelNode]
    case 'TSParameterProperty':
      return [pattern.parameter as BabelNode]
    case 'ArrayPattern':
      return pattern.elements as Array<BabelNode | null>
    case 'ObjectPattern':
      return (pattern.properties as BabelNode[]).map((property) => (property.type === 'RestElement' ? property : property.value) as BabelNode)
    default:
      return []
  }
}

function isMember(node: BabelNode): boolean {
  return node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression'
}

/** Names an assignment, an update or a `for (x of …)` head anywhere in the file writes to, destructured ones included. */
function assignedNames(ast: File): Set<string> {
  const names = new Set<string>()
  const collect = (target: BabelNode | null | undefined): void => {
    if (!target) return
    const pattern = unwrapTypeAssertion(target)
    if (pattern.type === 'Identifier') names.add(pattern.name as string)
    else if (pattern.type === 'AssignmentPattern') collect(pattern.left as BabelNode)
    else nestedPatterns(pattern).forEach(collect)
  }
  walk(ast.program, (node) => {
    if (node.type === 'AssignmentExpression') collect(node.left as BabelNode)
    else if (node.type === 'UpdateExpression') collect(node.argument as BabelNode)
    else if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
      const head = node.left as BabelNode
      // A `var` in a loop head assigns the function's binding on every turn; `let` / `const` bind afresh.
      if (head.type !== 'VariableDeclaration') collect(head)
      else if (head.kind === 'var') (head.declarations as BabelNode[]).forEach((declarator) => collect(declarator.id as BabelNode))
    }
  })
  return names
}

function sameTargets(left: Target[], right: Target[]): boolean {
  return left.length === right.length && left.every((target) => right.includes(target))
}

/** A barrel re-exports its directory's modules, so an import of the directory (or its index) reaches the file. */
function reaches(target: Target, base: string): boolean {
  const dir = dirname(target.base)
  return base === target.base || base === dir || base === join(dir, 'index')
}

/** The statements a block-like node holds, for the lexical bindings it opens. */
function blockStatements(node: BabelNode): BabelNode[] {
  if (node.type === 'SwitchStatement') return (node.cases as BabelNode[]).flatMap((entry) => entry.consequent as BabelNode[])
  if (LOOPS.has(node.type)) {
    const head = (node.init ?? node.left) as BabelNode | null | undefined
    return head?.type === 'VariableDeclaration' ? [head] : []
  }
  return node.body as BabelNode[]
}

/**
 * Inside the handler of an `on()` / `once()` call, what constructing or calling a listener
 * there counts as: a use when the event is an event class, unconfirmed when it is anything
 * else (a string event name, and equally a route or a process hook).
 */
type Registering = false | Exclude<Reference, 'mention'>

/** How one file refers to each target; the strongest reference wins. */
function scanFile(root: string, filePath: string, ast: File, targets: Target[]): { found: Map<Target, Reference>; discoversListeners: boolean } {
  const imports = importsByLocal(ast.program.body)
  const reassigned = assignedNames(ast)
  const found = new Map<Target, Reference>()
  let discoversListeners = false
  const note = (hits: Target[], kind: Reference): void => {
    for (const target of hits) {
      const current = found.get(target)
      if (current === undefined || REFERENCE_STRENGTH[kind] > REFERENCE_STRENGTH[current]) found.set(target, kind)
    }
  }
  const ofKind = (hits: Target[], kind: PlanAppSideEffectKind): Target[] => hits.filter((target) => target.kind === kind)

  const lookup = (name: string, scopes: Scope[]): Target[] | undefined => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const bound = scopes[index]!.get(name)
      if (bound) return bound
    }
    return undefined
  }

  /** The import a bare identifier names, unless a local binding shadows it. */
  const importOf = (node: BabelNode, scopes: Scope[]): ImportEntry | undefined =>
    node.type === 'Identifier' && !lookup(node.name as string, scopes) ? imports.get(node.name as string) : undefined

  /** The namespace import a member expression reads off (`Events.PostCreated`). */
  const namespaceOf = (member: BabelNode, scopes: Scope[]): ImportEntry | undefined => {
    const entry = importOf(unwrapTypeAssertion(member.object as BabelNode), scopes)
    return entry?.kind === 'namespace' ? entry : undefined
  }

  const importBase = (entry: ImportEntry): string | null => {
    const base = specifierBase(root, filePath, entry.source)
    return base === null ? null : withoutExtension(base)
  }

  /** The classes an expression names: an imported class, or a class off a namespace import. */
  const classesNamed = (node: BabelNode, scopes: Scope[]): Target[] => {
    const value = unwrapTypeAssertion(node)
    if (value.type === 'Identifier') {
      const entry = importOf(value, scopes)
      const base = entry && entry.kind !== 'namespace' ? importBase(entry) : null
      if (!entry || base === null) return []
      if (entry.kind === 'default') return targets.filter((target) => base === target.base)
      return targets.filter((target) => entry.imported === target.className && reaches(target, base))
    }
    if (isMember(value)) {
      const entry = namespaceOf(value, scopes)
      const base = entry ? importBase(entry) : null
      const name = memberName(value)
      if (base === null || name === undefined) return []
      return targets.filter((target) => target.className === name && reaches(target, base))
    }
    return []
  }

  /** What a binding holds; nothing for a name the file assigns to, since which value is current the order cannot say. */
  const heldBy = (name: string, scopes: Scope[]): Target[] => (reassigned.has(name) ? [] : (lookup(name, scopes) ?? []))

  /** The classes an expression holds an instance of: `new C()` itself, or a binding initialised with one. */
  const instancesOf = (node: BabelNode | undefined, scopes: Scope[]): Target[] => {
    if (!node) return []
    const value = unwrapTypeAssertion(node)
    if (value.type === 'NewExpression') return classesNamed(value.callee as BabelNode, scopes)
    if (value.type === 'Identifier') return heldBy(value.name as string, scopes)
    return []
  }

  /** A mail module's exported function, called by the name it is imported under. */
  const sendingFunction = (callee: BabelNode, scopes: Scope[]): Target[] => {
    const entry = importOf(unwrapTypeAssertion(callee), scopes)
    const base = entry?.kind === 'named' ? importBase(entry) : null
    if (!entry || base === null) return []
    return targets.filter((target) => target.sendingFunctions?.has(entry.imported) && reaches(target, base))
  }

  /**
   * The class or instance whose own member a call runs, stepping through a `call` / `apply`, or
   * through a `bind` where the bound function is itself the handler (`steps`). None for a member
   * every object has, a computed one (a string literal aside), or a member of a property
   * (`L.name.toUpperCase()`), which reads the class without running it.
   */
  const calledOn = (callee: BabelNode, scopes: Scope[], steps: ReadonlySet<string> = INVOKERS): Target[] => {
    let object = unwrapTypeAssertion(callee.object as BabelNode)
    let member = memberName(callee)
    if (member !== undefined && steps.has(member) && isMember(object) && classesNamed(object, scopes).length === 0) {
      member = memberName(object)
      object = unwrapTypeAssertion(object.object as BabelNode)
    }
    if (member === undefined || INHERITED_MEMBERS.has(member)) return []
    if (object.type === 'Identifier' && lookup(object.name as string, scopes)) return heldBy(object.name as string, scopes)
    return classesNamed(object, scopes)
  }

  /** The member a `bind` call binds (`listener.handle.bind(listener)`), which runs once the bound function is handed over as a handler or called. */
  const boundHandler = (handler: BabelNode | undefined, scopes: Scope[]): Target[] => {
    if (!handler) return []
    const value = unwrapTypeAssertion(handler)
    if (value.type !== 'CallExpression' && value.type !== 'OptionalCallExpression') return []
    const callee = unwrapTypeAssertion(value.callee as BabelNode)
    return isMember(callee) ? calledOn(callee, scopes, BIND) : []
  }

  /** An app event class, or a class the framework exports (`UserAuthenticated`), as `events.on()` takes one. */
  const namesAnEventClass = (node: BabelNode | undefined, scopes: Scope[]): boolean => {
    if (!node) return false
    if (classesNamed(node, scopes).some((target) => target.kind === 'event')) return true
    const value = unwrapTypeAssertion(node)
    const entry = isMember(value) ? namespaceOf(value, scopes) : importOf(value, scopes)
    return entry !== undefined && FRAMEWORK_PACKAGE.test(entry.source)
  }

  const uses = (call: BabelNode, scopes: Scope[]): Target[] => {
    const callee = unwrapTypeAssertion(call.callee as BabelNode)
    const args = call.arguments as BabelNode[]
    const hits = sendingFunction(callee, scopes)
    if (!isMember(callee)) return hits
    const method = memberName(callee)
    if (method === undefined) return hits
    const subject = callee.object as BabelNode
    if (JOB_STATICS.has(method)) hits.push(...ofKind(classesNamed(subject, scopes), 'job'))
    if ((method === 'dispatch' || method === 'job') && args[0]) hits.push(...ofKind(classesNamed(args[0], scopes), 'job'))
    if (EMITS.has(method)) hits.push(...ofKind(instancesOf(args[0], scopes), 'event'))
    if (method === 'listen' && args[0]) hits.push(...ofKind(classesNamed(args[0], scopes), 'listener'))
    if (MAIL_SENDS.has(method)) hits.push(...ofKind(instancesOf(chainRoot(subject), scopes), 'mail'))
    if (NOTIFICATION_SENDS.has(method)) hits.push(...ofKind(instancesOf(args[1], scopes), 'notification'))
    return hits
  }

  /** `holds` reaches the name a pattern binds directly; a default of `new C()` holds `C`. */
  const bindName = (scope: Scope, pattern: BabelNode | null | undefined, scopes: Scope[], holds: Target[] = []): void => {
    if (!pattern) return
    if (pattern.type === 'Identifier') scope.set(pattern.name as string, holds)
    else if (pattern.type === 'AssignmentPattern') bindName(scope, pattern.left as BabelNode, scopes, instancesOf(pattern.right as BabelNode, scopes))
    else for (const nested of nestedPatterns(pattern)) bindName(scope, nested, scopes)
  }

  const bindDeclaration = (scope: Scope, declaration: BabelNode, scopes: Scope[]): void => {
    for (const declarator of declaration.declarations as BabelNode[]) {
      bindName(scope, declarator.id as BabelNode, scopes, instancesOf(declarator.init as BabelNode | undefined, scopes))
    }
  }

  /** `let`, `const`, `class` and `function` a block declares directly, as ES modules scope them. */
  const lexicalScope = (statements: BabelNode[], outer: Scope[], scope: Scope = new Map()): Scope => {
    const scopes = [...outer, scope]
    for (const statement of statements) {
      const node = statement.type.startsWith('Export') && statement.declaration ? (statement.declaration as BabelNode) : statement
      if (node.type === 'VariableDeclaration' && node.kind !== 'var') bindDeclaration(scope, node, scopes)
      else if ((node.type === 'ClassDeclaration' || node.type === 'FunctionDeclaration') && node.id) bindName(scope, node.id as BabelNode, scopes)
    }
    return scope
  }

  /** A function's scope: its parameters, every `var` in its body outside nested functions, and its body's lexical bindings. `body` is a block's statements, or an arrow's expression. */
  const functionScope = (body: BabelNode | BabelNode[], params: BabelNode[], outer: Scope[]): Scope => {
    const scope: Scope = new Map()
    const scopes = [...outer, scope]
    for (const param of params) bindName(scope, param, scopes)
    // A parameter defaulted to an instance is as much an initialisation as a `var`'s.
    const initialised = new Set([...scope].filter(([, holds]) => holds.length > 0).map(([name]) => name))
    const hoist = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(hoist)
      if (node === null || typeof node !== 'object' || typeof (node as BabelNode).type !== 'string') return
      const current = node as BabelNode
      if (isFunction(current) || current.type === 'ClassDeclaration' || current.type === 'ClassExpression' || current.type === 'ImportDeclaration') return
      if (current.type === 'VariableDeclaration' && current.kind === 'var') {
        // Initialised twice, a `var` holds whichever ran last, which the source order cannot say.
        for (const declarator of current.declarations as BabelNode[]) {
          const declared: Scope = new Map()
          bindName(declared, declarator.id as BabelNode, [...scopes, declared], instancesOf(declarator.init as BabelNode | undefined, scopes))
          for (const [name, holds] of declared) {
            if (declarator.init) {
              const previous = initialised.has(name) ? scope.get(name) : undefined
              scope.set(name, previous && !sameTargets(previous, holds) ? [] : holds)
              initialised.add(name)
            } else if (!scope.has(name)) scope.set(name, holds)
          }
        }
      }
      for (const key in current) if (key !== 'loc' && !key.endsWith('Comments')) hoist(current[key])
    }
    hoist(body)
    return lexicalScope(Array.isArray(body) ? body : [], outer, scope)
  }

  const visit = (value: unknown, scopes: Scope[], registering: Registering): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, scopes, registering)
      return
    }
    if (value === null || typeof value !== 'object' || typeof (value as BabelNode).type !== 'string') return
    const node = value as BabelNode
    const type = node.type

    if (type === 'ImportDeclaration' || type === 'ExportAllDeclaration' || (type === 'ExportNamedDeclaration' && node.source)) return
    if (type.startsWith('TS') && type !== 'TSParameterProperty') {
      if (TS_VALUE_WRAPPERS.has(type)) visit(node.expression, scopes, registering)
      return
    }

    if (isFunction(node)) {
      const params = node.params as BabelNode[]
      const body = node.body as BabelNode
      const contents = body.type === 'BlockStatement' ? (body.body as BabelNode[]) : body
      const inner = [...scopes, functionScope(contents, params, scopes)]
      if (node.computed) visit(node.key, scopes, registering)
      for (const param of params) visitPatternValues(param, inner, registering)
      visit(contents, inner, registering)
      return
    }
    if (type === 'StaticBlock') {
      visit(node.body, [...scopes, functionScope(node.body as BabelNode[], [], scopes)], registering)
      return
    }
    if (type === 'SwitchStatement') {
      visit(node.discriminant, scopes, registering)
      visit(node.cases, [...scopes, lexicalScope(blockStatements(node), scopes)], registering)
      return
    }
    if (type === 'BlockStatement' || LOOPS.has(type)) {
      visitChildren(node, [...scopes, lexicalScope(blockStatements(node), scopes)], registering)
      return
    }
    if (type === 'CatchClause') {
      const scope: Scope = new Map()
      bindName(scope, node.param as BabelNode, scopes)
      visit(node.body, [...scopes, scope], registering)
      return
    }

    if (type === 'Identifier') {
      if (!lookup(node.name as string, scopes)) note([...classesNamed(node, scopes), ...sendingFunction(node, scopes)], 'mention')
      return
    }

    if (type === 'NewExpression') {
      const entry = importOf(unwrapTypeAssertion(node.callee as BabelNode), scopes)
      if (entry?.imported === 'AutoDiscovery' && FRAMEWORK_PACKAGE.test(entry.source)) discoversListeners = true
      if (registering) note(ofKind(classesNamed(node.callee as BabelNode, scopes), 'listener'), registering)
    }

    if (type === 'CallExpression' || type === 'OptionalCallExpression') {
      note(uses(node, scopes), 'use')
      const callee = unwrapTypeAssertion(node.callee as BabelNode)
      const method = isMember(callee) ? memberName(callee) : undefined
      const args = node.arguments as BabelNode[]
      if (registering) {
        const hits = isMember(callee) ? calledOn(callee, scopes) : boundHandler(callee, scopes)
        note(ofKind(hits, 'listener'), registering)
      }
      visit(node.callee, scopes, registering)
      if (method !== undefined && LISTENS_WITH_HANDLER.has(method)) {
        visit(args[0], scopes, registering)
        // `events.on(event, listener, options)` registers only its listener; any other `on()` is read whole.
        const kind = namesAnEventClass(args[0], scopes) ? 'use' : 'unproven'
        note(ofKind(boundHandler(args[1], scopes), 'listener'), kind)
        visit(args[1], scopes, kind)
        visit(args.slice(2), scopes, kind === 'use' ? registering : kind)
      } else visit(args, scopes, registering)
      return
    }

    if (isMember(node)) {
      const namespaced = classesNamed(node, scopes)
      if (namespaced.length > 0) {
        note(namespaced, 'mention')
        return
      }
      visit(node.object, scopes, registering)
      if (node.computed) visit(node.property, scopes, registering)
      return
    }

    if (type === 'VariableDeclarator') {
      visitPatternValues(node.id as BabelNode, scopes, registering)
      visit(node.init, scopes, registering)
      return
    }
    if (type === 'ObjectProperty' || type === 'ClassProperty' || type === 'ClassAccessorProperty') {
      if (node.computed) visit(node.key, scopes, registering)
      visit(node.value, scopes, registering)
      return
    }
    if (type === 'ClassDeclaration' || type === 'ClassExpression') {
      visit(node.superClass, scopes, registering)
      visit(node.decorators, scopes, registering)
      visit(node.body, scopes, registering)
      return
    }
    if (type === 'LabeledStatement') return visit(node.body, scopes, registering)
    if (type === 'BreakStatement' || type === 'ContinueStatement' || type === 'MetaProperty') return

    visitChildren(node, scopes, registering)
  }

  const visitChildren = (node: BabelNode, scopes: Scope[], registering: Registering): void => {
    for (const key in node) if (key !== 'loc' && !key.endsWith('Comments') && !TYPE_KEYS.has(key)) visit(node[key], scopes, registering)
  }

  /** A binding pattern names nothing; only its default values and computed keys are read. */
  const visitPatternValues = (pattern: BabelNode | null | undefined, scopes: Scope[], registering: Registering): void => {
    if (!pattern) return
    if (pattern.type === 'AssignmentPattern') {
      visitPatternValues(pattern.left as BabelNode, scopes, registering)
      visit(pattern.right, scopes, registering)
      return
    }
    if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties as BabelNode[]) if (property.computed) visit(property.key, scopes, registering)
    }
    for (const nested of nestedPatterns(pattern)) visitPatternValues(nested, scopes, registering)
  }

  const body = ast.program.body as unknown as BabelNode[]
  visit(body, [functionScope(body, [], [])], false)
  return { found, discoversListeners }
}

/** The expression a builder chain starts from: `new M(manager).to(x).subject(y)` → `new M(manager)`. */
function chainRoot(node: BabelNode): BabelNode {
  let current = unwrapTypeAssertion(node)
  while (current.type === 'CallExpression' || current.type === 'OptionalCallExpression') {
    const callee = unwrapTypeAssertion(current.callee as BabelNode)
    if (!isMember(callee)) break
    current = unwrapTypeAssertion(callee.object as BabelNode)
  }
  return current
}
