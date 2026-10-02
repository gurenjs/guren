import { readFile, readdir } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import type { AppManifest, MiddlewareEntry } from '@guren/server'

import {
  buildApplicationGraph, graphDigest, graphId,
  type ApplicationGraphInputs, type GRAPH_RELATIONS, type GraphCoverage, type GraphEvidence, type GraphNode, type GurenApplicationGraph,
} from './application-graph'
import { importReferencePatterns, modelPatterns, policyBindings, type PolicyBinding } from './authorization-audit'
import { CONTRACT_SEGMENTS } from './contract-segments'
import { readControllerGraph } from './application-graph-controllers'
import { consultsAuthorization, VALIDATE_CALL_PATTERN, VALIDATE_MEMBER_CALL_PATTERN, type ControllerDeclaration } from './controller-methods'
import {
  discoverPolicyFiles, discoverTestFiles,
  FileDiscoveryError, moduleNameFromRelPath, NON_SOURCE_DIR_NAMES, toPosixRelative,
} from './discovery'
import { readModelGraph } from './application-graph-models'
import { readPageGraph } from './application-graph-pages'
import { extractInertiaPageRefs } from './inertia-pages'
import { CHECK_INTROSPECT_TIMEOUT_MS, GRAPH_SCAN_WARNINGS, introspectApp, type GraphRouteEntry } from './introspect'
import { ParseCache, parseSourceFile, type ParseOutcome } from './parse-cache'
import { readValidatorGraph } from './application-graph-validators'
import { readPolicyAbilities } from './plan/policy-abilities'
import { isUnreadable } from './plan/unreadable'
import { importsByLocal, specifierBase, withoutExtension, type ImportEntry } from './schema-binding'
import { wholeIdentifierPattern } from './utils'
import { readSourceClassIdentities } from './source-class-identities'
import { scanTestRequests, testCoverage, type TestRequestScan, type TestRequestSite, type UnresolvedReason } from './test-requests'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json'])

type Relation = (typeof GRAPH_RELATIONS)[number]
type Edge = ApplicationGraphInputs['edges'][number]
type Unresolved = ApplicationGraphInputs['unresolved'][number] & { relation: Relation }

/**
 * What each relation needs. `routes`: `only` when every edge starts at a registered route (no
 * reader without introspection), `half` when a source half remains. `inputs`: the node sections
 * it reads, whose incompleteness leaves it partial.
 */
const RELATIONS: Record<Relation, { routes: 'none' | 'half' | 'only'; inputs: readonly string[] }> = {
  renders: { routes: 'none', inputs: ['controller', 'page'] },
  validates: { routes: 'half', inputs: ['controller', 'validator'] },
  authorizes: { routes: 'half', inputs: ['controller', 'policy'] },
  handles: { routes: 'only', inputs: ['controller'] },
  binds: { routes: 'only', inputs: ['model'] },
  usesMiddleware: { routes: 'only', inputs: [] },
  tests: { routes: 'only', inputs: ['test'] },
}
const RELATION_KEYS = Object.keys(RELATIONS) as Relation[]
/** Middleware nodes are the router's registered aliases and groups, so they need routes too. */
const ROUTE_ONLY_SECTIONS = ['middleware', ...RELATION_KEYS.filter((key) => RELATIONS[key].routes === 'only')]
const ROUTE_SECTIONS = [...ROUTE_ONLY_SECTIONS, ...RELATION_KEYS.filter((key) => RELATIONS[key].routes === 'half')]

const TEST_REQUEST_REASONS: Readonly<Record<UnresolvedReason, string>> = {
  dynamicPath: 'The request path is not spelled in the file.',
  partialSegment: 'A runtime value fills part of a path segment.',
  unknownReceiver: 'The request is made on what an imported helper returns.',
  localReceiver: 'The request is made on what a same-file function returns without a TestApp annotation.',
  routePattern: 'The route pattern could not be compared with the request path.',
  routeOrder: 'An earlier route, or an unknown module order, may answer the request first.',
}

async function readSources(cwd: string): Promise<{ sources: Record<string, string>; failures: string[] }> {
  const sources: Record<string, string> = {}
  const failures: string[] = []
  async function visit(directory: string): Promise<void> {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch {
      failures.push(toPosixRelative(cwd, directory) || '.')
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || NON_SOURCE_DIR_NAMES.has(entry.name)) continue
      const file = resolve(directory, entry.name)
      if (entry.isDirectory()) { await visit(file); continue }
      const relative = toPosixRelative(cwd, file)
      if (entry.isSymbolicLink()) { failures.push(relative); continue }
      if (!SOURCE_EXTENSIONS.has(extname(file))) continue
      try { sources[relative] = await readFile(file, 'utf8') } catch { failures.push(relative) }
    }
  }
  await visit(cwd)
  return { sources, failures }
}

export async function loadApplicationGraph(options: { cwd: string; introspect?: boolean }): Promise<GurenApplicationGraph> {
  const cwd = resolve(options.cwd)
  const input: ApplicationGraphInputs = { nodes: [], edges: [], unresolved: [], coverage: {}, capturedAt: new Date().toISOString() }
  let sources: Record<string, string> = {}
  const parsed = new Map<string, Promise<ParseOutcome>>()
  const cache = new class extends ParseCache {
    override read(file: string): Promise<ParseOutcome> {
      let result = parsed.get(file)
      if (!result) {
        const source = sources[toPosixRelative(cwd, file)]
        const ast = source === undefined ? null : parseSourceFile(source, file)
        result = Promise.resolve(source === undefined ? { status: 'unreadable' } : ast ? { status: 'parsed', source, ast } : { status: 'unparsed', source })
        parsed.set(file, result)
      }
      return result
    }
  }()
  const complete = (): GraphCoverage => ({ status: 'complete', reasons: [] })
  const failure = (key: string, code: string, file?: string): void => {
    const reasons = input.coverage[key]?.reasons ?? []
    if (reasons.some((reason) => reason.code === code && reason.file === file)) return
    input.coverage[key] = { status: 'partial', reasons: [...reasons, { code, message: `Could not fully read ${key}: ${code}.`, ...(file ? { file } : {}) }] }
  }
  const unresolve = (entry: Unresolved, code: string, file?: string): void => {
    input.unresolved.push(entry)
    failure(entry.relation, code, file)
  }
  const unavailable = (key: string, code: string, message: string): void => {
    input.coverage[key] = { status: 'unavailable', reasons: [{ code, message }] }
  }
  const section = async (key: string, read: () => Promise<void>): Promise<void> => {
    input.coverage[key] = complete()
    try { await read() } catch (error) {
      if (error instanceof FileDiscoveryError) failure(key, 'unreadable-directory', toPosixRelative(cwd, error.directory))
      else failure(key, 'read-failed')
    }
  }
  const add = (kind: GraphNode['kind'], file: string, label: string): GraphNode => {
    const entry: GraphNode = { id: graphId(kind, file, label), kind, label, module: moduleNameFromRelPath(file), file, evidence: [{ kind: 'static', source: 'source', file }] }
    input.nodes.push(entry)
    return entry
  }
  const edges = new Map<string, { edge: Edge; seen: Set<string> }>()
  const link = (from: string, to: string, relation: Relation, evidence: GraphEvidence): void => {
    const key = graphId(from, to, relation)
    let entry = edges.get(key)
    if (!entry) {
      entry = { edge: { from, to, relation, evidence: [] }, seen: new Set() }
      edges.set(key, entry)
      input.edges.push(entry.edge)
    }
    const seen = graphId(evidence.kind, evidence.source, evidence.file ?? null, evidence.line ?? null)
    if (entry.seen.has(seen)) return
    entry.seen.add(seen)
    entry.edge.evidence.push(evidence)
  }
  /** A file-backed node's key by module path (extension dropped, as an import names it) and symbol. */
  const symbolKey = (absoluteFile: string, symbol: string): string => `${withoutExtension(absoluteFile)}#${symbol}`
  const controllerId = (declaration: ControllerDeclaration): string => graphId('controller', declaration.file, declaration.className)
  const imports = new Map<string, Promise<Map<string, ImportEntry>>>()
  const importsOf = (file: string): Promise<Map<string, ImportEntry>> => {
    let read = imports.get(file)
    if (!read) {
      read = cache.get(resolve(cwd, file)).then((outcome) => (outcome ? importsByLocal(outcome.ast.program.body) : new Map()))
      imports.set(file, read)
    }
    return read
  }

  let before: Record<string, string> = {}
  await section('source', async () => {
    const initial = await readSources(cwd)
    sources = initial.sources
    for (const file of initial.failures) failure('source', 'unreadable', file)
    before = Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, graphDigest(source)]))
  })
  // Started once the sources are fingerprinted, so registration overlaps the static readers, which read only `sources`.
  const registration = options.introspect === false ? undefined : introspectApp(cwd, { fresh: true, graph: true, timeoutMs: CHECK_INTROSPECT_TIMEOUT_MS })

  let controllers: ControllerDeclaration[] = []
  await section('controller', async () => {
    const { scan, nodes } = await readControllerGraph(cwd, cache)
    controllers = scan.declarations
    input.nodes.push(...nodes)
    for (const file of scan.unreadableFiles) failure('controller', 'unreadable', file)
    for (const file of scan.unparsedFiles) failure('controller', 'unparsed', file)
  })
  await section('model', async () => {
    const reading = await readModelGraph(cwd, cache)
    input.nodes.push(...reading.nodes)
    for (const file of reading.unsupportedFiles) failure('model', 'unparsed-or-unsupported', file)
  })
  await section('page', async () => {
    const reading = await readPageGraph(cwd, cache)
    input.nodes.push(...reading.nodes)
    for (const file of reading.unparsedFiles) failure('page', 'unparsed-or-unreadable', file)
  })
  const validators = new Map<string, GraphNode>()
  await section('validator', async () => {
    const reading = await readValidatorGraph(cwd, cache, (file) => failure('validator', 'unparsed-or-unsupported', file))
    if (isUnreadable(reading.exports)) { failure('validator', 'unreadable-directory'); return }
    for (const node of reading.nodes) {
      const key = symbolKey(resolve(cwd, node.file!), node.label)
      // A name exported twice, or a `.ts` and its emitted `.js` twin, would give one key two nodes.
      if (validators.has(key)) { failure('validator', 'duplicate-export', node.file); continue }
      input.nodes.push(node)
      validators.set(key, node)
    }
  })
  const policies: Array<{ node: GraphNode; file: string }> = []
  await section('policy', async () => {
    for (const { file, className } of await readSourceClassIdentities(cwd, discoverPolicyFiles)) {
      const absolute = resolve(cwd, file)
      const parsed = await cache.get(absolute)
      const abilities = parsed ? readPolicyAbilities(parsed.ast, className) : undefined
      if (!abilities || 'unreadable' in abilities) { failure('policy', 'unparsed-or-unsupported', file); continue }
      if (policies.some((entry) => withoutExtension(entry.file) === withoutExtension(absolute))) { failure('policy', 'source-twin', file); continue }
      policies.push({ node: add('policy', file, className), file: absolute })
    }
  })
  let testFiles: string[] = []
  let testScan: TestRequestScan = { requests: [], unresolved: [], unparsed: [] }
  await section('test', async () => {
    testFiles = (await discoverTestFiles(cwd)).sort()
    for (const absolute of testFiles) {
      const file = toPosixRelative(cwd, absolute)
      add('test', file, file)
    }
    testScan = await scanTestRequests(cwd, testFiles, cache)
  })

  input.coverage.renders = complete()
  for (const declaration of controllers) {
    const from = controllerId(declaration)
    for (const [action, method] of declaration.methods) {
      const refs = extractInertiaPageRefs(method.rawBody, (offset) => method.body.slice(offset).startsWith('this.inertia'))
      for (const ref of refs) {
        const candidates = input.nodes.filter((entry) => entry.kind === 'page' && entry.label === ref.id)
        if (candidates.length === 1) link(from, candidates[0]!.id, 'renders', { kind: 'static', source: `controller:${action}`, file: declaration.file, line: method.line })
        else unresolve({ from, relation: 'renders', target: ref.id, reason: 'Page missing or ambiguous.' }, 'unresolved-page', declaration.file)
      }
      const calls = [...method.body.matchAll(/this\s*\.\s*inertia\s*\(/g)]
      const dynamic = calls.some((call) => !/^this\.inertia\(\s*(?:pages(?:\.\w+|\[['"][^'"]+['"]\])+|['"][^'"]+['"])/.test(method.rawBody.slice(call.index)))
      if (dynamic) unresolve({ from, relation: 'renders', target: action, reason: 'A page reference is dynamic or unsupported.' }, 'dynamic-page', declaration.file)
    }
  }

  await section('validates', async () => {
    for (const declaration of controllers) {
      const from = controllerId(declaration)
      const imported = await importsOf(declaration.file)
      for (const [action, method] of declaration.methods) {
        const captured = [...method.body.matchAll(VALIDATE_CALL_PATTERN)]
        if (captured.length < [...method.body.matchAll(VALIDATE_MEMBER_CALL_PATTERN)].length) {
          unresolve({ from, relation: 'validates', target: `${declaration.className}.${action}`, reason: 'A validate call passes an expression the reader cannot follow to a schema.' }, 'dynamic-schema', declaration.file)
        }
        for (const match of captured) {
          const chain = match[1]!.replace(/\s+/g, '')
          const target = importedSymbol(declaration.file, imported, chain, validators)
          if (target) link(from, target.id, 'validates', { kind: 'static', source: `controller:${action}`, file: declaration.file, line: method.line })
          else unresolve({ from, relation: 'validates', target: chain, reason: `${declaration.className}.${action} validates with a schema not imported from a validator file export.` }, 'unresolved-validator', declaration.file)
        }
      }
    }
  })
  await section('authorizes', async () => {
    const bindings = await policyBindings(cwd, cache)
    for (const declaration of controllers) {
      const from = controllerId(declaration)
      const controllerFile = resolve(cwd, declaration.file)
      const imported = await importsOf(declaration.file)
      const referenced = policies.flatMap(({ node, file }) =>
        importReferencePatterns(cwd, controllerFile, imported, file, node.label).map((pattern) => ({ node, pattern })))
      // Imported under a policy's name from a file that is no policy node (a barrel, an alias): a name match only.
      const byNameOnly = [...imported].flatMap(([local, entry]) => (!entry.typeOnly && entry.kind === 'named'
        && policies.some(({ node }) => node.label === entry.imported)
        && !referenced.some(({ pattern }) => pattern.test(local)) ? [{ label: entry.imported, pattern: wholeIdentifierPattern(local) }] : []))
      const named = bindings.length > 0 ? await modelPatterns(cwd, controllerFile, bindings, cache) : new Map<PolicyBinding, RegExp[]>()
      for (const [action, method] of declaration.methods) {
        for (const { node } of referenced.filter(({ pattern }) => pattern.test(method.body))) {
          link(from, node.id, 'authorizes', { kind: 'static', source: `controller:${action}`, file: declaration.file, line: method.line })
        }
        for (const { label } of byNameOnly.filter(({ pattern }) => pattern.test(method.body))) {
          unresolve({ from, relation: 'authorizes', target: label, reason: `${declaration.className}.${action} names ${label}, imported from a path that does not resolve to its policy file.` }, 'unresolved-policy-import', declaration.file)
        }
        if (!consultsAuthorization(method.body)) continue
        const key = `${declaration.className}.${action}`
        const candidates = bindings.filter((binding) => named.get(binding)?.some((pattern) => pattern.test(method.body)))
        for (const binding of candidates) {
          input.unresolved.push({ from, relation: 'authorizes', target: binding.policy,
            reason: `${key} consults the gate and names ${binding.model}; ${binding.policy} is paired by name only, since gate.policy() binds it at boot, which the graph does not run.` })
        }
        if (candidates.length === 0) {
          input.unresolved.push({ from, relation: 'authorizes', target: key, reason: `${key} consults the gate; the policy it reaches is bound at boot, which the graph does not run.` })
        }
        failure('authorizes', 'boot-bound-policy', declaration.file)
      }
    }
  })

  if (registration) {
    await section('route', async () => {
      const result = await registration
      if (result.status === 'failed') { failure('route', result.reason); return }
      addRoutes(result.manifest)
      for (const warning of result.manifest.warnings) {
        // A note on rendering a contract schema as JSON Schema, which the graph does not read.
        if (warning.code === 'schema-partial') continue
        failure(GRAPH_SCAN_WARNINGS[warning.code as keyof typeof GRAPH_SCAN_WARNINGS] ?? 'route', warning.code)
      }
    })
  } else {
    const message = 'Registration introspection is disabled; routes are not executed.'
    unavailable('route', 'disabled', message)
    for (const key of ROUTE_ONLY_SECTIONS) unavailable(key, 'disabled', `${message} This section is read from registered routes only.`)
  }
  for (const key of ROUTE_SECTIONS) {
    if (input.coverage.route!.status === 'unavailable' && input.coverage[key]?.status !== 'unavailable') failure(key, 'routes-disabled')
    else if (input.coverage.route!.status === 'partial') failure(key, 'incomplete-routes')
  }
  for (const relation of RELATION_KEYS) {
    if (input.coverage[relation]?.status === 'unavailable') continue
    for (const key of RELATIONS[relation].inputs) {
      if (input.coverage[key]?.status !== 'complete') failure(relation, `incomplete-${key}`)
    }
  }
  await section('freshness', async () => {
    const final = await readSources(cwd)
    for (const file of final.failures) failure('freshness', 'unreadable', file)
    const after = Object.fromEntries(Object.entries(final.sources).map(([file, source]) => [file, graphDigest(source)]))
    input.changed = graphDigest(before) !== graphDigest(after)
    if (input.changed) failure('freshness', 'source-changed')
  })
  input.fingerprints = before
  if (input.coverage.source?.status !== 'complete' || input.coverage.freshness?.status !== 'complete') input.changed = true
  return buildApplicationGraph(input)

  /** The node an import-resolved identifier (or `namespace.name`) names, never one matched by name alone. */
  function importedSymbol(file: string, imported: Map<string, ImportEntry>, chain: string, symbols: Map<string, GraphNode>): GraphNode | undefined {
    const [local, member, ...rest] = chain.split('.')
    const entry = imported.get(local!)
    if (!entry || entry.typeOnly || rest.length > 0) return undefined
    const base = specifierBase(cwd, resolve(cwd, file), entry.source)
    if (base === null) return undefined
    if (member === undefined && entry.kind === 'named') return symbols.get(symbolKey(base, entry.imported))
    if (member !== undefined && entry.kind === 'namespace') return symbols.get(symbolKey(base, member))
    return undefined
  }

  function addRoutes(manifest: AppManifest): void {
    for (const key of ROUTE_ONLY_SECTIONS) input.coverage[key] = complete()
    const aliases = manifest.middlewareAliases ?? {}
    const middlewareId = (name: string): string => graphId('middleware', name)
    for (const [name, entry] of Object.entries(aliases)) {
      input.nodes.push({ id: middlewareId(name), kind: 'middleware', label: name, module: null, evidence: [{ kind: 'registered', source: `introspection:${entry.kind}` }] })
    }
    const occurrences = new Map<string, number>()
    const routeIds: string[] = []
    for (const [order, route] of (manifest.routes as GraphRouteEntry[]).entries()) {
      const identity = graphId(route.module, route.method, route.path, route.name ?? null)
      const occurrence = occurrences.get(identity) ?? 0
      occurrences.set(identity, occurrence + 1)
      const id = graphId('route', route.module, route.method, route.path, route.name ?? null, occurrence)
      routeIds.push(id)
      const evidence: GraphEvidence = { kind: 'registered', source: 'introspection' }
      input.nodes.push({ id, kind: 'route', label: route.name ?? `${route.method} ${route.path}`, module: route.module,
        route: { method: route.method, path: route.path, ...(route.name ? { name: route.name } : {}), ...(route.controller ? { action: route.controller.action } : {}), order }, evidence: [evidence] })
      if (route.controller) {
        const ref = route.controller
        const matched = controllers.filter((entry) => ref.resolved === 'identity'
          ? entry.file === ref.file && entry.exportNames.includes(ref.exportName ?? '')
          : false)
        if (matched.length === 1) link(id, controllerId(matched[0]!), 'handles', evidence)
        else unresolve({ from: id, relation: 'handles', target: `${ref.name}.${ref.action}`, reason: 'Controller identity is unavailable or ambiguous.' }, 'controller-identity')
      }
      for (const [parameter, name] of Object.entries(route.bindings ?? {})) {
        const identity = route.bindingSources?.[parameter]
        const candidates = input.nodes.filter((entry) => identity && entry.kind === 'model' && entry.label === identity.name && entry.file === identity.file)
        if (candidates.length === 1) link(id, candidates[0]!.id, 'binds', { kind: 'registered', source: `binding:${parameter}` })
        else unresolve({ from: id, relation: 'binds', target: name, reason: 'Bound model identity is unavailable or ambiguous.' }, 'model-identity')
      }
      for (const entry of route.middleware ?? []) useMiddleware(id, entry)
      for (const key of CONTRACT_SEGMENTS) {
        if (route.schemas?.[key] === undefined) continue
        const sources = route.contractSources?.[key]
        const targets = (sources ?? []).flatMap(({ file, exportName }) => validators.get(symbolKey(resolve(cwd, file), exportName)) ?? [])
        if (sources?.length === 1 && targets.length === 1) {
          link(id, targets[0]!.id, 'validates', { kind: 'registered', source: `contract:${key}` })
          continue
        }
        unresolve({ from: id, relation: 'validates', target: `${route.method} ${route.path} ${key}`, reason: contractReason(key, sources) }, 'contract-identity')
      }
    }
    addTests(manifest, routeIds)

    function useMiddleware(from: string, entry: MiddlewareEntry): void {
      if (entry.capabilities.authorization !== undefined) {
        unresolve({ from, relation: 'authorizes', target: entry.ability ?? entry.name ?? 'inline middleware',
          reason: 'Authorization middleware checks an ability; the gate resolves its policy at request time.' }, 'middleware-authorization')
      }
      if (entry.kind === 'inline') {
        unresolve({ from, relation: 'usesMiddleware', target: entry.name ?? '<anonymous>', reason: 'Inline middleware has no registered identity; two handlers may share a function name.' }, 'inline-middleware')
        return
      }
      if (entry.unresolved || entry.name === null || !(entry.name in aliases)) {
        unresolve({ from, relation: 'usesMiddleware', target: entry.name ?? '<unnamed>', reason: 'No alias or group registers this name.' }, 'unregistered-middleware')
        return
      }
      link(from, middlewareId(entry.name), 'usesMiddleware', { kind: 'registered', source: 'middleware' })
      for (const member of entry.members ?? []) {
        if (member in aliases) link(from, middlewareId(member), 'usesMiddleware', { kind: 'registered', source: `group:${entry.name}` })
      }
      for (const member of entry.unresolvedMembers ?? []) {
        unresolve({ from, relation: 'usesMiddleware', target: member, reason: `Group ${entry.name} names an alias nothing registers.` }, 'unregistered-middleware')
      }
    }
  }

  /** `TestApp` requests hung off the route answering them, as Impact reads them; found, never run. */
  function addTests(manifest: AppManifest, routeIds: string[]): void {
    for (const file of testScan.unparsed) failure('tests', 'unparsed', file)
    const tools = new Map((manifest.agentTools ?? []).map((tool) => [tool.routeName, tool.toolName]))
    const routes = manifest.routes.map((route) => {
      const toolName = route.name === undefined ? undefined : tools.get(route.name)
      return { method: route.method, path: route.path, ...(toolName !== undefined ? { toolName } : {}) }
    })
    const coverage = testCoverage(testScan, routes, { registered: { provenance: manifest.routes.map((route) => route.module), modulesIncomplete: false } })
    const testId = (file: string): string => graphId('test', file, file)
    // `testCoverage` copies each site, so a request is recognised by where it is written.
    const siteKey = (site: TestRequestSite): string => graphId(site.file, site.line, site.text)
    const reached = new Set<string>()
    for (const [index, sites] of coverage.byRoute) {
      for (const site of sites) {
        reached.add(siteKey(site))
        link(testId(site.file), routeIds[index]!, 'tests', { kind: 'static', source: 'request', file: site.file, line: site.line })
      }
    }
    for (const [index, requests] of coverage.uncertainByRoute) {
      for (const request of requests) {
        reached.add(siteKey(request))
        unresolve({ from: testId(request.file), relation: 'tests', target: routeIds[index]!, reason: `${request.text} (line ${request.line}): ${TEST_REQUEST_REASONS[request.reason]}` }, request.reason, request.file)
      }
    }
    for (const request of coverage.unresolved) {
      unresolve({ from: testId(request.file), relation: 'tests', target: request.text, reason: `Line ${request.line}: ${TEST_REQUEST_REASONS[request.reason]}` }, request.reason, request.file)
    }
    // Established, not unread: no registered route answers the request (a test of a 404, or a stale path).
    for (const request of testScan.requests) {
      if (reached.has(siteKey(request))) continue
      input.unresolved.push({ from: testId(request.file), relation: 'tests', target: request.text, reason: `Line ${request.line}: no registered route answers this request.` })
    }
  }
}

function contractReason(key: string, sources: Array<{ file: string; exportName: string }> | undefined): string {
  if (sources === undefined) return `The ${key} contract schema's identity was not read.`
  if (sources.length === 0) return `The ${key} contract schema is not an export of a validator file.`
  return `The ${key} contract schema is exported as ${sources.map((entry) => `${entry.file}#${entry.exportName}`).join(', ')}, which does not resolve to one validator.`
}
