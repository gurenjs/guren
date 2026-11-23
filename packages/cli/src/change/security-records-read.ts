/**
 * Builds the per-route security records of one checkout (RFC 0040 §3): the introspected routes'
 * middleware and contracts, and each action body's authentication, authorization and validate
 * calls. What the reader cannot interpret is kept as a digest of its source, so an unchanged
 * part compares equal and a changed one is incomparable. An inline handler's body is not read.
 * `withoutEnvFiles` drops only what the checkout's own env files set; in an export, which holds
 * none, the child keeps the caller's environment, as the audit does.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import type { Statement } from '@babel/types'

import { CONTRACT_SEGMENTS } from '../contract-segments'
import {
  AUTH_CALL_PATTERN,
  collisionsReachedByName,
  controllerMethodFor,
  literalAuthorizationCalls,
  manifestRouteTargets,
  parseControllerMethods,
  routeSourceClasses,
  unfollowedCallArguments,
  validateCallSites,
  type ControllerMethodScan,
  type ControllerTarget,
} from '../controller-methods'
import { resolveImportPath } from '../import-resolution'
import { CHECK_INTROSPECT_TIMEOUT_MS, introspectApp, type GraphRouteEntry } from '../introspect'
import { introspectedRoutes, skippedRegistrars } from '../manifest-section'
import { canonicalSyntax, referencedIdentifiers, unconditionalThisCalls, walk, type BabelNode } from '../ast-walk'
import { ParseCache, parseSourceFile } from '../parse-cache'
import { routesEntryOrDefault } from '../route-registrar'
import { importsByLocal, specifierBase, type ImportEntry } from '../schema-binding'
import { SECURITY_RECORD_VERSION, type ActionRecord, type AuthorizationCall, type RouteSecurityRecord, type SecurityRecords, type ValidateCall } from './security-records'

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

const IDENTIFIER = /[A-Za-z_$][\w$]*/gu

interface ModuleBindings {
  path: string
  text: string
  /** Top-level declarations by the names they bind, exported or not, as their statement's text. */
  declared: Map<string, string>
  /** The statement node of each declared name, what its references are read from. */
  statements: Map<string, BabelNode>
  /** A declared class's parent as written: `extends Base`, or `extends ns.Base`. */
  parents: Map<string, { local: string; member?: string } | { expression: BabelNode }>
  imports: Map<string, ImportEntry>
  /** `export { name } from` and `export { local as name } from`: the source and its name there. */
  reexported: Map<string, { source: string; name: string }>
  /** `export * from` sources. */
  starred: string[]
}

type PatternNode = { type: string; name?: string; properties?: Array<{ type: string; value?: PatternNode; argument?: PatternNode }>; elements?: Array<PatternNode | null>; left?: PatternNode; argument?: PatternNode }

/** Every name a binding pattern introduces, a destructuring included. */
function patternNames(node: PatternNode | null | undefined, into: string[] = []): string[] {
  if (!node) return into
  if (node.type === 'Identifier' && node.name) into.push(node.name)
  else if (node.type === 'ObjectPattern') for (const property of node.properties ?? []) patternNames(property.type === 'RestElement' ? property.argument : property.value, into)
  else if (node.type === 'ArrayPattern') for (const element of node.elements ?? []) patternNames(element, into)
  else if (node.type === 'AssignmentPattern') patternNames(node.left, into)
  else if (node.type === 'RestElement') patternNames(node.argument, into)
  return into
}

type Target = { file: string; name: string } | { leaf: string }
interface DeclarationNode { key: string; unit: string; next: Target[] }

const NOT_BINDINGS = new Set(['this', 'super', 'true', 'false', 'null', 'undefined', 'new', 'typeof', 'instanceof', 'void', 'await', 'async', 'function', 'return', 'const', 'let', 'var', 'if', 'else', 'in', 'of', 'as', 'Number', 'String', 'Boolean', 'Object', 'Array', 'JSON', 'Math', 'Date', 'Promise', 'Error', 'Symbol', 'BigInt', 'RegExp', 'Map', 'Set'])

/** Whether a syntax tree reads a member of `this`. */
function readsThisMember(node: unknown): boolean {
  let found = false
  walk(node, (current) => {
    if (found) return false
    if ((current.type === 'MemberExpression' || current.type === 'OptionalMemberExpression') && (current as BabelNode & { object: BabelNode }).object.type === 'ThisExpression') found = true
  })
  return found
}

/**
 * The identifiers source text reads, parsed through `parseSourceFile()`; `undefined` when it does
 * not parse, so a caller can widen rather than read nothing. `wrap` makes a fragment a program.
 */
function sourceIdentifiers(text: string, file: string, wrap: (text: string) => string): { names: string[]; thisMember: boolean; program: BabelNode } | undefined {
  const ast = parseSourceFile(wrap(text), file)
  if (!ast) return undefined
  const program = ast.program as unknown as BabelNode
  return { names: referencedIdentifiers(program), thisMember: readsThisMember(program), program }
}

/** Whether a body assigns any of `names` from an expression that reads a member of `this`. */
function assignsFromThis(program: BabelNode, names: ReadonlySet<string>): boolean {
  let found = false
  walk(program, (current) => {
    if (found) return false
    const node = current as BabelNode & { id?: PatternNode; init?: BabelNode | null; left?: PatternNode; right?: BabelNode }
    if (current.type === 'VariableDeclarator' && node.init && patternNames(node.id).some((name) => names.has(name)) && readsThisMember(node.init)) found = true
    if (current.type === 'AssignmentExpression' && node.right && patternNames(node.left).some((name) => names.has(name)) && readsThisMember(node.right)) found = true
  })
  return found
}

/**
 * Digests what a schema or an ability is built from: the declarations reachable from a name
 * through the top-level bindings each reads (imports, re-exports, `export *`), hashed as one
 * sorted set, so it is one walk and the same whichever name was asked first. A module that will
 * not parse, or a namespace import, is its whole file; a bare specifier is itself, since only `.`
 * and `@/` are app paths to `specifierBase()`.
 */
class Declarations {
  private readonly digests = new Map<string, Promise<string>>()
  private readonly nodes = new Map<string, Promise<DeclarationNode>>()
  private readonly modules = new Map<string, Promise<ModuleBindings | { unparsed: string } | undefined>>()
  constructor(private readonly cwd: string, private readonly cache: ParseCache) {}

  /** `file` absolute, as an import names it (extension optional). */
  of(file: string, name: string): Promise<string> {
    const key = `${file}#${name}`
    let found = this.digests.get(key)
    if (!found) {
      found = this.reach([{ file, name }])
      this.digests.set(key, found)
    }
    return found
  }

  /** A digest of `text` with the declarations reachable from the identifiers of `names` that `file` binds. */
  async closure(file: string, text: string, names: string[]): Promise<string> {
    const module = await this.module(file)
    if (!module) return `missing:${digest(text)}`
    if ('unparsed' in module) return `file:${digest(text + module.unparsed)}`
    return digest(`${text}\n${await this.reach(names.flatMap((name) => this.target(module, name) ?? []))}`)
  }

  /**
   * The class statements along `extends` from `name` in `file`, each parent found through imports,
   * re-exports and `export *`: what a `this.<member>` or an inherited action can reach. A hop it
   * cannot follow is its whole file or specifier, never nothing.
   */
  async classChain(file: string, name: string): Promise<string> {
    const units: string[] = []
    const visited = new Set<string>()
    let current: { file: string; name: string } | undefined = { file, name }
    while (current) {
      const found = await this.locate(current.file, current.name)
      if ('leaf' in found) { units.push(found.leaf); break }
      const key = `${found.module.path}#${found.name}`
      if (visited.has(key)) break
      visited.add(key)
      units.push(found.module.declared.get(found.name)!)
      const parent = found.module.parents.get(found.name)
      if (!parent) break
      if ('expression' in parent) {
        units.push(`expression:${await this.reach(referencedIdentifiers(parent.expression).flatMap((other) => this.target(found.module, other) ?? []))}`)
        break
      }
      const target = this.target(found.module, parent.local)
      if (!target) { units.push(`unbound:${parent.local}`); break }
      if ('leaf' in target) { units.push(target.leaf); break }
      current = parent.member === undefined ? target : target.name === '*' ? { file: target.file, name: parent.member } : undefined
      if (!current) units.push(`member:${parent.local}.${parent.member}`)
    }
    return `class:${digest(units.join('\n'))}`
  }

  /**
   * What `name` in `file` is, followed through imports, re-exports and `export *` to the module declaring it:
   * `file#name` for a class (a model), else that with the digest of the declaration, since `const Subject = Post`
   * names another class once its right side changes. A hop it cannot follow is its leaf.
   */
  async identity(file: string, name: string): Promise<string> {
    const found = await this.locate(file, name)
    if ('leaf' in found) return found.leaf
    const at = `${this.relative(found.module.path)}#${found.name}`
    return declaresClass(found.module.statements.get(found.name)) ? at : `${at}:${await this.of(found.module.path, found.name)}`
  }

  /** The module that declares `name` as reached from `file`, following re-exports and `export *`; a leaf where it stops. */
  private async locate(file: string, name: string, depth = 0): Promise<{ module: ModuleBindings; name: string } | { leaf: string }> {
    const module = await this.module(file)
    if (!module) return { leaf: `missing:${this.relative(file)}` }
    if ('unparsed' in module) return { leaf: `file:${digest(module.unparsed)}` }
    if (module.declared.has(name)) return { module, name }
    if (depth > 32) return { leaf: `file:${digest(module.text)}` }
    const reexport = module.reexported.get(name)
    if (reexport) {
      const base = specifierBase(this.cwd, module.path, reexport.source)
      return base === null ? { leaf: `package:${reexport.source}` } : this.locate(base, reexport.name, depth + 1)
    }
    const imported = this.target(module, name)
    if (imported) return 'leaf' in imported ? imported : imported.name === '*' ? { leaf: `file:${digest(module.text)}` } : this.locate(imported.file, imported.name, depth + 1)
    for (const source of module.starred) {
      const base = specifierBase(this.cwd, module.path, source)
      if (base !== null && (await this.provides(base, name, new Set()))) return this.locate(base, name, depth + 1)
    }
    return { leaf: `file:${digest(module.text)}` }
  }

  /** What a name `module` binds resolves to, or undefined for a name it does not bind. */
  private target(module: ModuleBindings, name: string): Target | undefined {
    if (module.declared.has(name)) return { file: module.path, name }
    const entry = module.imports.get(name)
    if (!entry) return undefined
    const base = specifierBase(this.cwd, module.path, entry.source)
    if (base === null) return { leaf: `package:${entry.source}` }
    if (entry.kind === 'named') return { file: base, name: entry.imported }
    if (entry.kind === 'default') return { file: base, name: 'default' }
    return { file: base, name: '*' }
  }

  /** Every declaration reachable from `roots`, hashed as one sorted set. */
  private async reach(roots: Target[]): Promise<string> {
    const units = new Map<string, string>()
    const queue = [...roots]
    for (let target = queue.shift(); target; target = queue.shift()) {
      if ('leaf' in target) { units.set(target.leaf, target.leaf); continue }
      const node = await this.node(target.file, target.name)
      if (units.has(node.key)) continue
      units.set(node.key, node.unit)
      queue.push(...node.next)
    }
    return digest([...units].sort(([a], [b]) => a.localeCompare(b)).map(([key, unit]) => `${key}\0${unit}`).join('\n'))
  }

  private node(file: string, name: string): Promise<DeclarationNode> {
    const key = `${file}#${name}`
    let found = this.nodes.get(key)
    if (!found) {
      found = this.build(file, name)
      this.nodes.set(key, found)
    }
    return found
  }

  private async build(file: string, name: string): Promise<DeclarationNode> {
    const module = await this.module(file)
    if (!module) return { key: `missing:${this.relative(file)}`, unit: '', next: [] }
    const key = `${this.relative('path' in module ? module.path : file)}#${name}`
    if ('unparsed' in module) return { key, unit: `file:${digest(module.unparsed)}`, next: [] }
    if (name === '*') return { key, unit: `file:${digest(module.text)}`, next: [] }
    const declaration = module.declared.get(name)
    if (declaration !== undefined) {
      const next = referencedIdentifiers(module.statements.get(name)).filter((other) => other !== name).flatMap((other) => this.target(module, other) ?? [])
      return { key, unit: declaration, next }
    }
    const reexport = module.reexported.get(name)
    if (reexport) {
      const base = specifierBase(this.cwd, module.path, reexport.source)
      return { key, unit: 'reexport', next: [base === null ? { leaf: `package:${reexport.source}` } : { file: base, name: reexport.name }] }
    }
    const imported = this.target(module, name)
    if (imported) return { key, unit: 'import', next: [imported] }
    // Through `export *`: the module that provides the name, so a barrel gaining another line changes nothing.
    for (const source of module.starred) {
      const base = specifierBase(this.cwd, module.path, source)
      if (base !== null && (await this.provides(base, name, new Set()))) return { key, unit: 'star', next: [{ file: base, name }] }
    }
    // Not found: every file on the way is what a change would alter.
    return {
      key,
      unit: `file:${digest(module.text)}`,
      next: module.starred.map((source) => {
        const base = specifierBase(this.cwd, module.path, source)
        return base === null ? { leaf: `package:${source}` } : { file: base, name: '*' }
      }),
    }
  }

  /** Whether `file` declares, imports or re-exports `name`, through its own `export *` lines too. */
  private async provides(file: string, name: string, visited: Set<string>): Promise<boolean> {
    if (visited.has(file)) return false
    visited.add(file)
    const module = await this.module(file)
    if (!module || 'unparsed' in module) return false
    if (module.declared.has(name) || module.reexported.has(name) || module.imports.has(name)) return true
    for (const source of module.starred) {
      const base = specifierBase(this.cwd, module.path, source)
      if (base !== null && (await this.provides(base, name, visited))) return true
    }
    return false
  }

  /** The bindings of `file`; `{ unparsed }` holds the text of one Babel would not parse. */
  module(file: string): Promise<ModuleBindings | { unparsed: string } | undefined> {
    let found = this.modules.get(file)
    if (!found) {
      found = this.parse(file)
      this.modules.set(file, found)
    }
    return found
  }

  private async parse(file: string): Promise<ModuleBindings | { unparsed: string } | undefined> {
    const path = await resolveImportPath(file)
    if (!path) return undefined
    const outcome = await this.cache.read(path)
    if (outcome.status === 'unreadable') return undefined
    if (outcome.status !== 'parsed') return { unparsed: outcome.source }
    const text = outcome.source
    const body = outcome.ast.program.body as Statement[]
    const declared = new Map<string, string>()
    const statements = new Map<string, BabelNode>()
    const parents = new Map<string, { local: string; member?: string } | { expression: BabelNode }>()
    const reexported = new Map<string, { source: string; name: string }>()
    const starred: string[] = []
    for (const statement of body) {
      const slice = text.slice(statement.start ?? 0, statement.end ?? text.length)
      if (statement.type === 'ExportAllDeclaration') { starred.push(statement.source.value); continue }
      if (statement.type === 'ExportNamedDeclaration' && statement.source) {
        for (const specifier of statement.specifiers) {
          if (specifier.type !== 'ExportSpecifier') continue
          const exported = specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value
          reexported.set(exported, { source: statement.source.value, name: specifier.local.name })
        }
        continue
      }
      type ParentNode = BabelNode & { name?: string; object?: BabelNode & { name?: string }; property?: BabelNode & { name?: string }; computed?: boolean }
      const node = (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement) as { type: string; id?: { name?: string } | null; declarations?: Array<{ id: PatternNode; init?: { type: string; superClass?: BabelNode | null } | null }>; superClass?: BabelNode | null } | null
      const bind = (name: string, superClass?: BabelNode | null): void => {
        declared.set(name, slice)
        statements.set(name, statement as unknown as BabelNode)
        const parent = superClass as ParentNode | null | undefined
        if (!parent) return
        if (parent.type === 'Identifier' && parent.name) parents.set(name, { local: parent.name })
        else if (parent.type === 'MemberExpression' && !parent.computed && parent.object?.type === 'Identifier' && parent.property?.type === 'Identifier') parents.set(name, { local: parent.object.name!, member: parent.property.name! })
        // A mixin call or any other expression: what it reads is the parent.
        else parents.set(name, { expression: parent })
      }
      if (statement.type === 'ExportDefaultDeclaration') bind('default', node?.superClass)
      if (!node) continue
      if (node.type === 'VariableDeclaration') {
        // `const X = class extends Base {}` declares a class too.
        for (const entry of node.declarations ?? []) for (const name of patternNames(entry.id)) bind(name, entry.init?.type === 'ClassExpression' ? entry.init.superClass : undefined)
      } else if (node.id?.name) {
        // A function, a class, an enum, a namespace: whatever binds a top-level name.
        bind(node.id.name, node.superClass)
      }
    }
    return { path, text, declared, statements, parents, imports: importsByLocal(body), reexported, starred }
  }

  relative(file: string): string {
    return relative(this.cwd, file).split(sep).join('/')
  }
}

/** A digest of every routes file and the entry: where a contract schema no validator export is, or a class no controller file declares, would be written. */
async function routesDigest(cwd: string, entry: string | undefined): Promise<string> {
  const files: string[] = entry ? [resolve(cwd, entry)] : []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(path)
    }
  }
  await walk(join(cwd, 'routes'))
  const modules = join(cwd, 'modules')
  for (const name of await readdir(modules).catch(() => [] as string[])) {
    await walk(join(modules, name, 'routes'))
    // The routes file `make:module` writes beside the module's descriptor.
    for (const entry of await readdir(join(modules, name)).catch(() => [] as string[])) {
      if (/^routes\.[cm]?[jt]sx?$/u.test(entry)) files.push(join(modules, name, entry))
    }
  }
  const parts = await Promise.all(files.sort().map(async (file) => `${relative(cwd, file)}:${await readFile(file, 'utf8').catch(() => '')}`))
  return `routes:${digest(parts.join('\n'))}`
}

/** The records, or why the application could not be read: never a partial list. */
export async function readSecurityRecords(cwd: string): Promise<SecurityRecords | { unreadable: string }> {
  const introspection = await introspectApp(cwd, { fresh: true, graph: true, timeoutMs: CHECK_INTROSPECT_TIMEOUT_MS, withoutEnvFiles: true })
  if (introspection.status !== 'ok') return { unreadable: `the application did not introspect (${introspection.reason}): ${introspection.message.split('\n')[0]!.replaceAll(`${cwd}${sep}`, '')}` }
  // A provider that threw may have registered routes and middleware this list lacks.
  const described = await introspectedRoutes(() => Promise.resolve(introspection))
  if (described.status !== 'described') return { unreadable: described.reason ?? 'the introspected routes are not complete' }
  const { manifest } = described
  // A registrar introspection skipped may register routes this list lacks; the routes it lists still compare.
  const skipped = skippedRegistrars(manifest)
  const cache = new ParseCache()
  const scan = await parseControllerMethods(cwd, cache)
  const targets = manifestRouteTargets(manifest, await routeSourceClasses(cwd, manifest, resolve(cwd, await routesEntryOrDefault(cwd)), cache))
  const reachedByName = new Set(collisionsReachedByName(scan, targets.flatMap((route) => (route.controller ? [route.controller] : []))).map((collision) => collision.className))
  const declarations = new Declarations(cwd, cache)
  let routesFiles: Promise<string> | undefined
  const routes: RouteSecurityRecord[] = []
  for (const [index, route] of targets.entries()) {
    const { contractSources: sources, bindingSources } = manifest.routes[index] as GraphRouteEntry
    const contracts: RouteSecurityRecord['contracts'] = {}
    for (const key of CONTRACT_SEGMENTS) {
      const schema = route.schemas[key]
      if (schema === undefined) continue
      const exports = (sources?.[key] ?? []).map((source) => `${source.file}#${source.exportName}`).sort()
      const digests: Record<string, string> = {}
      for (const source of sources?.[key] ?? []) digests[`${source.file}#${source.exportName}`] = await declarations.of(resolve(cwd, source.file), source.exportName)
      if (exports.length === 0) digests[''] = await (routesFiles ??= routesDigest(cwd, manifest.entry.file ?? undefined))
      contracts[key] = { schema, exports, declarations: digests }
    }
    const ref = route.controller
    routes.push({
      method: route.method,
      path: route.path,
      ...(route.name ? { name: route.name } : {}),
      module: route.module,
      // The class by its file and export where introspection placed it, so two classes of one name stay apart.
      ...(ref ? { action: ref.resolved === 'identity' && ref.file && ref.exportName ? `${ref.file}#${ref.exportName}.${ref.action}` : `${ref.name}.${ref.action}` } : {}),
      middleware: route.middleware.map((entry) => ({
        kind: entry.kind,
        name: entry.name,
        capabilities: entry.capabilities,
        ...(entry.ability !== undefined ? { ability: entry.ability } : {}),
        ...(entry.unresolved ? { unresolved: true as const } : {}),
        ...(entry.members ? { members: entry.members } : {}),
        ...(entry.unresolvedMembers?.length ? { unresolvedMembers: entry.unresolvedMembers } : {}),
      })),
      contracts,
      // A model by the file and export introspection found it under, so two classes of one name stay apart; else by name.
      ...(route.bindings ? { bindings: Object.fromEntries(Object.entries(route.bindings).map(([parameter, name]) => {
        const source = bindingSources?.[parameter]
        return [parameter, source ? `${source.file}#${source.exportName}` : name]
      })) } : {}),
      ...(route.agent ? { agent: route.agent } : {}),
      handler: ref ? await actionRecord(cwd, scan, ref, reachedByName, declarations, manifest.entry.file ?? undefined) : { unread: 'an inline handler, whose body the reader does not follow' },
    })
  }
  return { recordVersion: SECURITY_RECORD_VERSION, routes, ...(skipped.length > 0 ? { skipped } : {}) }
}

async function actionRecord(
  cwd: string, scan: ControllerMethodScan, controller: ControllerTarget, reachedByName: ReadonlySet<string>, declarations: Declarations, entry: string | undefined,
): Promise<ActionRecord> {
  const lookup = controllerMethodFor(scan, controller)
  // Unread, but the class is known: the digest of what declares it says whether it changed.
  const unread = async (why: string): Promise<ActionRecord> => {
    const declared = scan.declarations.filter((entry) => entry.className === lookup.className)
    if (declared.length === 0) {
      // Placed by introspection though the controller scan holds no declaration (a class expression): its own chain.
      if (controller.resolved === 'identity' && controller.file && controller.exportName) return { unread: why, digest: await declarations.classChain(resolve(cwd, controller.file), controller.exportName) }
      // Declared in no controller file (the routes file, the entry): the routes files and the entry are where it would be.
      return { unread: why, digest: await routesDigest(cwd, entry) }
    }
    // The class statements along `extends`: what declares the action, and nothing else the class reads.
    const parts = await Promise.all(declared.map(async (entry) => `${entry.file}:${await declarations.classChain(resolve(cwd, entry.file), entry.className)}`))
    return { unread: why, digest: digest(parts.sort().join('\n')) }
  }
  // Read by name where two classes share it: the body may be the other class's.
  if (lookup.by === 'name' && reachedByName.has(lookup.className)) return unread(`${lookup.className} is declared more than once, and the route reaches it by name`)
  if (!lookup.info) return unread(`the body of ${lookup.className}.${controller.action} was not found${lookup.by === 'elsewhere' ? ' in a controller file' : ''}`)
  const { body, rawBody, filePath } = lookup.info
  const controllerFile = resolve(cwd, filePath)
  const module = await declarations.module(controllerFile)
  const local = module && !('unparsed' in module) ? module : undefined
  const imports: Map<string, ImportEntry> = local?.imports ?? new Map()
  // The arguments of every call the record cannot name: what the digest has to cover.
  const unfollowed = unfollowedCallArguments(body, rawBody)
  const block = actionBlock(rawBody, filePath)
  const unconditional = new Set(block ? unconditionalThisCalls(block.body, 'authorize').map((call) => call.start! - block.offset) : [])
  // What hides a file-level name inside the body: its own bindings and the action's parameters.
  const bodyBindings = block ? new Set([...declaredNames(block.body), ...lookup.info.paramNames]) : undefined
  const authorizes: AuthorizationCall[] = []
  for (const { member, ability, subject, index } of literalAuthorizationCalls(body, rawBody).filter((call) => !call.templated)) {
    const classes: string[] = []
    const parsed = subject === '' ? undefined : sourceIdentifiers(subject, filePath, (text) => `__args__(${text})`)
    if (subject !== '' && !parsed) unfollowed.push(subject)
    const binds = (name: string): boolean => imports.has(name) || !!local?.declared.has(name)
    for (const name of parsed?.names ?? []) {
      // A file-level binding is read whatever its spelling, a model named `Map` included.
      if (name === '__args__' || (!binds(name) && NOT_BINDINGS.has(name))) continue
      // A local of the action naming an import or a file-level class hides which one the call asks about.
      if (binds(name) && (bodyBindings === undefined || bodyBindings.has(name))) unfollowed.push(name)
      else if (binds(name)) {
        const resolved = await subjectClass(cwd, controllerFile, imports, name, declarations)
        if (!classes.includes(resolved)) classes.push(resolved)
      }
    }
    // A tuple's class position names a local of the action: what it holds is the body's.
    const first = tupleClass(parsed?.program)
    if (first !== undefined && !binds(first)) unfollowed.push(first)
    // How a call that is not unconditional is reached: the statements up to the one holding it, or the whole body.
    const reach = member === 'authorize' && !unconditional.has(index) ? reachDigest(block, index, rawBody) : undefined
    authorizes.push({ member, ability, subject, ...(classes.length > 0 ? { classes } : {}), ...(member === 'authorize' && unconditional.has(index) ? { unconditional: true as const } : {}), ...(reach ? { reach } : {}) })
  }
  const validates: ValidateCall[] = []
  for (const site of validateCallSites(body)) {
    // A schema the controller file declares itself, as the documented controller pattern does.
    const target = site.schema && !site.schema.includes('.') && local?.declared.has(site.schema)
      ? { file: controllerFile, name: site.schema }
      : site.schema ? importedExport(cwd, controllerFile, imports, site.schema) : undefined
    if (!target) {
      if (site.schema) unfollowed.push(site.schema)
      validates.push({ member: site.member, schema: '' })
      continue
    }
    const file = (await resolveImportPath(target.file)) ?? target.file
    validates.push({ member: site.member, schema: `${declarations.relative(file)}#${target.name}`, declaration: await declarations.of(target.file, target.name) })
  }
  let unseen: string | undefined
  if (unfollowed.length > 0) {
    // Parsed, so a string, a comment, a spread or a template is read as code reads it.
    const args = sourceIdentifiers(unfollowed.join(', '), filePath, (text) => `__args__(${text})`)
    const whole = sourceIdentifiers(rawBody, filePath, (text) => (text.trimStart().startsWith('{') ? `async function __action__() ${text}` : `async function __action__() { return (${text}) }`))
    const binds = (name: string): boolean => !!local && (local.declared.has(name) || local.imports.has(name))
    // An argument naming a local of the action reaches whatever the action assigns it: the whole body is the scope.
    const locals = new Set(args?.names.filter((name) => name !== '__args__' && !NOT_BINDINGS.has(name) && !binds(name)) ?? [])
    const widened = !args || locals.size > 0
    const names = widened ? (whole?.names ?? rawBody.match(IDENTIFIER) ?? []) : args.names
    const parts = [await declarations.closure(controllerFile, rawBody, names)]
    // `this.<member>` names the class's own field or method, which only the class statements hold:
    // read by an argument itself, or by what the body assigns a local an argument names.
    if (!args || !whole || args.thisMember || (locals.size > 0 && assignsFromThis(whole.program, locals))) parts.push(await declarations.classChain(controllerFile, lookup.className))
    unseen = digest(parts.join('\n'))
  }
  return {
    authenticates: AUTH_CALL_PATTERN.test(body),
    authorizes,
    validates,
    ...(unseen ? { unseen } : {}),
  }
}

const ACTION_PREFIX = 'async function __action__() '

/** The action's own block, with where `rawBody` starts in what was parsed; `undefined` for a concise arrow or a body that does not parse. */
function actionBlock(rawBody: string, file: string): { body: { body: readonly unknown[] }; offset: number } | undefined {
  if (!rawBody.trimStart().startsWith('{')) return undefined
  const ast = parseSourceFile(`${ACTION_PREFIX}${rawBody}`, file)
  const declaration = ast?.program.body[0]
  return declaration?.type === 'FunctionDeclaration' ? { body: declaration.body, offset: ACTION_PREFIX.length } : undefined
}

/** Every name a block binds anywhere inside it: declarations, parameters of nested functions, catch clauses, classes, enums. */
function declaredNames(block: unknown): Set<string> {
  const names = new Set<string>()
  walk(block, (current) => {
    const node = current as BabelNode & { id?: PatternNode; params?: PatternNode[]; param?: PatternNode }
    if (current.type === 'VariableDeclarator') patternNames(node.id).forEach((name) => names.add(name))
    // A function, a class, an enum or a namespace binds its name, and an expression of one binds it inside itself.
    if ((current.type.endsWith('Declaration') || current.type === 'FunctionExpression' || current.type === 'ClassExpression') && node.id) patternNames(node.id).forEach((name) => names.add(name))
    for (const param of node.params ?? []) patternNames(param).forEach((name) => names.add(name))
    if (current.type === 'CatchClause' && node.param) patternNames(node.param).forEach((name) => names.add(name))
  })
  return names
}

/** What a name the controller file binds is, followed to the module declaring it (`Declarations.identity()`); a package import by its specifier and name. */
async function subjectClass(cwd: string, file: string, imports: Map<string, ImportEntry>, name: string, declarations: Declarations): Promise<string> {
  const entry = imports.get(name)
  if (entry && specifierBase(cwd, file, entry.source) === null) return `${entry.source}#${entry.kind === 'named' ? entry.imported : entry.kind === 'default' ? 'default' : '*'}`
  return declarations.identity(file, name)
}

/** Whether a top-level statement declares a class under its name: `class X`, `export default class`, `const X = class`. */
function declaresClass(statement: BabelNode | undefined): boolean {
  const node = (statement?.type === 'ExportNamedDeclaration' || statement?.type === 'ExportDefaultDeclaration' ? statement.declaration : statement) as BabelNode | undefined
  if (node?.type === 'ClassDeclaration') return true
  const declarations = node?.type === 'VariableDeclaration' ? (node.declarations as Array<{ init?: BabelNode | null }>) : []
  return declarations.length === 1 && declarations[0]!.init?.type === 'ClassExpression'
}

/** The identifier in the class position of a `[Class, record]` subject, as `sourceIdentifiers()` parsed it inside `__args__(…)`. */
function tupleClass(program: BabelNode | undefined): string | undefined {
  const statement = (program?.body as BabelNode[] | undefined)?.[0] as (BabelNode & { expression?: BabelNode & { arguments?: BabelNode[] } }) | undefined
  const first = statement?.expression?.arguments?.[0] as (BabelNode & { elements?: Array<BabelNode | null> }) | undefined
  const element = first?.type === 'ArrayExpression' ? first.elements?.[0] : undefined
  return element?.type === 'Identifier' ? (element.name as string) : undefined
}

/** A digest of the action's statements up to and including the one holding the call at `index`, or of the whole body. */
function reachDigest(block: { body: { body: readonly unknown[] }; offset: number } | undefined, index: number, rawBody: string): string {
  const statements = (block?.body.body ?? []) as Array<{ start?: number | null; end?: number | null }>
  const at = statements.findIndex((statement) => (statement.start ?? 0) - block!.offset <= index && index < (statement.end ?? 0) - block!.offset)
  return digest(at === -1 ? rawBody : canonicalSyntax(statements.slice(0, at + 1)))
}

/** The export an identifier (or `namespace.name`) names through the file's imports, never one matched by name alone. */
function importedExport(cwd: string, file: string, imports: Map<string, ImportEntry>, chain: string): { file: string; name: string } | undefined {
  const [local, member, ...rest] = chain.split('.')
  const entry = imports.get(local!)
  if (!entry || entry.typeOnly || rest.length > 0) return undefined
  const base = specifierBase(cwd, file, entry.source)
  if (base === null) return undefined
  if (member === undefined && entry.kind === 'named') return { file: base, name: entry.imported }
  if (member === undefined && entry.kind === 'default') return { file: base, name: 'default' }
  if (member !== undefined && entry.kind === 'namespace') return { file: base, name: member }
  return undefined
}
