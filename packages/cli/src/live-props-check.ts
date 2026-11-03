/**
 * `live()` props (RFC 0037 §7), advisory throughout, content-activated on a
 * controller importing `live` from the framework: no `webSocketMiddleware()`
 * route for a transport to reach, an event a live prop listens for whose wire
 * name is its class name, and `live()` wrapped by `always()` or `defer()`.
 */
import { readFile } from 'node:fs/promises'
import type { CallExpression, Node } from '@babel/types'
import { memberKeyName, objectLiteral, soleReturnedValue, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'
import { BroadcastEventIndex, type BroadcastEventLookup } from './broadcast-event-classes'
import { advisory, check, type CheckResult } from './check-result'
import { classActionMembers } from './controller-methods'
import { propHelperBindings } from './deferred-props-check'
import { applicationSources, classNameFromPath, discoverAppSourceFiles, toPosixRelative } from './discovery'
import { extractClassDeclaration } from './model-parser'
import type { ParseCache } from './parse-cache'
import { callsTarget } from './plugin-calls'

export interface LivePropsCheckOptions {
  cwd: string
  cache: ParseCache
  /** Controller files, absolute. */
  files: string[]
}

const SOCKET_ROUTE_MEMBER = 'webSocketMiddleware'

type Bindings = { locals: Set<string>; namespaces: Set<string> }

function calls(node: Node, bindings: Bindings, exportName: string): node is CallExpression {
  return node.type === 'CallExpression' && callsTarget(node, bindings.locals, bindings.namespaces, exportName)
}

/** The `live()` call a deferred callback returns. */
function returnedCall(fn: Node): Node | undefined {
  return fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression' ? soleReturnedValue(fn.body) : undefined
}

/** The `on` sources a `live()` call names, or undefined when the options are not literal enough to read. */
function liveSources(call: CallExpression): Node[] | undefined {
  const options = objectLiteral(call.arguments[1] as Node | undefined)
  // A spread anywhere can replace `on`, before or after it.
  if (!options || options.properties.some((property) => property.type === 'SpreadElement')) return undefined
  const on = options.properties.find((property) => property.type === 'ObjectProperty' && memberKeyName(property) === 'on')
  if (on?.type !== 'ObjectProperty') return undefined
  const value = unwrapTypeAssertion(on.value as Node)
  if (value.type !== 'ArrayExpression') return [value]
  if (value.elements.some((element) => !element || element.type === 'SpreadElement')) return undefined
  return value.elements.map((element) => unwrapTypeAssertion(element as Node))
}

async function readEventClasses(cwd: string, cache: ParseCache): Promise<BroadcastEventIndex> {
  const index = new BroadcastEventIndex(cwd)
  const files = await discoverAppSourceFiles(cwd)
  const parsed = await Promise.all(files.map((filePath) => cache.get(filePath)))
  for (const [i, file] of parsed.entries()) {
    if (file) index.add(file.ast.program.body, files[i]!)
  }
  return index
}

/** A hand-named `{ event, channel }` needs no class; anything else must be `new SomeEvent(…)`. */
async function resolveEventSource(source: Node, filePath: string, index: BroadcastEventIndex): Promise<BroadcastEventLookup | undefined> {
  if (source.type === 'ObjectExpression') return undefined
  if (source.type !== 'NewExpression' || source.callee.type !== 'Identifier') {
    return { kind: 'unread', reason: 'an event that is not written as `new SomeEvent(…)`' }
  }
  return index.constructed(source.callee.name, filePath)
}

/** Whether any server source (tests left out) calls `webSocketMiddleware(…)`, as a member or bare. */
async function mountsSocketRoute(cwd: string, cache: ParseCache): Promise<boolean> {
  const files = await applicationSources(cwd)
  const sources = await Promise.all(files.map((filePath) => readFile(filePath, 'utf8').catch(() => '')))
  for (const [i, source] of sources.entries()) {
    // Parsing only what can match: most server files never name it.
    if (!source.includes(SOCKET_ROUTE_MEMBER)) continue
    const parsed = await cache.get(files[i]!)
    if (!parsed) continue
    let found = false
    walk(parsed.ast.program, (node: BabelNode) => {
      if (found) return false
      const callee = node.type === 'CallExpression' ? (node.callee as BabelNode) : undefined
      const name = callee?.type === 'MemberExpression' ? (callee.property as BabelNode) : callee
      if (name?.type === 'Identifier' && name.name === SOCKET_ROUTE_MEMBER) found = true
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
    const { live, always, defer } = propHelperBindings(parsed.ast)
    if (live.locals.size === 0 && live.namespaces.size === 0) continue
    activated = true
    const relPath = toPosixRelative(cwd, filePath)

    for (const statement of parsed.ast.program.body) {
      const declaration = extractClassDeclaration(statement)
      if (!declaration) continue
      const className = declaration.id?.name ?? classNameFromPath(filePath)
      for (const { name: action, body } of classActionMembers(declaration)) {
        const label = `${className}.${action}()`
        const liveCalls: CallExpression[] = []
        walk(body, (node: BabelNode) => {
          const call = node as unknown as Node
          if (call.type !== 'CallExpression') return
          if (calls(call, live, 'live')) liveCalls.push(call)
          const helper = calls(call, always, 'always') ? 'always' : calls(call, defer, 'defer') ? 'defer' : undefined
          const first = helper && call.arguments[0] ? unwrapTypeAssertion(call.arguments[0] as Node) : undefined
          const wrapped = first && (helper === 'always' ? first : returnedCall(first))
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
          const unread: string[] = sources ? [] : ['options that are not an object literal with a literal `on` and no spread']
          const events = await index()
          for (const source of sources ?? []) {
            const resolution = await resolveEventSource(source, filePath, events)
            if (!resolution) continue
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
              `${label} passes ${unread.join('; ')}, so whether each event's wire name is pinned cannot be read.`,
              'Pass `{ on: new SomeEvent(…) }` (or an array of them) inline, of a class declared under app/, and pin its name with `static override eventName` or broadcastAs().',
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
