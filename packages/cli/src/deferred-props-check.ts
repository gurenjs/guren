/**
 * Deferred Inertia props (`defer()`) against the page's `Props`. `InertiaPropInput`
 * (packages/server/src/mvc/inertia/props.ts) admits `DeferredProp<T>` whatever `T`
 * is, so `posts: defer(() => …)` typechecks against a required `posts: Post[]`, and
 * the initial visit hands the component `undefined`. Advisory throughout: the page
 * is read by shape, and a spread is a key the read cannot see.
 */
import { resolve } from 'node:path'
import type { CallExpression, File, Node, ObjectExpression } from '@babel/types'
import { memberKeyName, objectLiteral, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'
import { advisory, check, type CheckResult } from './check-result'
import { classActionMembers, type ControllerMemberName } from './controller-methods'
import { classNameFromPath, toPosixRelative } from './discovery'
import { inertiaPageIdOf, resolveInertiaPageFile } from './inertia-pages'
import { extractClassDeclaration } from './model-parser'
import { pagePropMember, readPagePropMembers, type PagePropMembers } from './page-props-extractor'
import type { ParseCache } from './parse-cache'
import { callsTarget, importBindings } from './plugin-calls'

export interface DeferredPropsCheckOptions {
  cwd: string
  cache: ParseCache
  /** Controller files, absolute. */
  files: string[]
}

/** Where `defer` and `always` come from: the server root and the core facade that re-exports it. */
const PROP_HELPER_SPECIFIERS = ['@guren/core', '@guren/server'] as const
const INERTIA_MEMBER: ControllerMemberName = 'inertia'

type Bindings = ReturnType<typeof importBindings>

interface PropHelperBindings {
  defer: Bindings
  always: Bindings
}

function propHelperBindings(ast: File): PropHelperBindings {
  const merged = (exportName: string): Bindings => {
    const locals = new Set<string>()
    const namespaces = new Set<string>()
    for (const specifier of PROP_HELPER_SPECIFIERS) {
      const found = importBindings(ast, { specifier, exportName })
      for (const local of found.locals) locals.add(local)
      for (const namespace of found.namespaces) namespaces.add(namespace)
    }
    return { locals, namespaces }
  }
  return { defer: merged('defer'), always: merged('always') }
}

/** `defer(…)`, or `always(defer(…))`, which the runtime announces as deferred too. */
function isDeferCall(node: Node, bindings: PropHelperBindings): boolean {
  const value = unwrapTypeAssertion(node)
  if (value.type !== 'CallExpression') return false
  if (callsTarget(value, bindings.defer.locals, bindings.defer.namespaces, 'defer')) return true
  const wrapped = value.arguments[0]
  return (
    wrapped !== undefined
    && callsTarget(value, bindings.always.locals, bindings.always.namespaces, 'always')
    && isDeferCall(wrapped as Node, bindings)
  )
}

function inertiaCall(node: BabelNode): CallExpression | undefined {
  if (node.type !== 'CallExpression') return undefined
  const call = node as unknown as CallExpression
  const { callee } = call
  const ours =
    callee.type === 'MemberExpression'
    && !callee.computed
    && callee.object.type === 'ThisExpression'
    && callee.property.type === 'Identifier'
    && callee.property.name === INERTIA_MEMBER
  return ours ? call : undefined
}

interface PropsReading {
  /** Keys whose value is a `defer(...)` call. */
  deferred: string[]
  /** A spread or a computed key carrying `defer(...)`: keys the read cannot name. */
  hidden: boolean
}

function readProps(props: ObjectExpression, bindings: PropHelperBindings): PropsReading {
  const deferred: string[] = []
  let hidden = false
  for (const property of props.properties) {
    if (property.type === 'SpreadElement') {
      hidden = true
      continue
    }
    if (property.type !== 'ObjectProperty' || !isDeferCall(property.value, bindings)) continue
    const name = memberKeyName(property)
    if (name === undefined) hidden = true
    else deferred.push(name)
  }
  return { deferred, hidden }
}

interface ActionScan {
  className: string
  action: string
  calls: CallExpression[]
  /** Whether the action body calls `defer` anywhere, the evidence for a props argument the read cannot open. */
  defers: boolean
}

/** Every action of the file's classes, with its `this.inertia(…)` calls. */
function scanActions(ast: File, filePath: string, bindings: PropHelperBindings): ActionScan[] {
  const scans: ActionScan[] = []
  for (const statement of ast.program.body) {
    const classDecl = extractClassDeclaration(statement)
    if (!classDecl) continue
    const className = classDecl.id?.name ?? classNameFromPath(filePath)
    for (const { name: action, body } of classActionMembers(classDecl)) {
      const scan: ActionScan = { className, action, calls: [], defers: false }
      walk(body, (node) => {
        const call = inertiaCall(node)
        if (call) scan.calls.push(call)
        else if (isDeferCall(node as unknown as Node, bindings)) scan.defers = true
      })
      scans.push(scan)
    }
  }
  return scans
}

interface PageReading {
  /** Component file, relative to the app root. */
  filePath: string
  /** Undefined when the page does not parse. */
  members?: PagePropMembers
}

export async function checkDeferredProps(options: DeferredPropsCheckOptions): Promise<CheckResult[]> {
  const { cwd, cache } = options
  const results: CheckResult[] = []
  // Two `this.inertia()` calls in one action may judge the same page key twice; the verdict is the same.
  const reported = new Set<string>()
  const report = (result: CheckResult): void => {
    if (!reported.has(result.key)) results.push(result)
    reported.add(result.key)
  }

  // One page-file probe and one Props reading per page id per run.
  const pages = new Map<string, Promise<PageReading | null>>()
  const readPage = (pageId: string): Promise<PageReading | null> => {
    let pending = pages.get(pageId)
    if (!pending) {
      pending = (async () => {
        const filePath = await resolveInertiaPageFile(cwd, pageId)
        if (!filePath) return null
        const parsed = await cache.get(resolve(cwd, filePath))
        return { filePath, ...(parsed ? { members: readPagePropMembers(parsed.ast, parsed.source) } : {}) }
      })()
      pages.set(pageId, pending)
    }
    return pending
  }

  for (const filePath of options.files) {
    const parsed = await cache.get(filePath)
    if (!parsed) continue
    const bindings = propHelperBindings(parsed.ast)
    if (bindings.defer.locals.size === 0 && bindings.defer.namespaces.size === 0) continue

    const relPath = toPosixRelative(cwd, filePath)
    for (const { className, action, calls, defers } of scanActions(parsed.ast, filePath, bindings)) {
      const label = `${className}.${action}()`
      for (const call of calls) {
        const [pageArg, propsArg] = call.arguments
        if (!pageArg || !propsArg) continue
        const pageId = inertiaPageIdOf(pageArg as Node)
        const pageLabel = pageId ? `page '${pageId}'` : 'the page'
        const unverifiable = (message: string, suggestion: string): void =>
          report(advisory(`deferred-props:${className}.${action}:${call.loc?.start.line ?? 0}`, `${label} deferred props`, 'warn', message, suggestion, relPath))

        const props = objectLiteral(propsArg as Node)
        if (!props) {
          if (defers) {
            unverifiable(
              `${label} calls defer() but passes ${pageLabel} props that are not an object literal, so which of them are deferred cannot be read.`,
              'Pass an object literal to this.inertia(), or confirm by hand that every deferred prop is optional in the page\'s Props.',
            )
          }
          continue
        }

        const reading = readProps(props, bindings)
        if (reading.deferred.length === 0 && !reading.hidden) continue

        if (pageId === undefined) {
          unverifiable(
            `${label} passes deferred props to a page that is neither a pages.* reference nor a string literal, so its Props cannot be looked up.`,
            'Reference the page as pages.<dir>.<Name> so the check can read its Props.',
          )
          continue
        }

        if (reading.hidden) {
          unverifiable(
            `${label} spreads into the props of ${pageLabel} (or defers a computed key), so a deferred prop there cannot be checked against the page's Props.`,
            'Write each deferred prop as a literal key so the check can name it, or confirm by hand that it is optional in the page\'s Props.',
          )
        }

        // A missing page is the page-existence check's finding.
        const page = await readPage(pageId)
        if (!page) continue
        for (const key of reading.deferred) {
          const finding = judgeDeferredKey(page, pageId, key, `${className}.${action}`, relPath)
          if (finding) report(finding)
        }
      }
    }
  }

  return results
}

/**
 * One deferred key against the page: a warn when the page requires it, a pass when
 * it admits undefined, an advisory when the page's Props cannot be read, and nothing
 * for a page with no Props or none naming the key (nothing there to contradict).
 */
function judgeDeferredKey(page: PageReading, pageId: string, key: string, actionName: string, relPath: string): CheckResult | undefined {
  const member = page.members
    ? pagePropMember(page.members, key)
    : { status: 'unreadable' as const, reason: 'the page does not parse' }
  if (member.status === 'undeclared' || member.status === 'absent') return undefined

  const resultKey = `deferred-prop:${actionName}:${pageId}:${key}`
  const title = `${actionName}() defer('${key}')`
  const label = `${actionName}()`

  if (member.status === 'unreadable') {
    return advisory(
      resultKey,
      title,
      'warn',
      `${label} passes defer() for '${key}', but whether ${page.filePath} declares it optional cannot be read: ${member.reason}.`,
      `Declare '${key}' on the page's own Props, optional (\`${key}?: …\`), since the initial visit sends no value for it.`,
      relPath,
    )
  }

  const type = member.type ?? 'any'
  if (member.acceptsUndefined) {
    return check(
      resultKey,
      title,
      'pass',
      `${label} defers '${key}', which ${page.filePath} declares as ${member.optional ? 'optional' : `\`${type}\``}.`,
      undefined,
      relPath,
    )
  }

  return advisory(
    resultKey,
    title,
    'warn',
    `${label} passes defer() for '${key}', but ${page.filePath} declares \`${key}: ${type}\` as required; on the initial visit the page receives undefined.`,
    `Declare it optional in Props (\`${key}?: ${type}\`) and render it through <Deferred>, or pass the value directly instead of defer().`,
    relPath,
  )
}
