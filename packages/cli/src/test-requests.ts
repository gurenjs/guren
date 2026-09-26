/**
 * Which routes the existing tests request (RFC 0030 §2): `TestApp` calls read from each
 * test file's AST, matched against the route graph. A receiver is a `TestApp` only where
 * the file says so, matched by name within the file (not by scope) and never across
 * files; a request on what an imported helper returns is reported unresolved, as is a
 * path the file does not spell. Route patterns are lexed with `PATH_PARAM_PATTERN` and
 * compared here, since `@guren/cli` does not depend on hono at runtime.
 */

import type { File } from '@babel/types'

import { literalString, memberKeyName, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'
import { toPosixRelative } from './discovery'
import type { ParseCache } from './parse-cache'
import { bracketedTokens } from './plan/acceptance-status'
import { importedLocals, importedNamespaces } from './plugin-calls'
import { PATH_PARAM_PATTERN } from './utils'

const TESTING = '@guren/testing'

/** `TestApp` members returning a `PendingTestResponse`; `tests/test-requests.test.ts` pins them to the class. */
export const REQUEST_METHODS: Readonly<Record<string, string>> = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE', query: 'QUERY' }
/** `TestApp` members returning a `TestApp` or a promise of one; `withCsrf(path = '/')` also GETs its path. */
export const BUILDERS: ReadonlySet<string> = new Set(['actingAs', 'json', 'withHeaders', 'withHeader', 'withCsrf'])

/** A path segment the file spells, or one a runtime value fills whole. */
export type TestRequestSegment = { literal: string } | { runtime: true }

type TestRequestTarget =
  | { kind: 'path'; method: string; segments: TestRequestSegment[] }
  | { kind: 'tool'; name: string }

export interface TestRequestSite {
  /** App-relative, POSIX separators. */
  file: string
  line: number
  /** The call as written: `POST /tickets/${…}/close`, or `agent().call('tickets_close')`. */
  text: string
}

export interface TestRequest extends TestRequestSite {
  target: TestRequestTarget
}

export type UnresolvedReason = 'dynamicPath' | 'partialSegment' | 'unknownReceiver' | 'localReceiver' | 'routePattern' | 'routeOrder'

export interface UnresolvedTestRequest extends TestRequestSite {
  reason: UnresolvedReason
  /** The HTTP method; absent for an agent tool call, which only a route publishing a tool can answer. */
  method?: string
}

export interface TestRequestScan {
  requests: TestRequest[]
  unresolved: UnresolvedTestRequest[]
  /** Test files that did not parse, so their requests were not read. */
  unparsed: string[]
}

export interface TestRequestRoute {
  method: string
  path: string
  toolName?: string
  /** The module whose registrar declared it, or `null` for the entry registrar's: its scope in {@link registeredBefore}. */
  module?: string | null
}

const RUNTIME = Symbol('runtime')
type PathPart = string | typeof RUNTIME

/** Stands for a runtime value inside a joined path, and for a param token inside a masked route path. */
const HOLE = '\u{E000}'

interface Receivers {
  aliases: ReadonlySet<string>
  namespaces: ReadonlySet<string>
  /** Value imports, whose calls return something the file does not show. */
  imported: ReadonlySet<string>
  /** Every same-file function by name; one not in `functions` returns what its annotation does not say. */
  local: ReadonlySet<string>
  names: Set<string>
  functions: Set<string>
  /** Bindings holding what such a call returned, and which kind of call it was. */
  foreign: Map<string, ForeignReason>
  agents: Set<string>
}

type ForeignReason = Extract<UnresolvedReason, 'unknownReceiver' | 'localReceiver'>

/** `TestApp`, an alias of it, or `testing.TestApp` through a namespace import, as a type or a value. */
function namesTestApp(name: BabelNode, receivers: Receivers): boolean {
  if (name.type === 'Identifier') return receivers.aliases.has(name.name as string)
  const [namespace, member] = name.type === 'TSQualifiedName'
    ? [name.left as BabelNode, name.right as BabelNode]
    : name.type === 'MemberExpression' && !name.computed ? [name.object as BabelNode, name.property as BabelNode] : []
  return namespace?.type === 'Identifier' && receivers.namespaces.has(namespace.name as string)
    && member?.type === 'Identifier' && member.name === 'TestApp'
}

function typeNamesTestApp(node: BabelNode | undefined, receivers: Receivers): boolean {
  if (!node) return false
  if (node.type === 'TSTypeAnnotation') return typeNamesTestApp(node.typeAnnotation as BabelNode, receivers)
  if (node.type === 'TSUnionType') return (node.types as BabelNode[]).some((type) => typeNamesTestApp(type, receivers))
  if (node.type !== 'TSTypeReference') return false
  const name = node.typeName as BabelNode
  if (namesTestApp(name, receivers)) return true
  const params = (node.typeParameters as BabelNode | undefined)?.params as BabelNode[] | undefined
  return name.type === 'Identifier' && name.name === 'Promise' && params?.length === 1 && typeNamesTestApp(params[0], receivers)
}

function valueImports(ast: File): Set<string> {
  const names = new Set<string>()
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue
      names.add(specifier.local.name)
    }
  }
  return names
}

/** `const NAME = '…'` anywhere in the file; a name bound twice to different strings is dropped. */
function stringConstants(ast: File): Map<string, string> {
  const values = new Map<string, string | null>()
  walk(ast.program, (node) => {
    if (node.type !== 'VariableDeclaration' || node.kind !== 'const') return
    for (const declarator of node.declarations as BabelNode[]) {
      const id = declarator.id as BabelNode
      if (id.type !== 'Identifier') continue
      const value = literalString(declarator.init)
      const name = id.name as string
      values.set(name, values.has(name) && values.get(name) !== value ? null : value)
    }
  })
  const constants = new Map<string, string>()
  for (const [name, value] of values) if (value !== null) constants.set(name, value)
  return constants
}

function calleeMember(node: BabelNode): { object: BabelNode; name: string; line: number } | undefined {
  if (node.type !== 'CallExpression') return undefined
  const callee = node.callee as BabelNode
  if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return undefined
  const property = callee.property as BabelNode
  const name = memberKeyName({ computed: Boolean(callee.computed), key: property as never })
  // The method's own line: a chain puts the receiver lines above the call.
  return name === undefined ? undefined : { object: callee.object as BabelNode, name, line: property.loc?.start.line ?? 0 }
}

function isTestApp(value: unknown, receivers: Receivers): boolean {
  const node = unwrapTypeAssertion(value as BabelNode)
  if (!node) return false
  if (node.type === 'AwaitExpression') return isTestApp(node.argument, receivers)
  if (node.type === 'Identifier') return receivers.names.has(node.name as string)
  if (node.type !== 'CallExpression') return false
  const callee = node.callee as BabelNode
  if (callee.type === 'Identifier') return receivers.functions.has(callee.name as string)
  const member = calleeMember(node)
  if (!member) return false
  if (namesTestApp(unwrapTypeAssertion(member.object), receivers)) return true
  return BUILDERS.has(member.name) && isTestApp(member.object, receivers)
}

/**
 * What a call to an imported function returns, or to a same-file one not annotated to return a
 * `TestApp`: either may be a `TestApp` the file never names.
 */
function foreignReason(value: unknown, receivers: Receivers): ForeignReason | undefined {
  const node = unwrapTypeAssertion(value as BabelNode)
  if (!node || isTestApp(node, receivers)) return undefined
  if (node.type === 'AwaitExpression') return foreignReason(node.argument, receivers)
  if (node.type === 'Identifier') return receivers.foreign.get(node.name as string)
  if (node.type !== 'CallExpression') return undefined
  const callee = node.callee as BabelNode
  if (callee.type === 'Identifier') {
    const name = callee.name as string
    if (receivers.imported.has(name)) return 'unknownReceiver'
    return receivers.local.has(name) ? 'localReceiver' : undefined
  }
  const member = calleeMember(node)
  return member !== undefined && BUILDERS.has(member.name) ? foreignReason(member.object, receivers) : undefined
}

function isAgent(value: unknown, receivers: Receivers): boolean {
  const node = unwrapTypeAssertion(value as BabelNode)
  if (node.type === 'Identifier') return receivers.agents.has(node.name as string)
  const member = calleeMember(node)
  return member?.name === 'agent' && isTestApp(member.object, receivers)
}

function returnsTestApp(fn: BabelNode, receivers: Receivers): boolean {
  if (typeNamesTestApp(fn.returnType as BabelNode | undefined, receivers)) return true
  const body = fn.body as BabelNode
  return fn.type === 'ArrowFunctionExpression' && body.type !== 'BlockStatement' && isTestApp(body, receivers)
}

/** Grows the receiver names to a fixed point, since a binding may be declared before what makes it one. */
function collectReceivers(ast: File, local: ReadonlySet<string>): Receivers {
  const receivers: Receivers = {
    aliases: importedLocals(ast, { specifier: TESTING, exportName: 'TestApp' }),
    namespaces: importedNamespaces(ast, TESTING),
    imported: valueImports(ast),
    local,
    names: new Set(),
    functions: new Set(),
    foreign: new Map(),
    agents: new Set(),
  }
  const addTo = (set: Set<string>, name: string): boolean => (set.has(name) ? false : (set.add(name), true))
  const bind = (name: string, value: unknown): boolean => {
    if (isTestApp(value, receivers)) return addTo(receivers.names, name)
    if (isAgent(value, receivers)) return addTo(receivers.agents, name)
    const reason = foreignReason(value, receivers)
    const current = receivers.foreign.get(name)
    // Names match across scopes, so two bindings of one name must only escalate, never trade places, or the loop never settles.
    if (reason === undefined || current === reason || current === 'unknownReceiver') return false
    receivers.foreign.set(name, reason)
    return true
  }
  for (let changed = true; changed;) {
    changed = false
    walk(ast.program, (node) => {
      if (node.type === 'Identifier' && typeNamesTestApp(node.typeAnnotation as BabelNode | undefined, receivers)) {
        changed = addTo(receivers.names, node.name as string) || changed
      } else if (node.type === 'VariableDeclarator' && (node.id as BabelNode).type === 'Identifier') {
        const name = (node.id as BabelNode).name as string
        const init = node.init as BabelNode | null
        if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
          if (returnsTestApp(init, receivers)) changed = addTo(receivers.functions, name) || changed
        } else if (init) changed = bind(name, init) || changed
      } else if (node.type === 'AssignmentExpression' && (node.left as BabelNode).type === 'Identifier') {
        changed = bind((node.left as BabelNode).name as string, node.right) || changed
      } else if (node.type === 'FunctionDeclaration' && node.id && returnsTestApp(node, receivers)) {
        changed = addTo(receivers.functions, (node.id as BabelNode).name as string) || changed
      }
    })
  }
  return receivers
}

/** The parts a path argument spells, a runtime value standing for what the file does not; `null` when nothing is spelled. */
function pathParts(value: unknown, constants: ReadonlyMap<string, string>): PathPart[] | null {
  const node = unwrapTypeAssertion(value as BabelNode)
  const literal = literalString(node)
  if (literal !== null) return [literal]
  if (node.type === 'Identifier' && constants.has(node.name as string)) return [constants.get(node.name as string)!]
  const part = (expression: unknown): PathPart[] => pathParts(expression, constants) ?? [RUNTIME]
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis as Array<{ value: { cooked?: string | null } }>
    const expressions = node.expressions as BabelNode[]
    return quasis.flatMap((quasi, index) => [quasi.value.cooked ?? '', ...(index < expressions.length ? part(expressions[index]) : [])])
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = pathParts(node.left, constants)
    return left === null ? null : [...left, ...part(node.right)]
  }
  return null
}

/**
 * Segments of the path before any query or fragment, or why they cannot be read. Empty
 * segments are kept, since hono is strict: `/posts/` is `['posts', '']`, not `/posts`.
 */
function pathSegments(parts: readonly PathPart[]): TestRequestSegment[] | 'dynamicPath' | 'partialSegment' {
  const joined = parts.map((part) => (part === RUNTIME ? HOLE : part)).join('')
  const origin = /^https?:\/\/[^/?#]*/u.exec(joined)?.[0] ?? ''
  const path = (joined.slice(origin.length).split(/[?#]/u)[0] ?? '') || '/'
  if (origin.includes(HOLE) || !path.startsWith('/')) return 'dynamicPath'
  const segments: TestRequestSegment[] = []
  for (const segment of path.slice(1).split('/')) {
    if (!segment.includes(HOLE)) segments.push({ literal: segment })
    else if (segment === HOLE) segments.push({ runtime: true })
    else return 'partialSegment'
  }
  return segments
}

function describePath(method: string, parts: readonly PathPart[]): string {
  return `${method} ${parts.map((part) => (part === RUNTIME ? '${…}' : part)).join('')}`
}

function startsLikePath(parts: readonly PathPart[] | null): boolean {
  const first = parts?.[0]
  return typeof first === 'string' && (first.startsWith('/') || /^https?:\/\//u.test(first))
}

type ScannedCall =
  | { kind: 'request'; request: TestRequest }
  | { kind: 'unresolved'; request: UnresolvedTestRequest }
  /** A call handing a `TestApp` (or its agent) to code the file may not show, which could request anything. */
  | { kind: 'handoff'; site: TestRequestSite; callee?: string }

function calleeText(callee: BabelNode): string | undefined {
  if (callee.type === 'Identifier') return callee.name as string
  if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return undefined
  const object = calleeText(callee.object as BabelNode)
  const name = memberKeyName({ computed: Boolean(callee.computed), key: callee.property as never })
  return object === undefined || name === undefined ? undefined : `${object}.${name}`
}

interface ScannedEntry {
  /** The call's source offset, which the case scan places it by. */
  start: number
  call: ScannedCall
}

function scanFile(ast: File, file: string, functions: ReadonlyMap<string, Range[]>): ScannedEntry[] {
  const receivers = collectReceivers(ast, new Set(functions.keys()))
  const constants = stringConstants(ast)
  const entries: ScannedEntry[] = []

  walk(ast.program, (node) => {
    if (node.type !== 'CallExpression' || typeof node.start !== 'number') return
    const args = node.arguments as BabelNode[]
    const member = calleeMember(node)
    const call = member && scanRequest(member, args, file, receivers, constants)
    if (call) entries.push({ start: node.start, call })
    if (member && (isTestApp(member.object, receivers) || isAgent(member.object, receivers))) return
    if (args.some((arg) => isTestApp(arg, receivers) || isAgent(arg, receivers))) {
      const callee = calleeText(node.callee as BabelNode)
      const line = node.loc?.start.line ?? 0
      entries.push({ start: node.start, call: { kind: 'handoff', site: { file, line, text: `${callee ?? '<expression>'}(…)` }, ...(callee === undefined ? {} : { callee }) } })
    }
  })
  return entries
}

function scanRequest(
  member: { object: BabelNode; name: string; line: number },
  args: BabelNode[],
  file: string,
  receivers: Receivers,
  constants: ReadonlyMap<string, string>,
): ScannedCall | undefined {
  const { line } = member
  const primes = member.name === 'withCsrf'
  const method = primes ? 'GET' : REQUEST_METHODS[member.name]
  if (method !== undefined && (args.length > 0 || primes)) {
    const parts = args.length === 0 ? ['/'] : pathParts(args[0], constants)
    const text = parts === null ? `${method} <runtime>` : describePath(method, parts)
    if (isTestApp(member.object, receivers)) {
      const segments = parts === null ? 'dynamicPath' : pathSegments(parts)
      if (typeof segments === 'string') return { kind: 'unresolved', request: { file, line, text, reason: segments, method } }
      return { kind: 'request', request: { file, line, text, target: { kind: 'path', method, segments } } }
    }
    const reason = startsLikePath(parts) ? foreignReason(member.object, receivers) : undefined
    return reason === undefined ? undefined : { kind: 'unresolved', request: { file, line, text, reason, method } }
  }
  if (member.name === 'call' && args.length > 0 && isAgent(member.object, receivers)) {
    const name = literalString(args[0])
    const text = `agent().call(${name === null ? '<runtime>' : `'${name}'`})`
    if (name === null) return { kind: 'unresolved', request: { file, line, text, reason: 'dynamicPath' } }
    return { kind: 'request', request: { file, line, text, target: { kind: 'tool', name } } }
  }
  return undefined
}

/** Every `TestApp` request the given test files spell. `files` are absolute. */
export async function scanTestRequests(root: string, files: readonly string[], cache: ParseCache): Promise<TestRequestScan> {
  const scan: TestRequestScan = { requests: [], unresolved: [], unparsed: [] }
  for (const absolute of files) {
    const file = toPosixRelative(root, absolute)
    const outcome = await cache.read(absolute)
    if (outcome.status !== 'parsed') {
      // Only a file that mentions TestApp can hold a request, so a parse failure elsewhere hides nothing.
      if (outcome.status === 'unreadable' || outcome.source.includes('TestApp')) scan.unparsed.push(file)
      continue
    }
    for (const { call } of scanFile(outcome.ast, file, localFunctions(outcome.ast))) {
      if (call.kind === 'request') scan.requests.push(call.request)
      else if (call.kind === 'unresolved') scan.unresolved.push(call.request)
    }
  }
  return scan
}

/** The requests a test case makes, for the ids its title or an enclosing `describe`'s carries. */
export interface TestCaseRequests extends Omit<TestRequestScan, 'unparsed'> {
  file: string
  line: number
  title: string
  /** Calls in the case handing a `TestApp` to code the file does not define, which may request anything. */
  handedOff: TestRequestSite[]
}

export interface TestCaseScan {
  /** Per accepted token, every `test`/`it`/`describe` whose literal title carries it. */
  cases: Map<string, TestCaseRequests[]>
  /** Test calls whose title is not all literal, so a token may hide in it. */
  opaqueTitles: TestRequestSite[]
  /** Per accepted token, the test calls carrying it with no callback (`test.todo('[AC-1] x')`). */
  bodiless: Map<string, TestRequestSite[]>
  /** Files that did not parse, so no case of theirs was read. */
  unparsed: string[]
}

const TEST_CALLEES = ['test', 'it', 'describe'] as const
const RUNNER = 'bun:test'

/** `test`, `test.only`, `test.each(rows)`, `it.if(c)`: the identifier a test call chain starts from. */
function chainRoot(callee: BabelNode): string | undefined {
  let node = callee
  for (;;) {
    if (node.type === 'Identifier') return node.name as string
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') node = node.object as BabelNode
    else if (node.type === 'CallExpression') node = node.callee as BabelNode
    else return undefined
  }
}

/** A title's text with each non-literal part as {@link HOLE}, so a token spanning one can be dropped. */
function titleText(value: unknown): string | null {
  const node = unwrapTypeAssertion(value as BabelNode)
  const literal = literalString(node)
  if (literal !== null) return literal
  if (node?.type !== 'TemplateLiteral') return null
  return (node.quasis as Array<{ value: { cooked?: string | null } }>).map((quasi) => quasi.value.cooked ?? '').join(HOLE)
}

interface Range {
  start: number
  end: number
}

function rangeOf(node: BabelNode): Range | undefined {
  return typeof node.start === 'number' && typeof node.end === 'number' ? { start: node.start, end: node.end } : undefined
}

function isFunction(node: BabelNode | undefined | null): node is BabelNode {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'
}

/** Same-file functions by name, matched by name as the receivers are, not by scope. */
function localFunctions(ast: File): Map<string, Range[]> {
  const functions = new Map<string, Range[]>()
  const add = (name: string, node: BabelNode): void => {
    const range = rangeOf(node)
    if (range) functions.set(name, [...(functions.get(name) ?? []), range])
  }
  walk(ast.program, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) add((node.id as BabelNode).name as string, node)
    else if (node.type === 'VariableDeclarator' && (node.id as BabelNode).type === 'Identifier' && isFunction(node.init as BabelNode | null)) {
      add((node.id as BabelNode).name as string, node.init as BabelNode)
    }
  })
  return functions
}

function within(ranges: readonly Range[], start: number): boolean {
  return ranges.some((range) => start >= range.start && start < range.end)
}

/** A case's body and, transitively, every same-file function called by name from inside it. */
function caseRanges(body: Range, functions: ReadonlyMap<string, Range[]>, calls: ReadonlyArray<{ start: number; name: string }>): Range[] {
  const ranges = [body]
  const followed = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const { start, name } of calls) {
      if (followed.has(name) || !within(ranges, start)) continue
      followed.add(name)
      ranges.push(...(functions.get(name) ?? []))
      grew = true
    }
  }
  return ranges
}

/**
 * The `TestApp` requests each test case makes, for the tokens `accept` takes. A case carries a
 * token its literal title or an enclosing `describe`'s holds, as the junit report reads it, and
 * makes the requests in its body and in the same-file functions it calls by name. `files` are absolute.
 */
export async function scanTestCaseRequests(root: string, files: readonly string[], cache: ParseCache, accept: (token: string) => boolean): Promise<TestCaseScan> {
  const scan: TestCaseScan = { cases: new Map(), opaqueTitles: [], bodiless: new Map(), unparsed: [] }
  for (const absolute of files) {
    const file = toPosixRelative(root, absolute)
    const outcome = await cache.read(absolute)
    if (outcome.status !== 'parsed') {
      scan.unparsed.push(file)
      continue
    }
    scanCases(outcome.ast, file, accept, scan)
  }
  return scan
}

function scanCases(ast: File, file: string, accept: (token: string) => boolean, scan: TestCaseScan): void {
  const runner = new Set<string>(TEST_CALLEES)
  for (const name of TEST_CALLEES) for (const local of importedLocals(ast, { specifier: RUNNER, exportName: name })) runner.add(local)
  const functions = localFunctions(ast)
  const found = scanFile(ast, file, functions)
  const calls: Array<{ start: number; name: string }> = []
  walk(ast.program, (node) => {
    const callee = node.type === 'CallExpression' ? (node.callee as BabelNode) : undefined
    if (callee?.type === 'Identifier' && functions.has(callee.name as string) && typeof node.start === 'number') calls.push({ start: node.start, name: callee.name as string })
  })

  walk(ast.program, (node) => {
    if (node.type !== 'CallExpression') return
    const root = chainRoot(node.callee as BabelNode)
    if (root === undefined || !runner.has(root)) return
    const args = node.arguments as BabelNode[]
    const body = args.slice(1).find(isFunction)
    const text = titleText(args[0])
    // `test.each(rows)` and `test.if(c)` carry no title: the call they return does.
    if (!body && text === null) return
    const line = node.loc?.start.line ?? 0
    const shown = text?.replaceAll(HOLE, '${…}') ?? '<runtime>'
    if (text === null || text.includes(HOLE)) scan.opaqueTitles.push({ file, line, text: shown })
    const tokens = new Set((text === null ? [] : bracketedTokens(text)).filter((token) => !token.includes(HOLE) && accept(token)))
    if (tokens.size === 0) return
    const range = body && rangeOf(body)
    if (!range) {
      for (const token of tokens) scan.bodiless.set(token, [...(scan.bodiless.get(token) ?? []), { file, line, text: shown }])
      return
    }
    const ranges = caseRanges(range, functions, calls)
    const entry: TestCaseRequests = { file, line, title: shown, requests: [], unresolved: [], handedOff: [] }
    for (const { start, call } of found) {
      if (!within(ranges, start)) continue
      if (call.kind === 'request') entry.requests.push(call.request)
      else if (call.kind === 'unresolved') entry.unresolved.push(call.request)
      else if (call.callee === undefined || !functions.has(call.callee)) entry.handedOff.push(call.site)
    }
    for (const token of tokens) scan.cases.set(token, [...(scan.cases.get(token) ?? []), entry])
  })
}

type Match = 'match' | 'none' | 'unknown'

interface PatternSegment {
  /** Regex source for the segment, or `null` for a lone `*`. */
  source: string | null
  /** The segment as the route spells it; only on a literal segment. */
  literal?: string
  /** A lone param token: what a runtime segment may fill, and a constraint that may span `/`. */
  param?: { constraint?: string; optional: boolean }
}

class UncompilablePattern extends Error {}

const compiled = new Map<string, RegExp | null>()

function compile(source: string): RegExp {
  let regex = compiled.get(source)
  if (regex === undefined) {
    try {
      // No `u` flag: hono compiles constraints without it, and `\_` is an error under it.
      regex = new RegExp(`^(?:${source})$`)
    } catch {
      regex = null
    }
    compiled.set(source, regex)
  }
  if (regex === null) throw new UncompilablePattern(source)
  return regex
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** A route path as segments: param tokens are masked before the split, so a constraint's `/` stays in its token. */
function patternSegments(path: string): PatternSegment[] {
  const tokens: Array<{ constraint?: string; optional: boolean }> = []
  const masked = path.replace(PATH_PARAM_PATTERN, (token: string, boundary: string) => {
    const brace = token.indexOf('{')
    tokens.push({ ...(brace >= 0 ? { constraint: token.slice(brace + 1, token.lastIndexOf('}')) } : {}), optional: token.endsWith('?') })
    return `${boundary}${HOLE}`
  })
  let next = 0
  return (masked.startsWith('/') ? masked.slice(1) : masked).split('/').map((part): PatternSegment => {
    if (part === '*') return { source: null }
    if (!part.startsWith(HOLE)) return { source: escapeRegExp(part), literal: part }
    // Hono's label runs to the next `/` or `{`, so text after the token (`:id.json`) is part of the name.
    const param = tokens[next++]!
    return { source: param.constraint ?? '[^/]+', param }
  })
}

export interface RoutePathMatchOptions {
  /**
   * Read a runtime segment at a constrained parameter as filling it, one segment. For a caller
   * asking whether a request names the route, not whether its value passes: an unmatched value 404s.
   * Where one segment does not fit, the answer stays `unknown`, never `none`.
   */
  runtimeFillsConstraints?: boolean
}

function matchFrom(patterns: readonly PatternSegment[], pi: number, segments: readonly TestRequestSegment[], si: number, options: RoutePathMatchOptions): Match {
  if (pi === patterns.length) return si === segments.length ? 'match' : 'none'
  const pattern = patterns[pi]!
  const last = pi === patterns.length - 1
  const segment = segments[si]
  if (pattern.source === null) {
    if (last) return 'match'
    // A middle `*` takes one segment, and hono does not let it take an empty one.
    return segment === undefined || ('literal' in segment && segment.literal === '') ? 'none' : matchFrom(patterns, pi + 1, segments, si + 1, options)
  }
  if (last && pattern.param?.optional && si === segments.length) return 'match'
  if (segment === undefined) return 'none'
  const constraint = pattern.param?.constraint
  if ('runtime' in segment) {
    if (!pattern.param) return 'none'
    // A runtime value may fail the constraint, or span `/` and take the segments after it.
    if (constraint === undefined) return matchFrom(patterns, pi + 1, segments, si + 1, options)
    if (!options.runtimeFillsConstraints) return 'unknown'
    // Filling one segment is the reading asked for; a constraint spanning `/` may take more, which stays unknown.
    const filled = matchFrom(patterns, pi + 1, segments, si + 1, options)
    return filled === 'none' ? 'unknown' : filled
  }
  let result: Match = 'none'
  const settles = (match: Match): boolean => {
    if (match === 'unknown') result = 'unknown'
    return match === 'match'
  }
  if (compile(pattern.source).test(segment.literal) && settles(matchFrom(patterns, pi + 1, segments, si + 1, options))) return 'match'
  if (constraint === undefined) return result
  // A constraint may match `/` (`:path{.+}`) and take the spelled segments after it along.
  let joined = segment.literal
  for (let end = si + 1; end < segments.length; end += 1) {
    const following = segments[end]!
    if ('runtime' in following) return 'unknown'
    joined += `/${following.literal}`
    if (compile(pattern.source).test(joined) && settles(matchFrom(patterns, pi + 1, segments, end + 1, options))) return 'match'
  }
  return result
}

/**
 * Hono's matching of one route path: `:name`, `:name{re}`, an optional last `:name?`, a
 * trailing `*` (any rest, none included), a middle `*` (one non-empty segment).
 * A runtime segment fills a lone param; against a constraint it is `unknown`.
 * A constraint this engine cannot compile is `unknown` too, never read as no match.
 */
export function routePathMatches(path: string, segments: readonly TestRequestSegment[], options: RoutePathMatchOptions = {}): Match {
  try {
    return matchFrom(patternSegments(path), 0, segments, 0, options)
  } catch (error) {
    if (error instanceof UncompilablePattern) return 'unknown'
    throw error
  }
}

/**
 * Whether a route at `earlier`, registered first, answers every request a route at `later`
 * matches: hono dispatches to the first registered handler, so `match` means none reaches
 * `later`. `later` is read as one request, a lone parameter filled at runtime (and dropped,
 * when it is an optional last one). Only literals and unconstrained parameters make that
 * request stand for all of `later`'s, so with a constraint or a `*` a `match` is `unknown`.
 */
export function routePathCovers(earlier: string, later: string): Match {
  const patterns = patternSegments(later)
  const last = patterns.length - 1
  const exact = patterns.every((pattern, index) => pattern.source !== null && pattern.param?.constraint === undefined && (!pattern.param?.optional || index === last))
  const request = patterns.map((pattern): TestRequestSegment => (pattern.literal === undefined ? { runtime: true } : { literal: pattern.literal }))
  const requests = patterns[last]?.param?.optional ? [request, request.slice(0, -1)] : [request]
  const results = requests.map((segments) => routePathMatches(earlier, segments))
  if (results.includes('none')) return 'none'
  return exact && results.every((result) => result === 'match') ? 'match' : 'unknown'
}

export interface TestCoverage {
  /** Per route index, the requests that reach it. */
  byRoute: Map<number, TestRequestSite[]>
  /** Per route index, the requests its pattern could not be compared with. */
  uncertainByRoute: Map<number, UnresolvedTestRequest[]>
  /** What the scan could not read, which may reach any route {@link mayReach} allows. */
  unresolved: UnresolvedTestRequest[]
}

function push<T>(map: Map<number, T[]>, index: number, value: T): void {
  const list = map.get(index) ?? []
  list.push(value)
  map.set(index, list)
}

export interface RegisteredRoute {
  index: number
  /** The module whose registrar declared it, or `null` for the entry registrar's. */
  module: string | null
}

/**
 * Whether `earlier` registers before `later`, in `mountRoutes()`'s order: the entry registrar's
 * routes, then each module's in `createApp({ modules })` order, each scope in its list order.
 * The CLI loads modules in directory order instead, so two modules' routes are `undefined`.
 */
export function registeredBefore(earlier: RegisteredRoute, later: RegisteredRoute): boolean | undefined {
  if (earlier.module === later.module) return earlier.index < later.index
  if (earlier.module === null || later.module === null) return earlier.module === null
  return undefined
}

export interface TestCoverageOptions extends RoutePathMatchOptions {
  /**
   * `routes` are the application's, in registration order within each `module`, so a request is
   * given to the route hono answers it with: the first registered of its method (or `ALL`) whose
   * path matches. `modulesIncomplete` says a module's routes did not load, any of which may come first.
   */
  registered?: { modulesIncomplete: boolean }
}

interface Candidate extends RegisteredRoute {
  match: Match
}

function scopeOf(route: TestRequestRoute, index: number): RegisteredRoute {
  return { index, module: route.module ?? null }
}

/**
 * Without `registered`, every matching route is listed. With it, a route another answers first
 * gets nothing, and one an earlier route may answer first, or that only an unknown module order
 * puts first, gets the request as uncertain (`routeOrder`).
 */
export function testCoverage(scan: Pick<TestRequestScan, 'requests' | 'unresolved'>, routes: readonly TestRequestRoute[], options: TestCoverageOptions = {}): TestCoverage {
  const coverage: TestCoverage = { byRoute: new Map(), uncertainByRoute: new Map(), unresolved: [...scan.unresolved] }
  const { registered } = options
  for (const { target, ...site } of scan.requests) {
    if (target.kind === 'tool') {
      routes.forEach((route, index) => {
        if (route.toolName === target.name) push(coverage.byRoute, index, site)
      })
      continue
    }
    const candidates: Candidate[] = []
    routes.forEach((route, index) => {
      const method = route.method.toUpperCase()
      if (method !== target.method && (registered === undefined || method !== 'ALL')) return
      const match = routePathMatches(route.path, target.segments, options)
      if (match !== 'none') candidates.push({ ...scopeOf(route, index), match })
    })
    for (const candidate of candidates) {
      const ahead = registered === undefined ? [] : candidates.filter((other) => registeredBefore(other, candidate) !== false)
      if (ahead.some((other) => other.match === 'match' && registeredBefore(other, candidate) === true)) continue
      if (candidate.match === 'unknown') push(coverage.uncertainByRoute, candidate.index, { ...site, reason: 'routePattern', method: target.method })
      else if (ahead.length > 0 || (registered?.modulesIncomplete === true && candidate.module !== null)) push(coverage.uncertainByRoute, candidate.index, { ...site, reason: 'routeOrder', method: target.method })
      else push(coverage.byRoute, candidate.index, site)
    }
  }
  return coverage
}

/** Whether an unresolved request could be one reaching `route`: its method, or a tool call on a route publishing one. */
export function mayReach(request: UnresolvedTestRequest, route: TestRequestRoute): boolean {
  return request.method === undefined ? route.toolName !== undefined : request.method === route.method.toUpperCase()
}
