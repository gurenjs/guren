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
import { ParseCache } from '../parse-cache'
import { routesEntryOrDefault } from '../route-registrar'
import { importsByLocal, specifierBase, type ImportEntry } from '../schema-binding'
import { SECURITY_RECORD_VERSION, type ActionRecord, type RouteSecurityRecord, type SecurityRecords, type ValidateCall } from './security-records'

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

const IDENTIFIER = /[A-Za-z_$][\w$]*/gu

interface ModuleBindings {
  path: string
  text: string
  /** Top-level declarations by the names they bind, exported or not, as their statement's text. */
  declared: Map<string, string>
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

/**
 * Digests what a schema or an ability is built from: a declaration together with every top-level
 * binding it names, followed through imports and re-exports, so loosening a base schema a
 * declaration extends, or one a barrel re-exports, changes its digest. What cannot be followed (a
 * module that will not parse, a namespace import) is digested as its whole file, and a bare
 * specifier as itself: only `.` and `@/` are app paths, as `specifierBase()` reads them.
 */
class Declarations {
  private readonly digests = new Map<string, Promise<string>>()
  private readonly modules = new Map<string, Promise<ModuleBindings | { unparsed: string } | undefined>>()
  constructor(private readonly cwd: string, private readonly cache: ParseCache) {}

  /** `file` absolute, as an import names it (extension optional). */
  of(file: string, name: string, seen: ReadonlySet<string> = new Set()): Promise<string> {
    const key = `${file}#${name}`
    if (seen.has(key)) return Promise.resolve(`cycle:${name}`)
    // Only a digest computed from no cycle is the same whichever declaration was asked first.
    if (seen.size > 0) return this.read(file, name, new Set([...seen, key]))
    let found = this.digests.get(key)
    if (!found) {
      found = this.read(file, name, new Set([key]))
      this.digests.set(key, found)
    }
    return found
  }

  /** A digest of `text` with the top-level bindings of `file` that `names` names. */
  async closure(file: string, text: string, names: string, seen: ReadonlySet<string> = new Set()): Promise<string> {
    const module = await this.module(file)
    if (!module) return `missing:${digest(text)}`
    if ('unparsed' in module) return `file:${digest(text + module.unparsed)}`
    const named = [...new Set(names.match(IDENTIFIER) ?? [])].filter((name) => module.declared.has(name) || module.imports.has(name)).sort()
    const parts = [text]
    for (const name of named) parts.push(`${name}=${await this.binding(module, name, seen)}`)
    return digest(parts.join('\n'))
  }

  private async binding(module: ModuleBindings, name: string, seen: ReadonlySet<string>): Promise<string> {
    if (module.declared.has(name)) return this.of(module.path, name, seen)
    const entry = module.imports.get(name)!
    const base = specifierBase(this.cwd, module.path, entry.source)
    if (base === null) return `package:${entry.source}`
    if (entry.kind === 'named') return this.of(base, entry.imported, seen)
    if (entry.kind === 'default') return this.of(base, 'default', seen)
    return this.whole(base)
  }

  private async whole(file: string): Promise<string> {
    const module = await this.module(file)
    if (!module) return `missing:${this.relative(file)}`
    return `file:${digest('unparsed' in module ? module.unparsed : module.text)}`
  }

  private async read(file: string, name: string, seen: ReadonlySet<string>): Promise<string> {
    const module = await this.module(file)
    if (!module) return `missing:${this.relative(file)}`
    if ('unparsed' in module) return `file:${digest(module.unparsed)}`
    const declaration = module.declared.get(name)
    if (declaration !== undefined) return `declaration:${await this.closure(module.path, declaration, declaration, seen)}`
    const reexport = module.reexported.get(name)
    if (reexport) {
      const base = specifierBase(this.cwd, module.path, reexport.source)
      return base === null ? `package:${reexport.source}` : this.of(base, reexport.name, seen)
    }
    if (module.imports.has(name)) return this.binding(module, name, seen)
    // Through `export *`: the module that provides the name, so a barrel gaining another line changes nothing.
    for (const source of module.starred) {
      const base = specifierBase(this.cwd, module.path, source)
      if (base !== null && (await this.provides(base, name, new Set()))) return this.of(base, name, seen)
    }
    // Not found: every file on the way is what a change would alter.
    const parts = [`file:${digest(module.text)}`]
    for (const source of module.starred) {
      const base = specifierBase(this.cwd, module.path, source)
      parts.push(base === null ? `package:${source}` : await this.whole(base))
    }
    return `reexport:${digest(parts.join('\n'))}`
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
      const node = (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement) as { type: string; id?: { name?: string } | null; declarations?: Array<{ id: PatternNode }> } | null
      if (statement.type === 'ExportDefaultDeclaration') declared.set('default', slice)
      if (!node) continue
      if (node.type === 'VariableDeclaration') {
        for (const entry of node.declarations ?? []) for (const name of patternNames(entry.id)) declared.set(name, slice)
      } else if (node.id?.name) {
        // A function, a class, an enum, a namespace: whatever binds a top-level name.
        declared.set(node.id.name, slice)
      }
    }
    return { path, text, declared, imports: importsByLocal(body), reexported, starred }
  }

  relative(file: string): string {
    return relative(this.cwd, file).split(sep).join('/')
  }
}

/** A digest of every routes file: where a contract schema no validator export is would be written. */
async function routesDigest(cwd: string): Promise<string> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(path)
    }
  }
  await walk(join(cwd, 'routes'))
  const modules = join(cwd, 'modules')
  for (const name of await readdir(modules).catch(() => [] as string[])) await walk(join(modules, name, 'routes'))
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
    const sources = (manifest.routes[index] as GraphRouteEntry).contractSources
    const contracts: RouteSecurityRecord['contracts'] = {}
    for (const key of CONTRACT_SEGMENTS) {
      const schema = route.schemas[key]
      if (schema === undefined) continue
      const exports = (sources?.[key] ?? []).map((source) => `${source.file}#${source.exportName}`).sort()
      const digests: Record<string, string> = {}
      for (const source of sources?.[key] ?? []) digests[`${source.file}#${source.exportName}`] = await declarations.of(resolve(cwd, source.file), source.exportName)
      if (exports.length === 0) digests[''] = await (routesFiles ??= routesDigest(cwd))
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
      handler: ref ? await actionRecord(cwd, scan, ref, reachedByName, declarations) : { unread: 'an inline handler, whose body the reader does not follow' },
    })
  }
  return { recordVersion: SECURITY_RECORD_VERSION, routes, ...(skipped.length > 0 ? { skipped } : {}) }
}

async function actionRecord(
  cwd: string, scan: ControllerMethodScan, controller: ControllerTarget, reachedByName: ReadonlySet<string>, declarations: Declarations,
): Promise<ActionRecord> {
  const lookup = controllerMethodFor(scan, controller)
  // Unread, but the class is known: the digest of what declares it says whether it changed.
  const unread = async (why: string): Promise<ActionRecord> => {
    const declared = scan.declarations.filter((entry) => entry.className === lookup.className)
    if (declared.length === 0) return { unread: why }
    const parts = await Promise.all(declared.map(async (entry) => `${entry.file}:${await declarations.of(resolve(cwd, entry.file), entry.className)}`))
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
  const authorizes = literalAuthorizationCalls(body, rawBody).filter((call) => !call.templated).map(({ member, ability, subject }) => ({ member, ability, subject }))
  // The arguments of every call the record cannot name: what the digest has to cover.
  const unfollowed = unfollowedCallArguments(body, rawBody)
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
    const names = unfollowed.join('\n')
    // `this.<member>` names the class's own field or method, which only the class statement holds.
    const own = /\bthis\s*\.\s*[A-Za-z_$]/u.test(names) ? lookup.className : ''
    unseen = await declarations.closure(controllerFile, rawBody, `${names}\n${own}`)
  }
  return {
    authenticates: AUTH_CALL_PATTERN.test(body),
    authorizes,
    validates,
    ...(unseen ? { unseen } : {}),
  }
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
