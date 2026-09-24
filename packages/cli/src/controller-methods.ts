import { relative, sep } from 'node:path'
import type {
  BlockStatement,
  ClassDeclaration,
  ClassMethod,
  ClassProperty,
  Expression,
  File,
  Statement,
} from '@babel/types'
import type { AppManifest, ControllerRef, RouteEntry } from '@guren/server'
import { classNameFromPath, discoverControllerFiles, toPosixRelative } from './discovery'
import { extractClassDeclaration } from './model-parser'
import { ParseCache } from './parse-cache'
import { memberKeyName, walk } from './ast-walk'
import { controllerImportFailures } from './introspect-controller-file'
import { introspectedRoutes, type IntrospectSource } from './manifest-section'
import { specifierName } from './route-registrar'
import { escapeRegExp } from './utils'

/**
 * Controller action bodies, extracted once and judged by regex afterwards. Lives
 * here rather than in `audit.ts` because `guren audit` and `guren check`'s agent-route
 * rules ask the same question of the same bodies, and importing `./audit` would drag
 * its dependency and ignore-config machinery into every `guren check` run. Only patterns
 * spelling a `Controller` member name from this module are pinned by `controller-surface.test.ts`.
 */
export interface ControllerMethodInfo {
  /** Method body source with comments and string contents blanked, offsets preserved. */
  body: string
  /** The same span as written, for what blanking removes, such as a page name in a string. */
  rawBody: string
  /** Controller file, relative to the project root. */
  filePath: string
}

/**
 * Two controller classes sharing one name. Reported rather than resolved:
 * routes carry `route.controller.name` alone — see {@link parseControllerMethods}.
 */
export interface ControllerNameCollision {
  className: string
  previousFile: string
  currentFile: string
}

/** One controller class as a file declares it, same-named classes in other files included. */
export interface ControllerDeclaration {
  className: string
  /** POSIX-relative to the project root, the form a manifest `ControllerRef.file` takes. */
  file: string
  /** Every name the file exports the class under: its own, `default`, an `export { X as Y }` alias. */
  exportNames: string[]
  /** Action name → body. */
  methods: Map<string, ControllerMethodInfo>
}

export interface ControllerMethodScan {
  /** `ClassName.method` → body. Last file scanned wins on a collision. */
  methods: Map<string, ControllerMethodInfo>
  /**
   * `file#export` → the class (RFC 0026 §5), one entry per export name: what a route whose
   * `ControllerRef` resolved by identity is judged against, so no collision can reach it.
   */
  byExport: Map<string, ControllerDeclaration>
  /** Every class every controller file declares, in scan order; `methods` keeps only the last of a name. */
  declarations: ControllerDeclaration[]
  /** Every same-named pair. A consumer reports only those a route reached by name ({@link collisionsReachedByName}). */
  collisions: ControllerNameCollision[]
  /**
   * Controller files that could not be read at all. Their actions are absent
   * from `methods`, so a route naming one must take a could-not-verify path
   * rather than a confident verdict.
   */
  unreadableFiles: string[]
  /** Controller files that were read but did not parse; like `unreadableFiles`, their actions are absent. */
  unparsedFiles: string[]
  /** Class name → the file declaring it, last file scanned winning like `methods`. */
  classFiles: Map<string, string>
}

/**
 * The scan an app contributes when there is nothing to scan, shared so that
 * "we skipped the scan" and "the scan found nothing" stay the same shape.
 */
export const EMPTY_CONTROLLER_SCAN: ControllerMethodScan = {
  methods: new Map(),
  byExport: new Map(),
  declarations: [],
  collisions: [],
  unreadableFiles: [],
  unparsedFiles: [],
  classFiles: new Map(),
}

/**
 * What request data each member of `Controller` hands an action. The keys must be
 * the full public/protected surface of `packages/server/src/mvc/Controller.ts`;
 * `controller-surface.test.ts` fails when the two diverge, so a new accessor cannot
 * quietly default to "harmless" here. The patterns below assume call syntax, so a
 * body-reading *getter* needs the pattern touched too, not just an entry here.
 */
export type ControllerMemberKind =
  /**
   * Hands back request-body content nothing has validated. `file()`/`files()`
   * belong here because they are `req.parseBody()` under the hood: a helper
   * cannot be a clean pass while the call it delegates to is a failure.
   */
  | 'body-payload'
  /**
   * Reads the body but yields nothing a schema would have caught (`has()`).
   * Not flagged, but not "does not consume the request body" either.
   */
  | 'body-incidental'
  /** Reads the body in order to validate it — the remedy, not the problem. */
  | 'body-validation'
  | 'non-body'

export const CONTROLLER_MEMBER_KINDS = {
  input: 'body-payload',
  only: 'body-payload',
  except: 'body-payload',
  file: 'body-payload',
  files: 'body-payload',

  has: 'body-incidental',

  validateBody: 'body-validation',
  validateBodySafe: 'body-validation',

  setContext: 'non-body',
  setContainer: 'non-body',
  setResolvedModel: 'non-body',
  model: 'non-body',
  ctx: 'non-body',
  /** Reached by name through RAW_BODY_READ_PATTERN, not as `this.request(`. */
  request: 'non-body',
  auth: 'non-body',
  make: 'non-body',
  apiToken: 'non-body',
  apiTokenUserId: 'non-body',
  authorize: 'non-body',
  can: 'non-body',
  inertia: 'non-body',
  view: 'non-body',
  locale: 'non-body',
  t: 'non-body',
  tc: 'non-body',
  json: 'non-body',
  text: 'non-body',
  redirect: 'non-body',
  noContent: 'non-body',
  created: 'non-body',
  accepted: 'non-body',
  query: 'non-body',
  validateQuery: 'non-body',
  validateParams: 'non-body',
  validateQuerySafe: 'non-body',
  validateParamsSafe: 'non-body',
  /** Returns what the route contract middleware already validated; reads no body itself. */
  validated: 'non-body',
} as const satisfies Readonly<Record<string, ControllerMemberKind>>

/**
 * A member name the classification above knows. Spelling a pattern through this
 * type is what makes the surface test protect it: a rename in `Controller.ts`
 * then fails to compile instead of silently matching nothing.
 */
export type ControllerMemberName = keyof typeof CONTROLLER_MEMBER_KINDS

export function controllerMembers(kind: ControllerMemberKind): string[] {
  return Object.entries(CONTROLLER_MEMBER_KINDS)
    .filter(([, memberKind]) => memberKind === kind)
    .map(([name]) => name)
}

/**
 * `name(`, plus the generic forms these helpers are declared with. `[^()]*`
 * rather than `[^>]*`, so a nested type argument still reaches the closing `(`.
 * Longest name first so `validateBody` cannot shadow `validateBodySafe`.
 */
export function accessorCallPattern(names: readonly string[]): string {
  const alternation = [...names].sort((a, b) => b.length - a.length).join('|')
  return `\\b(?:${alternation})\\s*(?:<[^()]*>)?\\s*\\(`
}

/**
 * `this.<member>(`. `this.` is required because the members are `protected`:
 * a call through anything else is a different API.
 */
function controllerMemberCall(...names: ControllerMemberName[]): RegExp {
  return new RegExp(`\\bthis\\s*\\.\\s*${accessorCallPattern(names)}`)
}

/**
 * Calls that actually reject unauthenticated requests. Optional reads
 * (`auth.user()`, `auth.id()`, `auth.check()`) enforce nothing, so they do not
 * count as protection. The `apiToken` half is required for agent-facing rules:
 * a bearer token is the auth path an agent uses.
 */
export const AUTH_CALL_PATTERN = new RegExp(
  `\\bauth\\s*\\.\\s*userOrFail\\s*(?:<[^>]*>)?\\s*\\(|${
    controllerMemberCall('apiToken', 'apiTokenUserId').source}`,
)

/**
 * `this.authorize(...)` — the call that throws a 403. `this.can(...)` is
 * excluded: it returns a boolean and enforces nothing.
 */
export const AUTHORIZE_CALL_PATTERN = controllerMemberCall('authorize')

/** An Inertia page response, which carries no JSON schema an agent could read. */
export const INERTIA_CALL_PATTERN = controllerMemberCall('inertia')

/** `this.auth.<method><…typeName…>(`: a record type passed as a type argument of an auth call. */
export function authTypeArgumentPattern(typeName: string): RegExp {
  const member: ControllerMemberName = 'auth'
  const name = `(?<![\\w$.])${escapeRegExp(typeName)}(?![\\w$])`
  return new RegExp(`\\bthis\\s*\\.\\s*${member}\\s*\\.\\s*\\w+\\s*<[^()]*${name}[^()]*>\\s*\\(`)
}

/**
 * A call to one of `names` on a model, in its two shapes: a static on the class
 * (PascalCase receiver) and a terminated query chain (call follows a closing
 * paren) — the discipline `MODEL_ATTACH_PATTERN` in audit.ts also applies.
 * Without it every `map.delete(key)` would read as a database write.
 */
function modelCallPattern(...names: string[]): RegExp {
  const alternation = names.join('|')
  return new RegExp(
    `\\b[A-Z][A-Za-z0-9_]*\\s*\\.\\s*(?:${alternation})\\s*\\(`
    + `|\\)\\s*\\.\\s*(?:${alternation})\\s*\\(`,
  )
}

/** A record deletion, for the annotation-honesty rules (RFC 0016 §5.5). */
export const DELETE_CALL_PATTERN = modelCallPattern('delete', 'forceDelete')

const UPDATE_CALL_PATTERN = modelCallPattern('update')

/**
 * A write that bypasses mass-assignment protection, counted as state change by
 * the audit's force-write heuristic and the agent-route annotation rules. Looser
 * than {@link modelCallPattern} — any receiver will do — because `forceCreate`/`forceUpdate`
 * are ORM names distinctive enough not to collide, where `update` and `delete` plainly
 * are. A receiver is still required: the bare name also matches a *declaration*.
 */
export const FORCE_WRITE_PATTERN = /\.\s*force(?:Create|Update)\s*\(/

/**
 * Whether an action body shows it changes stored records. The one rule behind
 * both annotation-honesty checks (`guren audit`'s `destructiveHint: false` and
 * `guren check`'s `readOnlyHint: true`), which must not disagree about what counts
 * as a mutation. Deliberately narrow: an honesty rule accuses an author of a false
 * declaration, so it fires only on unambiguous shapes.
 */
export function mutatesRecords(body: string): boolean {
  return (
    DELETE_CALL_PATTERN.test(body)
    || UPDATE_CALL_PATTERN.test(body)
    || FORCE_WRITE_PATTERN.test(body)
  )
}

/**
 * A Model write in an in-process agent's local tool (RFC 0029 §2.4): the calls
 * the RFC names plus the force writes. Separate from {@link mutatesRecords},
 * which `readOnlyHint` honesty shares and must stay narrow. `.save(` takes any
 * receiver, since it is called on an instance.
 */
export const LOCAL_TOOL_WRITE_PATTERN = new RegExp(
  `${modelCallPattern('create', 'update', 'delete', 'forceDelete').source}`
  + `|${FORCE_WRITE_PATTERN.source}|\\.\\s*save\\s*\\(`,
)

/**
 * Blanks with spaces everything the body regexes must not read as live code:
 * comments, string/regex/JSX-text contents, template quasis, and whole
 * type-alias/interface declarations (TS allows them inside a function, and their
 * member signatures read exactly like a runtime call). Offsets are preserved so
 * body slices still line up with AST positions. Template *expressions* are live code, kept.
 */
export function blankCommentsAndStrings(source: string, ast: File): string {
  const ranges: [number, number][] = []
  for (const comment of ast.comments ?? []) {
    if (typeof comment.start === 'number' && typeof comment.end === 'number') {
      ranges.push([comment.start, comment.end])
    }
  }
  walk(ast.program, (node) => {
    const { type, start, end } = node
    if (typeof start !== 'number' || typeof end !== 'number') return
    if (type === 'StringLiteral' || type === 'DirectiveLiteral') {
      ranges.push([start + 1, end - 1])
    } else if (type === 'TemplateElement' || type === 'RegExpLiteral' || type === 'JSXText') {
      ranges.push([start, end])
    } else if (type === 'TSTypeAliasDeclaration' || type === 'TSInterfaceDeclaration') {
      ranges.push([start, end])
      return false
    }
  })
  if (ranges.length === 0) return source

  // split('') keeps UTF-16 code-unit indexing — Babel offsets are code units,
  // and a code-point spread would shift everything after an astral character.
  const chars = source.split('')
  for (const [start, end] of ranges) {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' '
    }
  }
  return chars.join('')
}

/**
 * Map of `ClassName.method` → method body source, for every controller in
 * app/Http/Controllers (module-aware — see discoverControllerFiles). Keyed by
 * class name alone, because routes carry only `route.controller.name`: two modules
 * can each scaffold a `PostController`, and then verdicts for BOTH come from whichever
 * file was discovered last. Collisions are returned, not resolved; dropping them silently is fail-open.
 */
export async function parseControllerMethods(
  cwd: string,
  cache?: ParseCache,
): Promise<ControllerMethodScan> {
  const methods = new Map<string, ControllerMethodInfo>()
  const byExport = new Map<string, ControllerDeclaration>()
  const declarations: ControllerDeclaration[] = []
  const collisions: ControllerNameCollision[] = []
  const unreadableFiles: string[] = []
  const unparsedFiles: string[] = []
  const classFiles = new Map<string, string>()
  const controllerFiles = await discoverControllerFiles(cwd)

  // Every read goes through a cache, given one or not: it is what turns an
  // unreadable file into a reported outcome rather than a rejected promise.
  const parseCache = cache ?? new ParseCache()

  for (const filePath of controllerFiles) {
    const relPath = relative(cwd, filePath)
    const posixPath = toPosixRelative(cwd, filePath)
    const outcome = await parseCache.read(filePath)

    if (outcome.status === 'unreadable') {
      unreadableFiles.push(relPath)
      continue
    }
    if (outcome.status !== 'parsed') {
      unparsedFiles.push(relPath)
      continue
    }

    const { source, ast } = outcome
    const scrubbed = blankCommentsAndStrings(source, ast)
    const exportNamesOf = classExportNames(ast.program.body)

    for (const node of ast.program.body) {
      const classDecl = extractClassDeclaration(node)
      if (!classDecl) continue
      const className = classDecl.id?.name ?? classNameFromPath(filePath)

      const previousFile = classFiles.get(className)
      if (previousFile && previousFile !== relPath) {
        collisions.push({ className, previousFile, currentFile: relPath })
      }
      classFiles.set(className, relPath)

      const exportNames = exportNamesOf(node, classDecl)
      const declaration: ControllerDeclaration = { className, file: posixPath, exportNames, methods: new Map() }
      declarations.push(declaration)
      for (const exportName of exportNames) byExport.set(`${posixPath}#${exportName}`, declaration)

      for (const { name, body } of classActionMembers(classDecl)) {
        const info: ControllerMethodInfo = {
          body: scrubbed.slice(body.start ?? 0, body.end ?? 0),
          rawBody: source.slice(body.start ?? 0, body.end ?? 0),
          filePath: relPath,
        }
        declaration.methods.set(name, info)
        methods.set(`${className}.${name}`, info)
      }
    }
  }

  return { methods, byExport, declarations, collisions, unreadableFiles, unparsedFiles, classFiles }
}

/**
 * The names a file exports each of its classes under, read the way the introspection
 * child sees them (`Object.entries` of the module): `export class X`, `export default
 * class`, `export default X` and `export { X as Y }`. A re-export from another file
 * names that file's class and is left out.
 */
function classExportNames(body: Statement[]): (node: Statement, classDecl: ClassDeclaration) => string[] {
  const aliases = new Map<string, string[]>()
  const add = (local: string, exported: string): void => {
    aliases.set(local, [...(aliases.get(local) ?? []), exported])
  }
  for (const node of body) {
    if (node.type === 'ExportDefaultDeclaration' && node.declaration.type === 'Identifier') {
      add(node.declaration.name, 'default')
    }
    if (node.type !== 'ExportNamedDeclaration' || node.source) continue
    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ExportSpecifier') continue
      add(specifier.local.name, specifierName(specifier.exported))
    }
  }

  return (node, classDecl) => {
    const names = classDecl.id ? [...(aliases.get(classDecl.id.name) ?? [])] : []
    if (node.type === 'ExportDefaultDeclaration') names.push('default')
    else if (node.type === 'ExportNamedDeclaration' && classDecl.id) names.push(classDecl.id.name)
    return [...new Set(names)]
  }
}

/**
 * What a route names its action by: a registered definition's `{ name, action }`,
 * or a manifest `ControllerRef`, which may also carry the class's file and export.
 */
export type ControllerTarget = { name: string; action: string } & Partial<Pick<ControllerRef, 'file' | 'exportName' | 'resolved'>> & {
  /**
   * On a manifest's reference only: the controller files the introspection child could not
   * import (`controller-import`), where a class it left `name-only` may still be declared.
   */
  unimported?: readonly string[]
}

export interface ControllerMethodLookup {
  info: ControllerMethodInfo | undefined
  /**
   * `identity` when the body was found through the class's file and export, so no
   * same-named class can stand in for it; `elsewhere` when the manifest shows the routed
   * class is none of the scanned declarations of its name, so it has no body here;
   * `name` when only the class name was followed, which a collision makes unreliable.
   */
  by: 'identity' | 'elsewhere' | 'name'
  /** The class as the scan names it: an anonymous default export by its file, not as `default`. */
  className: string
}

/**
 * The one lookup of a route's action body (RFC 0026 §5): an `identity` reference reads its own file,
 * one the scan cannot place (a re-export the child picked) follows the name. A `name-only` one matched
 * no export of a file the child imported (all of them while an app class is unmatched; a framework
 * class never matches), so a same-named declaration there is another class, declared `elsewhere`.
 */
export function controllerMethodFor(scan: ControllerMethodScan, controller: ControllerTarget): ControllerMethodLookup {
  const { file, exportName, unimported } = controller
  if (controller.resolved === 'identity' && file && exportName) {
    // A placed class without the action (inherited, or missing) has no body, nor does one whose
    // file would not read or parse: another class's body is no answer either way.
    const declaration = scan.byExport.get(`${file}#${exportName}`)
    if (declaration) return { info: declaration.methods.get(controller.action), by: 'identity', className: declaration.className }
    if ([...scan.unreadableFiles, ...scan.unparsedFiles].some((skipped) => skipped.split(sep).join('/') === file)) {
      return { info: undefined, by: 'identity', className: controller.name }
    }
  }
  if (controller.resolved === 'name-only' && unimported) {
    const sameName = scan.declarations.filter((declaration) => declaration.className === controller.name)
    if (sameName.length > 0 && sameName.every((declaration) => !unimported.includes(declaration.file))) {
      return { info: undefined, by: 'elsewhere', className: controller.name }
    }
  }
  return { info: scan.methods.get(`${controller.name}.${controller.action}`), by: 'name', className: controller.name }
}

/**
 * The manifest's routes with each controller as the lookup takes it: a `name-only` reference
 * carries the files the child could not import, where its class may still be declared.
 */
export function manifestRouteTargets(manifest: Pick<AppManifest, 'routes' | 'warnings'>): Array<RouteEntry & { controller?: ControllerTarget }> {
  const unimported = controllerImportFailures(manifest)
  return manifest.routes.map((route) =>
    route.controller?.resolved === 'name-only' ? { ...route, controller: { ...route.controller, unimported } } : route)
}

/** The collisions a verdict could have read through: those on a class some route reached by its name alone. */
export function collisionsReachedByName(
  scan: ControllerMethodScan,
  controllers: Iterable<ControllerTarget>,
): ControllerNameCollision[] {
  if (scan.collisions.length === 0) return []
  const byName = new Set<string>()
  for (const controller of controllers) {
    if (controllerMethodFor(scan, controller).by === 'name') byName.add(controller.name)
  }
  return scan.collisions.filter((collision) => byName.has(collision.className))
}

/**
 * Registered definitions with each controller replaced by the manifest's reference
 * for the same route, matched on method, path, class name and action. The manifest
 * lists the whole app's routes, which the routes file alone may not, and in its own
 * order, so a route matched more than once keeps its name-only controller.
 */
export function attachControllerRefs<T extends { method: string; path: string; controller?: { name: string; action: string } }>(
  definitions: T[],
  manifest: Pick<AppManifest, 'routes' | 'warnings'>,
): T[] {
  const refs = new Map<string, ControllerTarget | null>()
  for (const route of manifestRouteTargets(manifest)) {
    if (!route.controller) continue
    const key = routeControllerKey(route, route.controller)
    refs.set(key, refs.has(key) ? null : route.controller)
  }
  return definitions.map((definition) => {
    const ref = definition.controller && refs.get(routeControllerKey(definition, definition.controller))
    return ref ? { ...definition, controller: ref } : definition
  })
}

/**
 * Registered definitions with the manifest's references attached, asking for the introspection
 * only when a route among `definitions` reaches a class two files declare by name: the one bridge
 * for consumers that still judge the routes file's definitions.
 */
export async function withManifestControllerRefs<T extends { method: string; path: string; controller?: { name: string; action: string } }>(
  definitions: T[],
  scan: ControllerMethodScan,
  introspect: IntrospectSource | undefined,
): Promise<T[]> {
  const controllers = definitions.flatMap((definition) => (definition.controller ? [definition.controller] : []))
  if (collisionsReachedByName(scan, controllers).length === 0) return definitions
  const introspected = await introspectedRoutes(introspect)
  return introspected.status === 'described' ? attachControllerRefs(definitions, introspected.manifest) : definitions
}

function routeControllerKey(route: { method: string; path: string }, controller: { name: string; action: string }): string {
  return `${route.method.toUpperCase()} ${route.path} ${controller.name}.${controller.action}`
}

/**
 * Class members holding a function body, in both forms `Router` dispatches to
 * (`async destroy() {}` and `store = async () => {}`); a scan seeing only the method form
 * reports class-field actions as absent. Names come from `memberKeyName` (quoted keys count,
 * computed do not); one yield per member, so a `get`/`set` pair yields twice, and an instance
 * field shadows a prototype method whatever the order. `constructor`/`static`/`private` are yielded: filtering is the caller's policy.
 */
export interface ClassActionMember {
  /** The member node itself, for its source span, `accessibility`, and `static`. */
  member: ClassMethod | ClassProperty
  name: string
  /**
   * A `BlockStatement`, or the expression itself for an expression-bodied
   * arrow. A caller asking whether a body is empty must test for the block
   * first — an expression body is never empty.
   */
  body: BlockStatement | Expression
}

export function* classActionMembers(
  classDecl: ClassDeclaration,
): Generator<ClassActionMember> {
  for (const member of classDecl.body.body) {
    if (member.type === 'ClassMethod') {
      const name = memberKeyName(member)
      if (name !== undefined) yield { member, name, body: member.body }
      continue
    }

    if (member.type === 'ClassProperty') {
      const { value } = member
      if (
        value
        && (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression')
      ) {
        const name = memberKeyName(member)
        if (name !== undefined) yield { member, name, body: value.body }
      }
    }
  }
}

/**
 * Controller actions declared with an empty body, per class in one file. The one
 * rule behind `guren check`'s `empty-method:` warning and `guren doctor --next`'s
 * "Implement X()" step, which differ only in the record they emit. `constructor`
 * is filtered here rather than by the callers: this is the rule, not the
 * structural iterator above.
 */
export interface EmptyAction {
  className: string
  name: string
}

export function* emptyActions(ast: File, filePath: string): Generator<EmptyAction> {
  for (const node of ast.program.body) {
    const classDecl = extractClassDeclaration(node)
    if (!classDecl) continue
    const className = classDecl.id?.name ?? classNameFromPath(filePath)

    for (const { name, body } of classActionMembers(classDecl)) {
      if (name === 'constructor') continue
      // An expression-bodied arrow has no block and is never empty, so the
      // block test has to come first.
      if (body.type !== 'BlockStatement' || body.body.length > 0) continue
      yield { className, name }
    }
  }
}
