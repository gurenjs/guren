/**
 * The in-process agents an app declares (RFC 0029 §8): `Agent` subclasses from
 * `@guren/plugin-ai`, read as source. `guren check` judges their `appTools()`
 * names and scopes, `guren audit` lists their local tools. Content-activated:
 * a file naming neither the package nor a class found under it is not parsed.
 * A superclass is resolved through the file's *imports*, never by its spelling:
 * a same-named class from another package is a different class, and RFC 0017's
 * durable `Agent` is a different one again.
 */
import { resolve } from 'node:path'
import type { BlockStatement, CallExpression, ClassDeclaration, Expression, Node, ReturnStatement } from '@babel/types'
import { literalString, memberKeyName, objectLiteral, propertyValue, unwrapTypeAssertion, walk } from './ast-walk'
import { blankCommentsAndStrings, classActionMembers } from './controller-methods'
import { discoverAppSourceFiles, toPosixRelative } from './discovery'
import { extractClassDeclaration, stringArrayEntries } from './model-parser'
import type { ParseCache, ParsedFile } from './parse-cache'
import { importedLocals, importedNamespaces, type PluginExport } from './plugin-calls'
import { importsByLocal, specifierBase } from './schema-binding'
import { escapeRegExp } from './utils'

export const AI_PLUGIN_SPECIFIER = '@guren/plugin-ai'
export const AI_PLUGIN_EXPORT: PluginExport = { specifier: AI_PLUGIN_SPECIFIER, exportName: 'aiPlugin' }
const AGENT_EXPORT: PluginExport = { specifier: AI_PLUGIN_SPECIFIER, exportName: 'Agent' }
/** The methods on `Agent`, and the functions the package exports taking the agent first. */
const APP_TOOLS_NAMES = ['appTools', 'appToolDefinitions'] as const
/**
 * Bodies that rebind `this` or own their `return`. Arrow functions are absent
 * on purpose: they keep the enclosing `this`, so a call inside one is the
 * agent's. A nested object method's `this.appTools(...)` is that object's.
 */
const NESTED_SCOPE_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ClassDeclaration',
  'ClassExpression',
  'ObjectMethod',
])

/** One `appTools([...])` / `appToolDefinitions([...])` call. */
export interface AppToolsCall {
  line: number
  names: string[]
  /** Why the names could not all be read; `names` is then partial and must not be judged as complete. */
  unreadable?: string
}

export interface LocalTool {
  name: string
  line: number
  /** The `execute` body with comments and strings blanked; absent when it could not be located. */
  executeBody?: string
}

export interface ScannedAgent {
  /** `<file without extension>#<class>`: one declaration, which two files may share a class name for. */
  key: string
  className: string
  relPath: string
  line: number
  /** The key of the scanned agent it extends, or `null` when it extends `Agent` itself. */
  parent: string | null
  /** Own `static scopes`: `undefined` when not declared, `null` when declared but unreadable. */
  ownScopes: string[] | null | undefined
  /** Own `appTools()` calls, anywhere in the class body. */
  appToolsCalls: AppToolsCall[]
  /** Whether the class declares its own `tools()`, which replaces an inherited one. */
  declaresTools: boolean
  /** Whether that override still runs the inherited one (`super.tools()`), whose calls then use this class's scopes. */
  delegatesToSuper: boolean
  /** Entries `tools()` returns that are not `appTools()` spreads. */
  localTools: LocalTool[]
  /** Why `tools()` could not be enumerated whole. */
  localToolsUnreadable?: string
}

/**
 * The first answer up the `extends` chain, as the runtime resolves an inherited
 * static. Guarded against a cycle, which a hand-edited file can spell.
 */
function inherited<T>(
  agent: ScannedAgent,
  byKey: ReadonlyMap<string, ScannedAgent>,
  read: (agent: ScannedAgent) => T | undefined,
): T | undefined {
  const seen = new Set<string>()
  let current: ScannedAgent | undefined = agent
  while (current && !seen.has(current.key)) {
    const answer = read(current)
    if (answer !== undefined) return answer
    seen.add(current.key)
    current = current.parent ? byKey.get(current.parent) : undefined
  }
  return undefined
}

/** Scopes as the runtime reads them: own, else inherited, else `[]`. `null` when unreadable. */
export function effectiveScopes(agent: ScannedAgent, byKey: ReadonlyMap<string, ScannedAgent>): string[] | null {
  // `?? []` would read an unreadable `scopes` (null) as "grants nothing", which
  // is a verdict; undefined is the only "nobody declared any".
  const declared = inherited(agent, byKey, (current) => current.ownScopes)
  return declared === undefined ? [] : declared
}

/**
 * The `appTools()` calls that run for this class, judged against *its* scopes:
 * its own, plus the inherited ones when it declares no `tools()` of its own or
 * its override calls `super.tools()`.
 */
export function effectiveAppToolsCalls(
  agent: ScannedAgent,
  byKey: ReadonlyMap<string, ScannedAgent>,
  seen: Set<string> = new Set(),
): AppToolsCall[] {
  if (seen.has(agent.key)) return []
  seen.add(agent.key)

  const parent = agent.parent ? byKey.get(agent.parent) : undefined
  const inheritedCalls = parent ? effectiveAppToolsCalls(parent, byKey, seen) : []
  const overrides = agent.declaresTools || agent.appToolsCalls.length > 0
  if (!overrides) return inheritedCalls
  return agent.delegatesToSuper ? [...agent.appToolsCalls, ...inheritedCalls] : agent.appToolsCalls
}

export async function scanAiAgents(cwd: string, cache: ParseCache): Promise<ScannedAgent[]> {
  const files = await discoverAppSourceFiles(cwd)
  const agents = new Map<string, ScannedAgent>()

  // A file joins when it names the package or any class found so far — the
  // name rather than `extends <name>`, since a parent may be imported under an
  // alias. Repeated until a pass finds nothing new, so a chain resolves.
  let grew = true
  while (grew) {
    grew = false
    const names = [...new Set([...agents.values()].map((agent) => agent.className))]
    const namesKnown = names.length > 0 ? new RegExp(`\\b(?:${names.map(escapeRegExp).join('|')})\\b`) : null
    for (const filePath of files) {
      const source = await cache.source(filePath)
      if (!source) continue
      if (!source.includes(AI_PLUGIN_SPECIFIER) && !namesKnown?.test(source)) continue
      const parsed = await cache.get(filePath)
      if (!parsed) continue
      for (const agent of agentsIn({ cwd, filePath, parsed, known: agents })) {
        if (agents.has(agent.key)) continue
        agents.set(agent.key, agent)
        grew = true
      }
    }
  }

  return [...agents.values()]
}

/** A declaration's key: the file without its extension, then the class name. */
function agentKey(moduleName: string, className: string): string {
  return `${moduleName}#${className}`
}

function moduleNameOf(relPath: string): string {
  return relPath.replace(/\.[cm]?[jt]sx?$/u, '')
}

function agentsIn(input: {
  cwd: string
  filePath: string
  parsed: ParsedFile
  known: ReadonlyMap<string, ScannedAgent>
}): ScannedAgent[] {
  const { cwd, filePath, parsed, known } = input
  const { source, ast } = parsed
  const agentLocals = importedLocals(ast, AGENT_EXPORT)
  const namespaces = importedNamespaces(ast, AI_PLUGIN_SPECIFIER)
  const helperLocals = new Set(
    APP_TOOLS_NAMES.flatMap((exportName) => [...importedLocals(ast, { specifier: AI_PLUGIN_SPECIFIER, exportName })]),
  )
  const scrubbed = blankCommentsAndStrings(source, ast)
  const relPath = toPosixRelative(cwd, filePath)
  const moduleName = moduleNameOf(relPath)
  const imports = importsByLocal(ast.program.body)
  const found: ScannedAgent[] = []

  for (const statement of ast.program.body) {
    const classDecl = extractClassDeclaration(statement)
    if (!classDecl?.id || !classDecl.superClass) continue

    const direct = extendsExport(classDecl.superClass, agentLocals, namespaces, 'Agent')
    const parent = direct
      ? null
      : resolveParent(classDecl.superClass, { cwd, filePath, moduleName, imports, known })
    if (!direct && parent === undefined) continue

    const tools = toolsMember(classDecl)
    const local = tools ? readLocalTools(tools, scrubbed, helperLocals, namespaces) : { tools: [] }
    found.push({
      key: agentKey(moduleName, classDecl.id.name),
      className: classDecl.id.name,
      relPath,
      line: classDecl.loc?.start.line ?? 1,
      parent: parent ?? null,
      ownScopes: readScopes(classDecl),
      appToolsCalls: readAppToolsCalls(classDecl, helperLocals, namespaces),
      declaresTools: tools !== undefined,
      delegatesToSuper: tools !== undefined && callsSuper(tools),
      localTools: local.tools,
      ...(local.unreadable ? { localToolsUnreadable: local.unreadable } : {}),
    })
  }
  return found
}

/** `extends Agent` / `extends Base` under a named import, or `extends ai.Agent` under a namespace one. */
function extendsExport(
  superClass: Node,
  locals: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
  exportName: string,
): boolean {
  if (superClass.type === 'Identifier') return locals.has(superClass.name)
  return (
    superClass.type === 'MemberExpression'
    && !superClass.computed
    && superClass.object.type === 'Identifier'
    && namespaces.has(superClass.object.name)
    && superClass.property.type === 'Identifier'
    && superClass.property.name === exportName
  )
}

/**
 * The scanned agent a superclass identifier names, resolved through the file's
 * imports: a local class of the same name, or the export an import brings in
 * from the file that declares it. `undefined` when it names none.
 */
function resolveParent(
  superClass: Node,
  context: {
    cwd: string
    filePath: string
    moduleName: string
    imports: ReturnType<typeof importsByLocal>
    known: ReadonlyMap<string, ScannedAgent>
  },
): string | undefined {
  if (superClass.type !== 'Identifier') return undefined
  const { cwd, filePath, moduleName, imports, known } = context

  const entry = imports.get(superClass.name)
  if (!entry) {
    const local = agentKey(moduleName, superClass.name)
    return known.has(local) ? local : undefined
  }

  // A bare package specifier resolves to no file of this app, so it names no scanned class.
  const base = specifierBase(cwd, resolve(cwd, filePath), entry.source)
  if (base === null) return undefined
  const target = moduleNameOf(toPosixRelative(cwd, base))
  return [agentKey(target, entry.imported), agentKey(`${target}/index`, entry.imported)].find((key) => known.has(key))
}

/**
 * `static scopes`, under any non-computed spelling. A getter or method answers
 * `null` rather than "absent": its value is not readable here, and reading it
 * as absent would report every name it grants as ungranted.
 */
function readScopes(classDecl: ClassDeclaration): string[] | null | undefined {
  let computedStatic = false
  for (const member of classDecl.body.body) {
    if (!('static' in member) || !member.static || !('key' in member)) continue
    const name = memberKeyName(member as never)
    if (name === undefined) {
      computedStatic = true
      continue
    }
    if (name !== 'scopes') continue
    // A member with no value node holds its list in code (a getter, a method),
    // where this scan cannot read it: unreadable, never "grants nothing".
    return 'value' in member ? stringArrayEntries(member.value) ?? null : null
  }
  // A computed static key may be the `scopes` this scan cannot see.
  return computedStatic ? null : undefined
}

/**
 * The names argument of an `appTools()` call the *agent* makes: `this.appTools(names)`
 * (a literal computed key included), or the exported helper with `this` as its
 * first argument — `appTools(otherAgent, ...)` selects against that agent's scopes.
 */
function appToolsArgument(
  call: CallExpression,
  helperLocals: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): Node | undefined {
  const { callee } = call
  if (callee.type === 'MemberExpression') {
    const name = callee.computed
      ? literalString(callee.property)
      : callee.property.type === 'Identifier' ? callee.property.name : null
    if (name === null || !(APP_TOOLS_NAMES as readonly string[]).includes(name)) return undefined
    if (callee.object.type === 'ThisExpression') return (call.arguments[0] ?? null) as Node
    // `ai.appTools(this, names)` under a namespace import of the package.
    if (callee.object.type === 'Identifier' && namespaces.has(callee.object.name)) {
      return call.arguments[0]?.type === 'ThisExpression' ? ((call.arguments[1] ?? null) as Node) : undefined
    }
    return undefined
  }
  if (callee.type === 'Identifier' && helperLocals.has(callee.name)) {
    return call.arguments[0]?.type === 'ThisExpression' ? ((call.arguments[1] ?? null) as Node) : undefined
  }
  return undefined
}

function readAppToolsCalls(
  classDecl: ClassDeclaration,
  helperLocals: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): AppToolsCall[] {
  const calls: AppToolsCall[] = []
  walk(classDecl.body, (node) => {
    // A nested function or object method carries its own `this`, so a call
    // inside one is not this agent's.
    if (NESTED_SCOPE_TYPES.has(node.type)) return false
    if (node.type !== 'CallExpression') return undefined
    const argument = appToolsArgument(node as unknown as CallExpression, helperLocals, namespaces)
    if (argument === undefined) return undefined
    calls.push({ line: node.loc?.start.line ?? 1, ...readNames(argument) })
    return undefined
  })
  return calls
}

function readNames(argument: Node | null): { names: string[]; unreadable?: string } {
  const array = argument ? unwrapTypeAssertion(argument) : null
  if (array?.type !== 'ArrayExpression') return { names: [], unreadable: 'the argument is not an array literal' }
  const names: string[] = []
  for (const element of array.elements) {
    if (element?.type === 'SpreadElement') return { names, unreadable: 'the array contains a spread' }
    const name = literalString(element)
    if (name === null) return { names, unreadable: 'the array contains a computed name' }
    names.push(name)
  }
  return { names }
}

function toolsMember(classDecl: ClassDeclaration): BlockStatement | Expression | undefined {
  for (const { member, name, body } of classActionMembers(classDecl)) {
    if (name === 'tools' && !member.static) return body
  }
  return undefined
}

/** `super.tools()` in an override: the inherited calls still run, under this class's scopes. */
function callsSuper(body: BlockStatement | Expression): boolean {
  let found = false
  walk(body, (node) => {
    if (found) return false
    if (node.type === 'MemberExpression' && (node.object as Node | undefined)?.type === 'Super') found = true
    return undefined
  })
  return found
}

/**
 * The object `tools()` returns: its one `return` anywhere in the body (a
 * conditional branch included, which is why the top-level statements are not
 * enough), or an expression body. Nested functions carry their own returns and
 * are skipped.
 */
function returnedExpression(body: BlockStatement | Expression): { value?: Node; reason?: string } {
  if (body.type !== 'BlockStatement') return { value: body }

  const returns: Array<Node | null | undefined> = []
  walk(body, (node) => {
    if (NESTED_SCOPE_TYPES.has(node.type) || node.type === 'ArrowFunctionExpression') return false
    if (node.type === 'ReturnStatement') returns.push((node as unknown as ReturnStatement).argument)
    return undefined
  })

  if (returns.length !== 1) {
    return { reason: returns.length === 0 ? 'tools() has no return this scan can read' : 'tools() returns from more than one place' }
  }
  const argument = returns[0]
  return argument ? { value: argument } : { reason: 'tools() returns nothing' }
}

function readLocalTools(
  body: BlockStatement | Expression,
  scrubbed: string,
  helperLocals: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): { tools: LocalTool[]; unreadable?: string } {
  const returned = returnedExpression(body)
  if (!returned.value) return { tools: [], unreadable: returned.reason }
  const value = unwrapTypeAssertion(returned.value)
  if (value.type === 'CallExpression' && appToolsArgument(value, helperLocals, namespaces) !== undefined) {
    return { tools: [] }
  }

  const object = objectLiteral(value)
  if (!object) return { tools: [], unreadable: 'tools() does not return an object literal' }

  const tools: LocalTool[] = []
  let unreadable: string | undefined
  for (const property of object.properties) {
    if (property.type === 'SpreadElement') {
      const spread = unwrapTypeAssertion(property.argument)
      const isAppTools = spread.type === 'CallExpression'
        && appToolsArgument(spread, helperLocals, namespaces) !== undefined
      // `...super.tools()` carries the parent's own local tools, listed there.
      const isSuperTools = spread.type === 'CallExpression' && callsSuper(spread)
      if (!isAppTools && !isSuperTools) unreadable ??= 'tools() spreads something other than appTools()'
      continue
    }
    const name = memberKeyName(property)
    if (name === undefined) {
      unreadable ??= 'tools() returns a computed key'
      continue
    }
    const line = property.loc?.start.line ?? 1
    const execute = property.type === 'ObjectProperty' ? executeBody(property.value as Node) : undefined
    tools.push({
      name,
      line,
      ...(execute ? { executeBody: scrubbed.slice(execute.start ?? 0, execute.end ?? 0) } : {}),
    })
  }
  return { tools, ...(unreadable ? { unreadable } : {}) }
}

/** `tool({ execute })`'s function body, whatever the factory is called. */
function executeBody(value: Node): Node | undefined {
  const call = unwrapTypeAssertion(value)
  if (call.type !== 'CallExpression') return undefined
  const options = objectLiteral(call.arguments[0] as Node)
  if (!options) return undefined
  for (const property of options.properties) {
    if (property.type === 'ObjectMethod' && memberKeyName(property) === 'execute') return property.body
  }
  const execute = propertyValue(options, 'execute')
  const fn = execute ? unwrapTypeAssertion(execute) : undefined
  if (fn?.type === 'ArrowFunctionExpression' || fn?.type === 'FunctionExpression') return fn.body
  return undefined
}
