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

export type UnresolvedReason = 'dynamicPath' | 'partialSegment' | 'unknownReceiver' | 'routePattern'

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
  names: Set<string>
  functions: Set<string>
  foreign: Set<string>
  agents: Set<string>
}

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

/** What a call to an imported function returns, which may be a `TestApp` the file never names. */
function isForeign(value: unknown, receivers: Receivers): boolean {
  const node = unwrapTypeAssertion(value as BabelNode)
  if (!node || isTestApp(node, receivers)) return false
  if (node.type === 'AwaitExpression') return isForeign(node.argument, receivers)
  if (node.type === 'Identifier') return receivers.foreign.has(node.name as string)
  if (node.type !== 'CallExpression') return false
  const callee = node.callee as BabelNode
  if (callee.type === 'Identifier') return receivers.imported.has(callee.name as string)
  const member = calleeMember(node)
  return member !== undefined && BUILDERS.has(member.name) && isForeign(member.object, receivers)
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
function collectReceivers(ast: File): Receivers {
  const receivers: Receivers = {
    aliases: importedLocals(ast, { specifier: TESTING, exportName: 'TestApp' }),
    namespaces: importedNamespaces(ast, TESTING),
    imported: valueImports(ast),
    names: new Set(),
    functions: new Set(),
    foreign: new Set(),
    agents: new Set(),
  }
  const addTo = (set: Set<string>, name: string): boolean => (set.has(name) ? false : (set.add(name), true))
  const bind = (name: string, value: unknown): boolean => {
    if (isTestApp(value, receivers)) return addTo(receivers.names, name)
    if (isAgent(value, receivers)) return addTo(receivers.agents, name)
    return isForeign(value, receivers) ? addTo(receivers.foreign, name) : false
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

function scanFile(ast: File, file: string, scan: TestRequestScan): void {
  const receivers = collectReceivers(ast)
  const constants = stringConstants(ast)

  walk(ast.program, (node) => {
    const member = calleeMember(node)
    if (!member) return
    const args = node.arguments as BabelNode[]
    const { line } = member
    const primes = member.name === 'withCsrf'
    const method = primes ? 'GET' : REQUEST_METHODS[member.name]
    if (method !== undefined && (args.length > 0 || primes)) {
      const parts = args.length === 0 ? ['/'] : pathParts(args[0], constants)
      const text = parts === null ? `${method} <runtime>` : describePath(method, parts)
      if (isTestApp(member.object, receivers)) {
        const segments = parts === null ? 'dynamicPath' : pathSegments(parts)
        if (typeof segments === 'string') scan.unresolved.push({ file, line, text, reason: segments, method })
        else scan.requests.push({ file, line, text, target: { kind: 'path', method, segments } })
      } else if (startsLikePath(parts) && isForeign(member.object, receivers)) {
        scan.unresolved.push({ file, line, text, reason: 'unknownReceiver', method })
      }
    } else if (member.name === 'call' && args.length > 0 && isAgent(member.object, receivers)) {
      const name = literalString(args[0])
      const text = `agent().call(${name === null ? '<runtime>' : `'${name}'`})`
      if (name === null) scan.unresolved.push({ file, line, text, reason: 'dynamicPath' })
      else scan.requests.push({ file, line, text, target: { kind: 'tool', name } })
    }
  })
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
    scanFile(outcome.ast, file, scan)
  }
  return scan
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

function matchFrom(patterns: readonly PatternSegment[], pi: number, segments: readonly TestRequestSegment[], si: number): Match {
  if (pi === patterns.length) return si === segments.length ? 'match' : 'none'
  const pattern = patterns[pi]!
  const last = pi === patterns.length - 1
  const segment = segments[si]
  if (pattern.source === null) {
    if (last) return 'match'
    // A middle `*` takes one segment, and hono does not let it take an empty one.
    return segment === undefined || ('literal' in segment && segment.literal === '') ? 'none' : matchFrom(patterns, pi + 1, segments, si + 1)
  }
  if (last && pattern.param?.optional && si === segments.length) return 'match'
  if (segment === undefined) return 'none'
  const constraint = pattern.param?.constraint
  if ('runtime' in segment) {
    if (!pattern.param) return 'none'
    // A runtime value may fail the constraint, or span `/` and take the segments after it.
    return constraint === undefined ? matchFrom(patterns, pi + 1, segments, si + 1) : 'unknown'
  }
  let result: Match = 'none'
  const settles = (match: Match): boolean => {
    if (match === 'unknown') result = 'unknown'
    return match === 'match'
  }
  if (compile(pattern.source).test(segment.literal) && settles(matchFrom(patterns, pi + 1, segments, si + 1))) return 'match'
  if (constraint === undefined) return result
  // A constraint may match `/` (`:path{.+}`) and take the spelled segments after it along.
  let joined = segment.literal
  for (let end = si + 1; end < segments.length; end += 1) {
    const following = segments[end]!
    if ('runtime' in following) return 'unknown'
    joined += `/${following.literal}`
    if (compile(pattern.source).test(joined) && settles(matchFrom(patterns, pi + 1, segments, end + 1))) return 'match'
  }
  return result
}

/**
 * Hono's matching of one route path: `:name`, `:name{re}`, an optional last `:name?`, a
 * trailing `*` (any rest, none included), a middle `*` (one non-empty segment).
 * A runtime segment fills a lone param; against a constraint it is `unknown`.
 * A constraint this engine cannot compile is `unknown` too, never read as no match.
 */
export function routePathMatches(path: string, segments: readonly TestRequestSegment[]): Match {
  try {
    return matchFrom(patternSegments(path), 0, segments, 0)
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

/** Every matching route is listed: a static scan has no registration order to pick hono's first match by. */
export function testCoverage(scan: TestRequestScan, routes: readonly TestRequestRoute[]): TestCoverage {
  const coverage: TestCoverage = { byRoute: new Map(), uncertainByRoute: new Map(), unresolved: [...scan.unresolved] }
  for (const { target, ...site } of scan.requests) {
    routes.forEach((route, index) => {
      if (target.kind === 'tool') {
        if (route.toolName === target.name) push(coverage.byRoute, index, site)
        return
      }
      if (route.method.toUpperCase() !== target.method) return
      const match = routePathMatches(route.path, target.segments)
      if (match === 'match') push(coverage.byRoute, index, site)
      else if (match === 'unknown') push(coverage.uncertainByRoute, index, { ...site, reason: 'routePattern', method: target.method })
    })
  }
  return coverage
}

/** Whether an unresolved request could be one reaching `route`: its method, or a tool call on a route publishing one. */
export function mayReach(request: UnresolvedTestRequest, route: TestRequestRoute): boolean {
  return request.method === undefined ? route.toolName !== undefined : request.method === route.method.toUpperCase()
}
