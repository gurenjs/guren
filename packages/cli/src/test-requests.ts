/**
 * Which routes the existing tests request (RFC 0030 §2): `TestApp` calls read from each
 * test file's AST, matched against the route graph. A receiver is a `TestApp` only where
 * the file says so (an annotation, a `TestApp.*` factory, a builder on one, a local
 * function annotated to return one), by name within the file, never across files. A path
 * the file does not spell is reported unresolved, never guessed. Route patterns are
 * compared here rather than through the client's hono `TrieRouter`: `@guren/cli` does
 * not depend on hono.
 */

import type { File } from '@babel/types'

import { literalString, memberKeyName, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'
import { toPosixRelative } from './discovery'
import type { ParseCache } from './parse-cache'

/** `TestApp`'s request methods, `.request()` being private; `withCsrf(path = '/')` also GETs its path. */
const REQUEST_METHODS: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE', query: 'QUERY' }
/** Builders that return a `TestApp` (`withCsrf` a promise of one). */
const BUILDERS = new Set(['actingAs', 'json', 'withHeaders', 'withHeader', 'withCsrf'])
const TESTING_PACKAGE = /^@guren\/testing(?:\/|$)/u

/** A path segment the file spells, or one a runtime value fills whole. */
export type TestRequestSegment = { literal: string } | { runtime: true }

export type TestRequestTarget =
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

export type UnresolvedReason = 'dynamicPath' | 'partialSegment' | 'noRoute'

export interface UnresolvedTestRequest extends TestRequestSite {
  reason: UnresolvedReason
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

function typeNamesTestApp(node: BabelNode | undefined, aliases: ReadonlySet<string>): boolean {
  if (!node) return false
  if (node.type === 'TSTypeAnnotation') return typeNamesTestApp(node.typeAnnotation as BabelNode, aliases)
  if (node.type === 'TSUnionType') return (node.types as BabelNode[]).some((type) => typeNamesTestApp(type, aliases))
  if (node.type !== 'TSTypeReference') return false
  const name = node.typeName as BabelNode
  if (name.type !== 'Identifier') return false
  if (aliases.has(name.name as string)) return true
  const params = (node.typeParameters as BabelNode | undefined)?.params as BabelNode[] | undefined
  return name.name === 'Promise' && params?.length === 1 && typeNamesTestApp(params[0], aliases)
}

function testAppAliases(ast: File): Set<string> {
  const aliases = new Set<string>()
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || !TESTING_PACKAGE.test(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue
      const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
      if (imported === 'TestApp') aliases.add(specifier.local.name)
    }
  }
  return aliases
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

interface Receivers {
  aliases: ReadonlySet<string>
  names: Set<string>
  functions: Set<string>
  agents: Set<string>
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
  const object = unwrapTypeAssertion(member.object)
  if (object.type === 'Identifier' && receivers.aliases.has(object.name as string)) return true
  return BUILDERS.has(member.name) && isTestApp(member.object, receivers)
}

function isAgent(value: unknown, receivers: Receivers): boolean {
  const node = unwrapTypeAssertion(value as BabelNode)
  if (node.type === 'Identifier') return receivers.agents.has(node.name as string)
  const member = calleeMember(node)
  return member?.name === 'agent' && isTestApp(member.object, receivers)
}

function returnsTestApp(fn: BabelNode, receivers: Receivers): boolean {
  if (typeNamesTestApp(fn.returnType as BabelNode | undefined, receivers.aliases)) return true
  const body = fn.body as BabelNode
  return fn.type === 'ArrowFunctionExpression' && body.type !== 'BlockStatement' && isTestApp(body, receivers)
}

/** Grows the receiver names to a fixed point, since a binding may be declared before what makes it one. */
function collectReceivers(ast: File, aliases: ReadonlySet<string>): Receivers {
  const receivers: Receivers = { aliases, names: new Set(), functions: new Set(), agents: new Set() }
  const addTo = (set: Set<string>, name: string): boolean => (set.has(name) ? false : (set.add(name), true))
  for (let changed = true; changed;) {
    changed = false
    walk(ast.program, (node) => {
      if (node.type === 'Identifier' && typeNamesTestApp(node.typeAnnotation as BabelNode | undefined, aliases)) {
        changed = addTo(receivers.names, node.name as string) || changed
      } else if (node.type === 'VariableDeclarator' && (node.id as BabelNode).type === 'Identifier') {
        const name = (node.id as BabelNode).name as string
        const init = node.init as BabelNode | null
        if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
          if (returnsTestApp(init, receivers)) changed = addTo(receivers.functions, name) || changed
        } else if (init && isTestApp(init, receivers)) changed = addTo(receivers.names, name) || changed
        else if (init && isAgent(init, receivers)) changed = addTo(receivers.agents, name) || changed
      } else if (node.type === 'AssignmentExpression' && (node.left as BabelNode).type === 'Identifier') {
        if (isTestApp(node.right, receivers)) changed = addTo(receivers.names, (node.left as BabelNode).name as string) || changed
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

/** Stands for a runtime value inside the joined path; a private-use character no route spells. */
const HOLE = '\u{E000}'

/** Segments of the path before any query or fragment, or why they cannot be read. */
export function pathSegments(parts: readonly PathPart[]): TestRequestSegment[] | Exclude<UnresolvedReason, 'noRoute'> {
  const joined = parts.map((part) => (part === RUNTIME ? HOLE : part)).join('')
  const origin = /^https?:\/\/[^/?#]*/u.exec(joined)?.[0] ?? ''
  if (origin.includes(HOLE) || !(joined.startsWith('/') || origin !== '')) return 'dynamicPath'
  const segments: TestRequestSegment[] = []
  for (const segment of (joined.slice(origin.length).split(/[?#]/u)[0] ?? '').split('/')) {
    if (segment === '') continue
    if (!segment.includes(HOLE)) segments.push({ literal: segment })
    else if (segment === HOLE) segments.push({ runtime: true })
    else return 'partialSegment'
  }
  return segments
}

function describePath(method: string, parts: readonly PathPart[]): string {
  return `${method} ${parts.map((part) => (part === RUNTIME ? '${…}' : part)).join('')}`
}

function scanFile(ast: File, file: string, scan: TestRequestScan): void {
  const aliases = testAppAliases(ast)
  if (aliases.size === 0) return
  const receivers = collectReceivers(ast, aliases)
  const constants = stringConstants(ast)

  walk(ast.program, (node) => {
    const member = calleeMember(node)
    if (!member) return
    const args = node.arguments as BabelNode[]
    const { line } = member
    const primes = member.name === 'withCsrf'
    const method = primes ? 'GET' : REQUEST_METHODS[member.name]
    if (method !== undefined && (args.length > 0 || primes) && isTestApp(member.object, receivers)) {
      const parts = args.length === 0 ? ['/'] : pathParts(args[0], constants)
      const text = parts === null ? `${method} <runtime>` : describePath(method, parts)
      const segments = parts === null ? 'dynamicPath' : pathSegments(parts)
      if (typeof segments === 'string') scan.unresolved.push({ file, line, text, reason: segments })
      else scan.requests.push({ file, line, text, target: { kind: 'path', method, segments } })
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

function segmentMatches(pattern: string, segment: TestRequestSegment): boolean {
  if (!pattern.startsWith(':')) return 'literal' in segment && segment.literal === pattern
  if ('runtime' in segment) return true
  const constraint = /\{(.*)\}\??$/u.exec(pattern)
  return constraint === null || new RegExp(`^(?:${constraint[1]})$`, 'u').test(segment.literal)
}

/** Hono's pattern grammar as far as a route path uses it: `:name`, `:name{re}`, an optional last `:name?`, and `*`. */
export function routePathMatches(path: string, segments: readonly TestRequestSegment[]): boolean {
  const patterns = path.split('/').filter((part) => part !== '')
  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index]!
    if (pattern === '*') return true
    const segment = segments[index]
    if (segment === undefined) return index === patterns.length - 1 && pattern.startsWith(':') && pattern.endsWith('?')
    if (!segmentMatches(pattern, segment)) return false
  }
  return segments.length === patterns.length
}

/**
 * The routes a request reaches, as indices into `routes`. Every matching route is listed:
 * a static scan has no registration order to pick hono's first match by.
 */
export function routesReachedBy(request: TestRequest, routes: readonly TestRequestRoute[]): number[] {
  const { target } = request
  const reached: number[] = []
  routes.forEach((route, index) => {
    const hit = target.kind === 'tool'
      ? route.toolName === target.name
      : route.method.toUpperCase() === target.method && routePathMatches(route.path, target.segments)
    if (hit) reached.push(index)
  })
  return reached
}

export interface TestCoverage {
  /** Per route index, the requests that reach it. */
  byRoute: Map<number, TestRequestSite[]>
  /** What the scan could not read, plus a request with a runtime segment that matched no route. */
  unresolved: UnresolvedTestRequest[]
  /** A request the file spells whole that matches no route: a stale test, or a route the graph lacks. */
  unmatched: TestRequestSite[]
}

export function testCoverage(scan: TestRequestScan, routes: readonly TestRequestRoute[]): TestCoverage {
  const coverage: TestCoverage = { byRoute: new Map(), unresolved: [...scan.unresolved], unmatched: [] }
  for (const request of scan.requests) {
    const { target, ...site } = request
    const reached = routesReachedBy(request, routes)
    if (reached.length === 0) {
      const runtime = target.kind === 'path' && target.segments.some((segment) => 'runtime' in segment)
      if (runtime) coverage.unresolved.push({ ...site, reason: 'noRoute' })
      else coverage.unmatched.push(site)
    }
    for (const index of reached) {
      const list = coverage.byRoute.get(index) ?? []
      list.push(site)
      coverage.byRoute.set(index, list)
    }
  }
  return coverage
}
