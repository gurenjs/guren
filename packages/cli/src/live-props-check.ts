/**
 * `live()` props (RFC 0037 §7), advisory throughout, content-activated on a
 * controller importing `live` from the framework: no `webSocketMiddleware()`
 * route for a transport to reach, an event a live prop listens for whose wire
 * name is its class name, and `live()` wrapped by `always()` or `defer()`.
 */
import { dirname, resolve } from 'node:path'
import type { CallExpression, File, Node } from '@babel/types'
import { memberKeyName, objectLiteral, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'
import { BroadcastEventIndex, type BroadcastEventClass } from './broadcast-event-classes'
import { advisory, check, type CheckResult } from './check-result'
import { classActionMembers } from './controller-methods'
import {
  classNameFromPath,
  collectFiles,
  discoverAppSourceFiles,
  IMPORTABLE_EXTENSIONS,
  discoverModuleRoutesFiles,
  discoverRoutesFiles,
  toPosixRelative,
} from './discovery'
import { resolveImportPath } from './import-resolution'
import { extractClassDeclaration } from './model-parser'
import type { ParseCache } from './parse-cache'
import { callsTarget, importBindings } from './plugin-calls'

export interface LivePropsCheckOptions {
  cwd: string
  cache: ParseCache
  /** Controller files, absolute. */
  files: string[]
}

const PROP_HELPER_SPECIFIERS = ['@guren/core', '@guren/server'] as const
const SOCKET_ROUTE_MEMBER = 'webSocketMiddleware'
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

type Bindings = { locals: Set<string>; namespaces: Set<string> }

function helperBindings(ast: File, exportName: string): Bindings {
  const locals = new Set<string>()
  const namespaces = new Set<string>()
  for (const specifier of PROP_HELPER_SPECIFIERS) {
    const found = importBindings(ast, { specifier, exportName })
    for (const local of found.locals) locals.add(local)
    for (const namespace of found.namespaces) namespaces.add(namespace)
  }
  return { locals, namespaces }
}

function calls(node: Node, bindings: Bindings, exportName: string): node is CallExpression {
  return node.type === 'CallExpression' && callsTarget(node, bindings.locals, bindings.namespaces, exportName)
}

/** The `live()` call a deferred callback returns, when its body is that call or a block whose only statement returns it. */
function returnedCall(fn: Node): Node | undefined {
  if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') return undefined
  if (fn.body.type !== 'BlockStatement') return unwrapTypeAssertion(fn.body as Node)
  const [only] = fn.body.body
  return fn.body.body.length === 1 && only?.type === 'ReturnStatement' && only.argument ? unwrapTypeAssertion(only.argument) : undefined
}

/** The `on` sources a `live()` call names, or undefined when the options are not literal enough to read. */
function liveSources(call: CallExpression): Node[] | undefined {
  const options = objectLiteral(call.arguments[1] as Node | undefined)
  if (!options) return undefined
  for (const property of options.properties) {
    if (property.type === 'SpreadElement') return undefined
    if (property.type !== 'ObjectProperty' || memberKeyName({ computed: property.computed, key: property.key }) !== 'on') continue
    const value = unwrapTypeAssertion(property.value as Node)
    if (value.type !== 'ArrayExpression') return [value]
    if (value.elements.some((element) => !element || element.type === 'SpreadElement')) return undefined
    return value.elements.map((element) => unwrapTypeAssertion(element as Node))
  }
  return undefined
}

async function readEventClasses(cwd: string, cache: ParseCache): Promise<BroadcastEventIndex> {
  const index = new BroadcastEventIndex()
  for (const filePath of await discoverAppSourceFiles(cwd)) {
    const parsed = await cache.get(filePath)
    if (parsed) index.add(parsed.ast.program.body, filePath)
  }
  return index
}

/** Each name the file imports, with the module and the name it was exported under. */
function importsOf(ast: File): Map<string, { source: string; imported: string }> {
  const imports = new Map<string, { source: string; imported: string }>()
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration') continue
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue
      const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
      imports.set(specifier.local.name, { source: statement.source.value, imported })
    }
  }
  return imports
}

type EventResolution = { kind: 'class'; reading: BroadcastEventClass } | { kind: 'listener' } | { kind: 'unread'; reason: string }

/**
 * The class a `live()` source constructs, through the controller's own import
 * when two files declare its name; a hand-named `{ event, channel }` needs none.
 */
async function resolveEventSource(
  source: Node,
  context: { cwd: string; filePath: string; imports: Map<string, { source: string; imported: string }>; index: () => Promise<BroadcastEventIndex> },
): Promise<EventResolution> {
  if (source.type === 'ObjectExpression') return { kind: 'listener' }
  if (source.type !== 'NewExpression' || source.callee.type !== 'Identifier') {
    return { kind: 'unread', reason: 'an event that is not written as `new SomeEvent(…)`' }
  }
  const local = source.callee.name
  const imported = context.imports.get(local)
  const name = imported?.imported ?? local
  let candidates = (await context.index()).lookup(name)
  if (candidates.length > 1 && imported && (imported.source.startsWith('.') || imported.source.startsWith('@/'))) {
    const target = imported.source.startsWith('@/')
      ? resolve(context.cwd, imported.source.slice(2))
      : resolve(dirname(context.filePath), imported.source)
    const file = await resolveImportPath(target)
    candidates = candidates.filter((candidate) => candidate.filePath === file)
  }
  if (candidates.length === 1) return { kind: 'class', reading: candidates[0]! }
  if (candidates.length > 1) return { kind: 'unread', reason: `${local}, which more than one file under app/ declares` }
  return { kind: 'unread', reason: `${local}, whose class the check cannot find under app/` }
}

/** Whether any route, provider or entry file calls `.webSocketMiddleware(…)`, tests left out. */
async function mountsSocketRoute(cwd: string, cache: ParseCache): Promise<boolean> {
  const moduleRoutes = await discoverModuleRoutesFiles(cwd)
  const files = [
    ...(await discoverRoutesFiles(cwd)),
    ...moduleRoutes.flatMap((module) => module.files),
    ...(await discoverAppSourceFiles(cwd)),
    ...(await collectFiles(resolve(cwd, 'src'), IMPORTABLE_EXTENSIONS)).filter((file) => !TEST_FILE.test(file)),
  ]
  for (const filePath of new Set(files)) {
    const parsed = await cache.get(filePath)
    if (!parsed) continue
    let found = false
    walk(parsed.ast.program, (node: BabelNode) => {
      if (found) return false
      const callee = node.type === 'CallExpression' ? (node.callee as BabelNode) : undefined
      const property = callee?.type === 'MemberExpression' ? (callee.property as BabelNode) : undefined
      if (property?.type === 'Identifier' && property.name === SOCKET_ROUTE_MEMBER) found = true
    })
    if (found) return true
  }
  return false
}

export async function checkLiveProps(options: LivePropsCheckOptions): Promise<CheckResult[]> {
  const { cwd, cache } = options
  const results: CheckResult[] = []
  let eventClasses: Promise<BroadcastEventIndex> | undefined
  const index = (): Promise<BroadcastEventIndex> => (eventClasses ??= readEventClasses(cwd, cache))
  let activated = false

  for (const filePath of options.files) {
    const parsed = await cache.get(filePath)
    if (!parsed) continue
    const live = helperBindings(parsed.ast, 'live')
    if (live.locals.size === 0 && live.namespaces.size === 0) continue
    activated = true
    const always = helperBindings(parsed.ast, 'always')
    const defer = helperBindings(parsed.ast, 'defer')
    const relPath = toPosixRelative(cwd, filePath)
    const imports = importsOf(parsed.ast)

    for (const statement of parsed.ast.program.body) {
      const declaration = extractClassDeclaration(statement)
      if (!declaration) continue
      const className = declaration.id?.name ?? classNameFromPath(filePath)
      for (const { name: action, body } of classActionMembers(declaration)) {
        const label = `${className}.${action}()`
        const liveCalls: CallExpression[] = []
        walk(body, (node: BabelNode) => {
          const visited = node as unknown as Node
          if (visited.type !== 'CallExpression') return
          const call = visited
          if (calls(call, live, 'live')) liveCalls.push(call)
          const helper = calls(call, always, 'always') ? 'always' : calls(call, defer, 'defer') ? 'defer' : undefined
          const first = call.arguments[0] ? unwrapTypeAssertion(call.arguments[0] as Node) : undefined
          const wrapped = !first ? undefined : helper === 'always' ? first : helper === 'defer' ? returnedCall(first) : undefined
          if (wrapped && calls(wrapped, live, 'live')) {
            const line = call.loc?.start.line ?? 0
            results.push(advisory(
              `live-props:outermost:${className}.${action}:${line}`,
              `${label} live() inside another prop helper`,
              'warn',
              `${label} wraps live() in ${helper}(); live() must be the outermost helper, and this throws ${helper === 'always' ? 'as soon as always() runs' : 'when the deferred prop resolves'}.`,
              'Write live(always(…)) or live(defer(…)) instead.',
              relPath,
            ))
          }
        })

        for (const call of liveCalls) {
          const sources = liveSources(call)
          const line = call.loc?.start.line ?? 0
          if (!sources) {
            results.push(advisory(
              `live-props:unverifiable:${className}.${action}:${line}`,
              `${label} live() events`,
              'warn',
              `${label} passes live() options that are not an object literal with a literal \`on\`, so which events it listens for cannot be read.`,
              'Pass `{ on: new SomeEvent(…) }` (or an array of them) inline so the check can name the events.',
              relPath,
            ))
            continue
          }
          const unread: string[] = []
          for (const source of sources) {
            const resolution = await resolveEventSource(source, { cwd, filePath, imports, index })
            if (resolution.kind === 'listener') continue
            if (resolution.kind === 'unread') {
              unread.push(resolution.reason)
              continue
            }
            const { reading } = resolution
            if (reading.pinned === undefined) {
              unread.push(`${reading.name}, whose base class the check cannot read`)
              continue
            }
            if (reading.pinned) continue
            results.push(advisory(
              `live-props:event-name:${className}.${action}:${reading.name}`,
              `${label} live() on ${reading.name}`,
              'warn',
              `${label} listens for ${reading.name}, which is broadcast under its class name: a production bundle can rename the class (${reading.name}2) and the prop then never refreshes.`,
              `Pin the name in ${toPosixRelative(cwd, reading.filePath)}: \`static override eventName = '${reading.name}'\` on an Event subclass, or a broadcastAs() method.`,
              relPath,
            ))
          }
          if (unread.length > 0) {
            results.push(advisory(
              `live-props:unverifiable:${className}.${action}:${line}`,
              `${label} live() events`,
              'warn',
              `${label} listens for ${unread.join('; ')}, so whether its wire name is pinned cannot be read.`,
              'Pin the event\'s name with `static override eventName` or broadcastAs(), and pass `new SomeEvent(…)` of a class declared under app/.',
              relPath,
            ))
          }
        }
      }
    }
  }

  if (!activated) return results
  if (await mountsSocketRoute(cwd, cache)) {
    results.push(check('live-props:socket-route', 'live() socket route', 'pass', 'A call to webSocketMiddleware(), the route the live props transport connects to, was found.'))
  } else {
    results.push(advisory(
      'live-props:socket-route',
      'live() socket route',
      'warn',
      'A controller uses live(), but no file mounts broadcast.webSocketMiddleware(), so the browser transport has no socket to connect to and live props never refresh.',
      "Mount it on a GET route, e.g. router.get('/broadcasting/socket', broadcast.webSocketMiddleware()), and pass `live: liveTransport()` to startInertiaClient().",
    ))
  }
  return results
}
