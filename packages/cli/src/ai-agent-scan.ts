/**
 * The in-process agents an app declares (RFC 0029 §8): `Agent` subclasses from
 * `@guren/plugin-ai`, read as source. `guren check` judges their `appTools()`
 * names and scopes, `guren audit` lists their local tools. Content-activated:
 * a file that never names the package is not parsed, and a class is an agent
 * only through the package's `Agent` export (aliases followed) or through a
 * class already found to be one. RFC 0017's durable `Agent` is not this one.
 */
import { relative } from 'node:path'
import type { BlockStatement, CallExpression, ClassDeclaration, Expression, Node, ReturnStatement } from '@babel/types'
import { literalString, memberKeyName, objectLiteral, propertyValue, unwrapTypeAssertion, walk } from './ast-walk'
import { blankCommentsAndStrings, classActionMembers } from './controller-methods'
import { discoverAppSourceFiles } from './discovery'
import { extractClassDeclaration, findStaticClassProperty, staticStringArrayProperty } from './model-parser'
import type { ParseCache, ParsedFile } from './parse-cache'
import { importedLocals, type PluginExport } from './plugin-calls'
import { escapeRegExp } from './utils'

export const AI_PLUGIN_SPECIFIER = '@guren/plugin-ai'
export const AI_PLUGIN_EXPORT: PluginExport = { specifier: AI_PLUGIN_SPECIFIER, exportName: 'aiPlugin' }
const AGENT_EXPORT: PluginExport = { specifier: AI_PLUGIN_SPECIFIER, exportName: 'Agent' }
/** The methods on `Agent`, and the functions the package exports taking the agent first. */
const APP_TOOLS_NAMES = ['appTools', 'appToolDefinitions'] as const
/** Bodies whose `return` belongs to something other than the member being read. */
const NESTED_SCOPE_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
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
  className: string
  relPath: string
  line: number
  /** The class it extends: `Agent` itself, or another scanned agent. */
  parent: string | null
  /** Own `static scopes`: `undefined` when not declared, `null` when declared but unreadable. */
  ownScopes: string[] | null | undefined
  /** Own `appTools()` calls, anywhere in the class body. */
  appToolsCalls: AppToolsCall[]
  /** Whether the class declares its own `tools()`, which replaces an inherited one. */
  declaresTools: boolean
  /** Entries `tools()` returns that are not `appTools()` spreads. */
  localTools: LocalTool[]
  /** Why `tools()` could not be enumerated whole. */
  localToolsUnreadable?: string
}

/**
 * The first answer up the `extends` chain, as the runtime resolves an inherited
 * static or method. Guarded against a cycle, which a hand-edited file can spell.
 */
function inherited<T>(
  agent: ScannedAgent,
  byName: ReadonlyMap<string, ScannedAgent>,
  read: (agent: ScannedAgent) => T | undefined,
): T | undefined {
  const seen = new Set<string>()
  let current: ScannedAgent | undefined = agent
  while (current && !seen.has(current.className)) {
    const answer = read(current)
    if (answer !== undefined) return answer
    seen.add(current.className)
    current = current.parent ? byName.get(current.parent) : undefined
  }
  return undefined
}

/** Scopes as the runtime reads them: own, else inherited, else `[]`. `null` when unreadable. */
export function effectiveScopes(agent: ScannedAgent, byName: ReadonlyMap<string, ScannedAgent>): string[] | null {
  // `?? []` would read an unreadable `scopes` (null) as "grants nothing", which
  // is a verdict; undefined is the only "nobody declared any".
  const declared = inherited(agent, byName, (current) => current.ownScopes)
  return declared === undefined ? [] : declared
}

/** The `appTools()` calls that run for this class: its own when it declares `tools()` or calls them, else its parent's. */
export function effectiveAppToolsCalls(agent: ScannedAgent, byName: ReadonlyMap<string, ScannedAgent>): AppToolsCall[] {
  return inherited(agent, byName, (current) =>
    current.declaresTools || current.appToolsCalls.length > 0 ? current.appToolsCalls : undefined) ?? []
}

export async function scanAiAgents(cwd: string, cache: ParseCache): Promise<ScannedAgent[]> {
  const files = await discoverAppSourceFiles(cwd)
  // Keyed by declaration, not by class name: two modules can each declare a
  // `Triager`, and dropping one would leave its names unchecked in silence.
  const agents = new Map<string, ScannedAgent>()
  const names = new Set<string>()

  // A file joins when it names the package or extends an agent found so far;
  // repeated until a pass finds nothing new, so a chain across files resolves.
  let grew = true
  while (grew) {
    grew = false
    const extendsKnown = names.size > 0
      ? new RegExp(`\\bextends\\s+(?:${[...names].map(escapeRegExp).join('|')})\\b`)
      : null
    for (const filePath of files) {
      const source = await cache.source(filePath)
      if (!source) continue
      if (!source.includes(AI_PLUGIN_SPECIFIER) && !extendsKnown?.test(source)) continue
      const parsed = await cache.get(filePath)
      if (!parsed) continue
      for (const agent of agentsIn(relative(cwd, filePath).replace(/\\/g, '/'), parsed, names)) {
        const key = `${agent.relPath}#${agent.className}`
        if (agents.has(key)) continue
        agents.set(key, agent)
        names.add(agent.className)
        grew = true
      }
    }
  }

  return [...agents.values()]
}

function agentsIn(relPath: string, parsed: ParsedFile, known: ReadonlySet<string>): ScannedAgent[] {
  const { source, ast } = parsed
  const agentLocals = importedLocals(ast, AGENT_EXPORT)
  const helperLocals = new Set(
    APP_TOOLS_NAMES.flatMap((exportName) => [...importedLocals(ast, { specifier: AI_PLUGIN_SPECIFIER, exportName })]),
  )
  const scrubbed = blankCommentsAndStrings(source, ast)
  const found: ScannedAgent[] = []

  for (const statement of ast.program.body) {
    const classDecl = extractClassDeclaration(statement)
    const superClass = classDecl?.superClass
    if (!classDecl?.id || superClass?.type !== 'Identifier') continue
    const direct = agentLocals.has(superClass.name)
    if (!direct && !known.has(superClass.name)) continue

    const tools = toolsMember(classDecl)
    const local = tools ? readLocalTools(tools, scrubbed, helperLocals) : { tools: [] }
    found.push({
      className: classDecl.id.name,
      relPath,
      line: classDecl.loc?.start.line ?? 1,
      parent: direct ? null : superClass.name,
      ownScopes: readScopes(classDecl),
      appToolsCalls: readAppToolsCalls(classDecl, helperLocals),
      declaresTools: tools !== undefined,
      localTools: local.tools,
      ...(local.unreadable ? { localToolsUnreadable: local.unreadable } : {}),
    })
  }
  return found
}

function readScopes(classDecl: ClassDeclaration): string[] | null | undefined {
  if (!findStaticClassProperty(classDecl, 'scopes')) return undefined
  return staticStringArrayProperty(classDecl, 'scopes') ?? null
}

function isAppToolsCall(call: CallExpression, helperLocals: ReadonlySet<string>): Node | undefined {
  const { callee } = call
  if (
    callee.type === 'MemberExpression'
    && callee.object.type === 'ThisExpression'
    && !callee.computed
    && callee.property.type === 'Identifier'
    && (APP_TOOLS_NAMES as readonly string[]).includes(callee.property.name)
  ) {
    return (call.arguments[0] ?? null) as Node
  }
  if (callee.type === 'Identifier' && helperLocals.has(callee.name)) {
    return (call.arguments[1] ?? null) as Node
  }
  return undefined
}

function readAppToolsCalls(classDecl: ClassDeclaration, helperLocals: ReadonlySet<string>): AppToolsCall[] {
  const calls: AppToolsCall[] = []
  walk(classDecl.body, (node) => {
    if (node.type !== 'CallExpression') return
    const argument = isAppToolsCall(node as unknown as CallExpression, helperLocals)
    if (argument === undefined) return
    calls.push({ line: node.loc?.start.line ?? 1, ...readNames(argument) })
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
    if (NESTED_SCOPE_TYPES.has(node.type)) return false
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
): { tools: LocalTool[]; unreadable?: string } {
  const returned = returnedExpression(body)
  if (!returned.value) return { tools: [], unreadable: returned.reason }
  const value = unwrapTypeAssertion(returned.value)
  if (value.type === 'CallExpression' && isAppToolsCall(value, helperLocals) !== undefined) return { tools: [] }

  const object = objectLiteral(value)
  if (!object) return { tools: [], unreadable: 'tools() does not return an object literal' }

  const tools: LocalTool[] = []
  let unreadable: string | undefined
  for (const property of object.properties) {
    if (property.type === 'SpreadElement') {
      const spread = unwrapTypeAssertion(property.argument)
      if (spread.type !== 'CallExpression' || isAppToolsCall(spread, helperLocals) === undefined) {
        unreadable ??= 'tools() spreads something other than appTools()'
      }
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
