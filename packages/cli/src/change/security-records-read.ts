/**
 * Builds the per-route security records of one checkout (RFC 0040 §3): the introspected routes'
 * middleware and contracts, and each action body's authentication, authorization and validate
 * calls. What the reader cannot interpret is kept as a digest of its source, so an unchanged
 * part compares equal and a changed one is incomparable. An inline handler's body is not read.
 * `withoutEnvFiles` drops only what the checkout's own env files set; in an export, which holds
 * none, the child keeps the caller's environment, as the audit does.
 */
import { createHash } from 'node:crypto'
import { relative, resolve, sep } from 'node:path'

import type { Statement } from '@babel/types'

import {
  AUTH_CALL_PATTERN,
  AUTHORIZATION_CALL_PATTERN,
  VALIDATE_MEMBER_CALL_PATTERN,
  collisionsReachedByName,
  controllerMethodFor,
  literalAuthorizationCalls,
  manifestRouteTargets,
  parseControllerMethods,
  routeSourceClasses,
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

const CONTRACT_KEYS = ['params', 'query', 'body'] as const
const AUTHORIZATION_CALLS = new RegExp(AUTHORIZATION_CALL_PATTERN.source, 'g')

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** Reads source declarations by digest: an export's own declaration, else its whole file. */
class Declarations {
  private readonly digests = new Map<string, Promise<string>>()
  constructor(private readonly cwd: string, private readonly cache: ParseCache) {}

  /** `file` absolute, as an import names it (extension optional). */
  of(file: string, name: string): Promise<string> {
    const key = `${file}#${name}`
    let found = this.digests.get(key)
    if (!found) {
      found = this.read(file, name)
      this.digests.set(key, found)
    }
    return found
  }

  private async read(file: string, name: string): Promise<string> {
    const path = await resolveImportPath(file)
    if (!path) return 'unread'
    const outcome = await this.cache.read(path)
    if (outcome.status !== 'parsed') return 'unread'
    const text = outcome.source
    for (const statement of outcome.ast.program.body as Statement[]) {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : null
      if (declaration?.type === 'VariableDeclaration' && declaration.declarations.some((entry) => entry.id.type === 'Identifier' && entry.id.name === name)) {
        return `declaration:${digest(text.slice(statement.start ?? 0, statement.end ?? text.length))}`
      }
    }
    // Re-exported or declared apart from its export: the file is what can be compared.
    return `file:${digest(text)}`
  }

  relative(file: string): string {
    return relative(this.cwd, file).split(sep).join('/')
  }
}

/** The records, or why the application could not be read: never a partial list. */
export async function readSecurityRecords(cwd: string): Promise<SecurityRecords | { unreadable: string }> {
  const introspection = await introspectApp(cwd, { fresh: true, graph: true, timeoutMs: CHECK_INTROSPECT_TIMEOUT_MS, withoutEnvFiles: true })
  if (introspection.status !== 'ok') return { unreadable: `the application did not introspect (${introspection.reason}): ${introspection.message.split('\n')[0]!.replaceAll(`${cwd}${sep}`, '')}` }
  // A provider that threw, or a registrar introspection skipped, may register routes this list lacks.
  const described = await introspectedRoutes(() => Promise.resolve(introspection))
  if (described.status !== 'described') return { unreadable: described.reason ?? 'the introspected routes are not complete' }
  const { manifest } = described
  const skipped = skippedRegistrars(manifest)
  if (skipped.length > 0) return { unreadable: `introspection skipped what may register routes: ${skipped.join(', ')}` }
  const cache = new ParseCache()
  const scan = await parseControllerMethods(cwd, cache)
  const targets = manifestRouteTargets(manifest, await routeSourceClasses(cwd, manifest, resolve(cwd, await routesEntryOrDefault(cwd)), cache))
  const reachedByName = new Set(collisionsReachedByName(scan, targets.flatMap((route) => (route.controller ? [route.controller] : []))).map((collision) => collision.className))
  const declarations = new Declarations(cwd, cache)
  const routes: RouteSecurityRecord[] = []
  for (const [index, route] of targets.entries()) {
    const sources = (manifest.routes[index] as GraphRouteEntry).contractSources
    const contracts: RouteSecurityRecord['contracts'] = {}
    for (const key of CONTRACT_KEYS) {
      const schema = route.schemas[key]
      if (schema === undefined) continue
      const exports = (sources?.[key] ?? []).map((source) => `${source.file}#${source.exportName}`).sort()
      const digests: Record<string, string> = {}
      for (const source of sources?.[key] ?? []) digests[`${source.file}#${source.exportName}`] = await declarations.of(resolve(cwd, source.file), source.exportName)
      contracts[key] = { schema, exports, declarations: digests }
    }
    routes.push({
      method: route.method,
      path: route.path,
      ...(route.name ? { name: route.name } : {}),
      module: route.module,
      ...(route.controller ? { action: `${route.controller.name}.${route.controller.action}` } : {}),
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
      handler: route.controller ? await actionRecord(cwd, scan, route.controller, reachedByName, cache, declarations) : { unread: 'an inline handler, whose body the reader does not follow' },
    })
  }
  return { recordVersion: SECURITY_RECORD_VERSION, routes }
}

async function actionRecord(
  cwd: string, scan: ControllerMethodScan, controller: ControllerTarget, reachedByName: ReadonlySet<string>, cache: ParseCache, declarations: Declarations,
): Promise<ActionRecord> {
  const lookup = controllerMethodFor(scan, controller)
  // Read by name where two classes share it: the body may be the other class's.
  if (lookup.by === 'name' && reachedByName.has(lookup.className)) return { unread: `${lookup.className} is declared more than once, and the route reaches it by name` }
  if (!lookup.info) return { unread: `the body of ${lookup.className}.${controller.action} was not found${lookup.by === 'elsewhere' ? ' in a controller file' : ''}` }
  const { body, rawBody, filePath } = lookup.info
  const authorizes = literalAuthorizationCalls(body, rawBody)
  const sites = validateCallSites(body)
  const outcome = await cache.read(resolve(cwd, filePath))
  const imports: Map<string, ImportEntry> = outcome.status === 'parsed' ? importsByLocal(outcome.ast.program.body) : new Map()
  const validates: ValidateCall[] = []
  let unseen = [...body.matchAll(AUTHORIZATION_CALLS)].length > authorizes.length || [...body.matchAll(VALIDATE_MEMBER_CALL_PATTERN)].length > sites.length
  for (const site of sites) {
    const target = site.schema ? importedExport(cwd, resolve(cwd, filePath), imports, site.schema) : undefined
    if (!target) {
      unseen = true
      validates.push({ member: site.member, schema: '' })
      continue
    }
    const file = (await resolveImportPath(target.file)) ?? target.file
    validates.push({ member: site.member, schema: `${declarations.relative(file)}#${target.name}`, declaration: await declarations.of(target.file, target.name) })
  }
  return {
    authenticates: AUTH_CALL_PATTERN.test(body),
    authorizes,
    validates,
    ...(unseen ? { unseen: digest(rawBody) } : {}),
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
  if (member !== undefined && entry.kind === 'namespace') return { file: base, name: member }
  return undefined
}
