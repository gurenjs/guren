/**
 * `live()` props (RFC 0037 §7), advisory throughout, content-activated on a
 * controller importing `live` from the framework: no `webSocketMiddleware()`
 * route for a transport to reach, an event a live prop listens for whose wire
 * name is its class name, and `live()` wrapped by `always()` or `defer()`.
 */
import { resolve } from 'node:path'
import type { CallExpression, File, Node } from '@babel/types'
import { memberKeyName, objectLiteral, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'
import { readBroadcastEventClasses, type BroadcastEventClass } from './broadcast-event-classes'
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

async function readEventClasses(cwd: string, cache: ParseCache): Promise<Map<string, BroadcastEventClass>> {
  const classes = new Map<string, BroadcastEventClass>()
  for (const filePath of await discoverAppSourceFiles(cwd)) {
    const parsed = await cache.get(filePath)
    if (parsed) readBroadcastEventClasses(parsed.ast.program.body, toPosixRelative(cwd, filePath), classes)
  }
  return classes
}

/** Whether any route, provider or entry file calls `.webSocketMiddleware(…)`. */
async function mountsSocketRoute(cwd: string, cache: ParseCache): Promise<boolean> {
  const moduleRoutes = await discoverModuleRoutesFiles(cwd)
  const files = [
    ...(await discoverRoutesFiles(cwd)),
    ...moduleRoutes.flatMap((module) => module.files),
    ...(await discoverAppSourceFiles(cwd)),
    ...(await collectFiles(resolve(cwd, 'src'), IMPORTABLE_EXTENSIONS)),
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
  let eventClasses: Promise<Map<string, BroadcastEventClass>> | undefined
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
              `${label} wraps live() in ${helper}(); live() must be the outermost helper, and this throws when the page renders.`,
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
          for (const source of sources) {
            if (source.type !== 'NewExpression' || source.callee.type !== 'Identifier') continue
            const eventName = source.callee.name
            const reading = (await (eventClasses ??= readEventClasses(cwd, cache))).get(eventName)
            if (!reading || reading.pinned) continue
            results.push(advisory(
              `live-props:event-name:${className}.${action}:${eventName}`,
              `${label} live() on ${eventName}`,
              'warn',
              `${label} listens for ${eventName}, which is broadcast under its class name: a production bundle can rename the class (${eventName}2) and the prop then never refreshes.`,
              `Pin the name in ${reading.filePath}: \`static override eventName = '${eventName}'\` on an Event subclass, or a broadcastAs() method.`,
              relPath,
            ))
          }
        }
      }
    }
  }

  if (!activated) return results
  if (await mountsSocketRoute(cwd, cache)) {
    results.push(check('live-props:socket-route', 'live() socket route', 'pass', 'A route mounts broadcast.webSocketMiddleware(), which the live props transport connects to.'))
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
