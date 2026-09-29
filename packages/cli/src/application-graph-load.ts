import { readFile, readdir } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import type { AppManifest, MiddlewareEntry } from '@guren/server'

import { buildApplicationGraph, graphDigest, graphId, type ApplicationGraphInputs, type GraphCoverage, type GraphEvidence, type GraphNode, type GurenApplicationGraph } from './application-graph'
import { GATE_CALL_PATTERN, modelPatterns, policyBindings, type PolicyBinding } from './authorization-audit'
import { CONTRACT_SEGMENTS } from './contract-segments'
import { AUTHORIZATION_CALL_PATTERN, parseControllerMethods, type ControllerDeclaration } from './controller-methods'
import {
  classNameFromPath, collectFiles, discoverPolicyFiles, discoverTestFiles, discoverValidatorFiles, excludeBarrelFiles,
  FileDiscoveryError, moduleNameFromRelPath, NON_SOURCE_DIR_NAMES, toPosixRelative,
} from './discovery'
import { discoverModelClasses } from './model-parser'
import { extractInertiaPageRefs, PAGE_COMPONENT_EXTENSIONS } from './inertia-pages'
import { CHECK_INTROSPECT_TIMEOUT_MS, introspectApp, type GraphRouteEntry } from './introspect'
import { ParseCache, parseSourceFile, type ParseOutcome } from './parse-cache'
import { exportedNames, VALIDATE_CALL_PATTERN } from './plan/app-detail'
import { readPolicyAbilities } from './plan/policy-abilities'
import { importsByLocal, specifierBase, withoutExtension, type ImportEntry } from './schema-binding'
import { scanTestRequests, testCoverage, type UnresolvedReason } from './test-requests'
import { escapeRegExp, wholeIdentifierPattern } from './utils'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json'])

/** Sections whose every edge starts at a registered route: without introspection they have no reader. */
const ROUTE_ONLY_SECTIONS = ['handles', 'binds', 'middleware', 'usesMiddleware', 'tests'] as const
/** Sections with a static half, which a missing route read leaves partial rather than unavailable. */
const ROUTE_HALF_SECTIONS = ['validates', 'authorizes'] as const

/** Graph-run warnings that concern one relation's identity scan rather than route registration. */
const WARNING_SECTIONS: Readonly<Record<string, string>> = {
  'model-import': 'binds',
  'validator-import': 'validates',
  'validator-discovery': 'validates',
}

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
    const previous = input.coverage[key]
    input.coverage[key] = { status: 'partial', reasons: [...(previous?.reasons ?? []), { code, message: `Could not fully read ${key}: ${code}.`, ...(file ? { file } : {}) }] }
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
  const source = (file: string): GraphEvidence[] => [{ kind: 'static', source: 'source', file }]
  const add = (kind: GraphNode['kind'], file: string, label: string): GraphNode => {
    const entry: GraphNode = { id: graphId(kind, file, label), kind, label, module: moduleNameFromRelPath(file), file, evidence: source(file) }
    input.nodes.push(entry)
    return entry
  }
  const edges = new Map<string, ApplicationGraphInputs['edges'][number]>()
  const link = (from: string, to: string, relation: ApplicationGraphInputs['edges'][number]['relation'], evidence: GraphEvidence): void => {
    const key = graphId(from, to, relation)
    const edge = edges.get(key)
    if (!edge) {
      const created = { from, to, relation, evidence: [evidence] }
      edges.set(key, created)
      input.edges.push(created)
    } else if (!edge.evidence.some((entry) => graphDigest(entry) === graphDigest(evidence))) {
      edge.evidence.push(evidence)
    }
  }
  /** A file-backed node's key by module path (extension dropped, as an import names it) and symbol. */
  const symbolKey = (absoluteFile: string, symbol: string): string => `${withoutExtension(absoluteFile)}#${symbol}`
  const importsOf = async (file: string): Promise<Map<string, ImportEntry>> => {
    const read = await cache.get(resolve(cwd, file))
    return read ? importsByLocal(read.ast.program.body) : new Map()
  }

  let before: Record<string, string> = {}
  await section('source', async () => {
    const initial = await readSources(cwd)
    sources = initial.sources
    for (const file of initial.failures) failure('source', 'unreadable', file)
    before = Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, graphDigest(source)]))
  })
  let controllers: ControllerDeclaration[] = []
  await section('controller', async () => {
    const scan = await parseControllerMethods(cwd, cache)
    controllers = scan.declarations
    for (const declaration of controllers) add('controller', declaration.file, declaration.className)
    for (const file of scan.unreadableFiles) failure('controller', 'unreadable', file)
    for (const file of scan.unparsedFiles) failure('controller', 'unparsed', file)
  })
  await section('model', async () => {
    for (const model of await discoverModelClasses(cwd, cache)) {
      const file = toPosixRelative(cwd, model.filePath)
      if (model.classDecl) add('model', file, model.className)
      else failure('model', 'unparsed-or-unsupported', file)
    }
  })
  await section('page', async () => {
    for (const absolute of await collectFiles(resolve(cwd, 'resources/js/pages'), PAGE_COMPONENT_EXTENSIONS)) {
      const file = toPosixRelative(cwd, absolute)
      const parsed = await cache.get(absolute)
      if (!parsed) { failure('page', 'unparsed-or-unreadable', file); continue }
      add('page', file, file.slice('resources/js/pages/'.length).replace(/\.(tsx|jsx)$/, ''))
    }
  })
  // The exported schema symbols `readValidatorExports()` reads, file by file, so one unparsed file narrows the section instead of emptying it.
  const validators = new Map<string, GraphNode>()
  await section('validator', async () => {
    for (const absolute of excludeBarrelFiles(await discoverValidatorFiles(cwd))) {
      const file = toPosixRelative(cwd, absolute)
      const parsed = await cache.get(absolute)
      const names = parsed ? exportedNames(parsed.ast, 'this file') : null
      if (names === null) { failure('validator', 'unparsed-or-unsupported', file); continue }
      for (const name of names.filter((entry) => entry !== 'default')) validators.set(symbolKey(absolute, name), add('validator', file, name))
    }
  })
  const policies = new Map<string, GraphNode>()
  await section('policy', async () => {
    for (const absolute of excludeBarrelFiles(await discoverPolicyFiles(cwd))) {
      const file = toPosixRelative(cwd, absolute)
      const className = classNameFromPath(absolute)
      const parsed = await cache.get(absolute)
      const abilities = parsed ? readPolicyAbilities(parsed.ast, className) : undefined
      if (!abilities || 'unreadable' in abilities) { failure('policy', 'unparsed-or-unsupported', file); continue }
      policies.set(withoutExtension(absolute), add('policy', file, className))
    }
  })
  let testFiles: string[] = []
  await section('test', async () => {
    testFiles = (await discoverTestFiles(cwd)).sort()
    for (const absolute of testFiles) {
      const file = toPosixRelative(cwd, absolute)
      add('test', file, file)
    }
  })

  input.coverage.renders = complete()
  for (const declaration of controllers) {
    const from = graphId('controller', declaration.file, declaration.className)
    for (const [action, method] of declaration.methods) {
      const refs = extractInertiaPageRefs(method.rawBody, (offset) => method.body.slice(offset).startsWith('this.inertia'))
      for (const ref of refs) {
        const candidates = input.nodes.filter((entry) => entry.kind === 'page' && entry.label === ref.id)
        if (candidates.length === 1) {
          input.edges.push({ from, to: candidates[0]!.id, relation: 'renders', evidence: [{ kind: 'static', source: `controller:${action}`, file: declaration.file, line: method.line }] })
        } else {
          input.unresolved.push({ from, relation: 'renders', target: ref.id, reason: 'Page missing or ambiguous.' })
          failure('renders', 'unresolved-page', declaration.file)
        }
      }
      const calls = [...method.body.matchAll(/this\s*\.\s*inertia\s*\(/g)]
      const dynamic = calls.some((call) => !/^this\.inertia\(\s*(?:pages(?:\.\w+|\[['"][^'"]+['"]\])+|['"][^'"]+['"])/.test(method.rawBody.slice(call.index)))
      if (dynamic) {
        input.unresolved.push({ from, relation: 'renders', target: action, reason: 'A page reference is dynamic or unsupported.' })
        failure('renders', 'dynamic-page', declaration.file)
      }
    }
  }
  if (input.coverage.controller?.status !== 'complete' || input.coverage.page?.status !== 'complete') failure('renders', 'incomplete-source')

  await section('validates', async () => {
    for (const declaration of controllers) {
      const from = graphId('controller', declaration.file, declaration.className)
      const imports = await importsOf(declaration.file)
      for (const [action, method] of declaration.methods) {
        for (const match of method.body.matchAll(VALIDATE_CALL_PATTERN)) {
          const chain = match[1]!.replace(/\s+/g, '')
          const target = importedSymbol(declaration.file, imports, chain, validators)
          if (target) {
            link(from, target.id, 'validates', { kind: 'static', source: `controller:${action}`, file: declaration.file, line: method.line })
          } else {
            input.unresolved.push({ from, relation: 'validates', target: chain, reason: `${declaration.className}.${action} validates with a schema not imported from a validator file export.` })
            failure('validates', 'unresolved-validator', declaration.file)
          }
        }
      }
    }
  })
  await section('authorizes', async () => {
    const bindings = await policyBindings(cwd, cache)
    for (const declaration of controllers) {
      const from = graphId('controller', declaration.file, declaration.className)
      const referenced = policyReferences(declaration.file, await importsOf(declaration.file))
      const named = bindings.length > 0 ? await modelPatterns(cwd, resolve(cwd, declaration.file), bindings, cache) : new Map<PolicyBinding, RegExp[]>()
      for (const [action, method] of declaration.methods) {
        const direct = referenced.filter(({ pattern }) => pattern.test(method.body))
        for (const { node } of direct) link(from, node.id, 'authorizes', { kind: 'static', source: `controller:${action}`, file: declaration.file, line: method.line })
        if (direct.length > 0 || !(AUTHORIZATION_CALL_PATTERN.test(method.body) || GATE_CALL_PATTERN.test(method.body))) continue
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
  for (const [relation, sections] of [['validates', ['controller', 'validator']], ['authorizes', ['controller', 'policy']]] as const) {
    if (sections.some((key) => input.coverage[key]?.status !== 'complete')) failure(relation, 'incomplete-source')
  }

  if (options.introspect !== false) {
    await section('route', async () => {
      const result = await introspectApp(cwd, { fresh: true, graph: true, timeoutMs: CHECK_INTROSPECT_TIMEOUT_MS })
      if (result.status === 'failed') { failure('route', result.reason); return }
      await addRoutes(result.manifest)
      for (const warning of result.manifest.warnings) failure(WARNING_SECTIONS[warning.code] ?? 'route', warning.code)
    })
  } else {
    const message = 'Registration introspection is disabled; routes are not executed.'
    unavailable('route', 'disabled', message)
    for (const key of ROUTE_ONLY_SECTIONS) unavailable(key, 'disabled', `${message} This section is read from registered routes only.`)
    for (const key of ROUTE_HALF_SECTIONS) failure(key, 'routes-disabled')
  }
  if (input.coverage.route!.status === 'partial') {
    for (const key of [...ROUTE_ONLY_SECTIONS, ...ROUTE_HALF_SECTIONS]) failure(key, 'incomplete-routes')
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
  function importedSymbol(file: string, imports: Map<string, ImportEntry>, chain: string, symbols: Map<string, GraphNode>): GraphNode | undefined {
    const [local, member, ...rest] = chain.split('.')
    const entry = imports.get(local!)
    if (!entry || rest.length > 0) return undefined
    const base = specifierBase(cwd, resolve(cwd, file), entry.source)
    if (base === null) return undefined
    if (member === undefined && entry.kind === 'named') return symbols.get(symbolKey(base, entry.imported))
    if (member !== undefined && entry.kind === 'namespace') return symbols.get(symbolKey(base, member))
    return undefined
  }

  /** How a controller file spells each policy class it imports: the import's local name, or `namespace.Policy`. */
  function policyReferences(file: string, imports: Map<string, ImportEntry>): Array<{ node: GraphNode; pattern: RegExp }> {
    const references: Array<{ node: GraphNode; pattern: RegExp }> = []
    for (const [local, entry] of imports) {
      const base = specifierBase(cwd, resolve(cwd, file), entry.source)
      const node = base === null ? undefined : policies.get(withoutExtension(base))
      if (!node) continue
      if (entry.kind === 'namespace') references.push({ node, pattern: new RegExp(`(?<![\\w$.])${escapeRegExp(local)}\\s*\\.\\s*${escapeRegExp(node.label)}(?![\\w$])`) })
      else if (entry.kind === 'default' || entry.imported === node.label) references.push({ node, pattern: wholeIdentifierPattern(local) })
    }
    return references
  }

  async function addRoutes(manifest: AppManifest): Promise<void> {
    for (const key of ['handles', 'binds', 'middleware', 'usesMiddleware'] as const) input.coverage[key] = complete()
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
      const evidence: GraphEvidence[] = [{ kind: 'registered', source: 'introspection' }]
      input.nodes.push({ id, kind: 'route', label: route.name ?? `${route.method} ${route.path}`, module: route.module,
        route: { method: route.method, path: route.path, ...(route.name ? { name: route.name } : {}), ...(route.controller ? { action: route.controller.action } : {}), order }, evidence })
      if (route.controller) {
        const ref = route.controller
        const matched = controllers.filter((entry) => ref.resolved === 'identity'
          ? entry.file === ref.file && entry.exportNames.includes(ref.exportName ?? '')
          : false)
        if (matched.length === 1) {
          input.edges.push({ from: id, to: graphId('controller', matched[0]!.file, matched[0]!.className), relation: 'handles', evidence })
        } else {
          input.unresolved.push({ from: id, relation: 'handles', target: `${ref.name}.${ref.action}`, reason: 'Controller identity is unavailable or ambiguous.' })
          failure('handles', 'controller-identity')
        }
      }
      for (const [parameter, name] of Object.entries(route.bindings ?? {})) {
        const identity = route.bindingSources?.[parameter]
        const candidates = input.nodes.filter((entry) => identity && entry.kind === 'model' && entry.label === identity.name && entry.file === identity.file)
        if (candidates.length === 1) {
          input.edges.push({ from: id, to: candidates[0]!.id, relation: 'binds', evidence: [{ kind: 'registered', source: `binding:${parameter}` }] })
        } else {
          input.unresolved.push({ from: id, relation: 'binds', target: name, reason: 'Bound model identity is unavailable or ambiguous.' })
          failure('binds', 'model-identity')
        }
      }
      for (const entry of route.middleware ?? []) useMiddleware(id, entry)
      for (const key of CONTRACT_SEGMENTS) {
        if (route.schemas?.[key] === undefined) continue
        const sources = route.contractSources?.[key]
        const targets = (sources ?? []).flatMap(({ file, exportName }) => validators.get(symbolKey(resolve(cwd, file), exportName)) ?? [])
        if (sources !== undefined && sources.length === 1 && targets.length === 1) {
          link(id, targets[0]!.id, 'validates', { kind: 'registered', source: `contract:${key}` })
          continue
        }
        const reason = sources === undefined
          ? `The ${key} contract schema's identity was not read.`
          : sources.length === 0 ? `The ${key} contract schema is not an export of a validator file.` : `The ${key} contract schema is exported as ${sources.map((entry) => `${entry.file}#${entry.exportName}`).join(', ')}, which does not resolve to one validator.`
        input.unresolved.push({ from: id, relation: 'validates', target: `${route.method} ${route.path} ${key}`, reason })
        failure('validates', 'contract-identity')
      }
    }
    if (input.coverage.controller?.status !== 'complete') failure('handles', 'incomplete-controllers')
    if (input.coverage.model?.status !== 'complete') failure('binds', 'incomplete-models')
    await addTests(manifest, routeIds)

    function useMiddleware(from: string, entry: MiddlewareEntry): void {
      if (entry.capabilities.authorization !== undefined) {
        input.unresolved.push({ from, relation: 'authorizes', target: entry.ability ?? entry.name ?? 'inline middleware',
          reason: 'Authorization middleware checks an ability; the gate resolves its policy at request time.' })
        failure('authorizes', 'middleware-authorization')
      }
      if (entry.kind === 'inline') {
        input.unresolved.push({ from, relation: 'usesMiddleware', target: entry.name ?? '<anonymous>', reason: 'Inline middleware has no registered identity; two handlers may share a function name.' })
        failure('usesMiddleware', 'inline-middleware')
        return
      }
      if (entry.unresolved || entry.name === null || !(entry.name in aliases)) {
        input.unresolved.push({ from, relation: 'usesMiddleware', target: entry.name ?? '<unnamed>', reason: 'No alias or group registers this name.' })
        failure('usesMiddleware', 'unregistered-middleware')
        return
      }
      link(from, middlewareId(entry.name), 'usesMiddleware', { kind: 'registered', source: 'middleware' })
      for (const member of entry.members ?? []) {
        if (member in aliases) link(from, middlewareId(member), 'usesMiddleware', { kind: 'registered', source: `group:${entry.name}` })
      }
      for (const member of entry.unresolvedMembers ?? []) {
        input.unresolved.push({ from, relation: 'usesMiddleware', target: member, reason: `Group ${entry.name} names an alias nothing registers.` })
        failure('usesMiddleware', 'unregistered-middleware')
      }
    }
  }

  /** `TestApp` requests hung off the route answering them, as Impact reads them; found, never run. */
  async function addTests(manifest: AppManifest, routeIds: string[]): Promise<void> {
    input.coverage.tests = complete()
    if (input.coverage.test?.status !== 'complete') failure('tests', 'incomplete-tests')
    const scan = await scanTestRequests(cwd, testFiles, cache)
    for (const file of scan.unparsed) failure('tests', 'unparsed', file)
    const tools = new Map((manifest.agentTools ?? []).map((tool) => [tool.routeName, tool.toolName]))
    const routes = manifest.routes.map((route) => {
      const toolName = route.name === undefined ? undefined : tools.get(route.name)
      return { method: route.method, path: route.path, ...(toolName !== undefined ? { toolName } : {}) }
    })
    const coverage = testCoverage(scan, routes, { registered: { provenance: manifest.routes.map((route) => route.module), modulesIncomplete: false } })
    const testId = (file: string): string => graphId('test', file, file)
    const reached = new Set<string>()
    for (const [index, sites] of coverage.byRoute) {
      for (const site of sites) {
        reached.add(`${site.file}:${site.line}:${site.text}`)
        link(testId(site.file), routeIds[index]!, 'tests', { kind: 'static', source: 'request', file: site.file, line: site.line })
      }
    }
    for (const [index, requests] of coverage.uncertainByRoute) {
      for (const request of requests) {
        reached.add(`${request.file}:${request.line}:${request.text}`)
        input.unresolved.push({ from: testId(request.file), relation: 'tests', target: routeIds[index]!, reason: `${request.text} (line ${request.line}): ${TEST_REQUEST_REASONS[request.reason]}` })
        failure('tests', request.reason, request.file)
      }
    }
    for (const request of coverage.unresolved) {
      input.unresolved.push({ from: testId(request.file), relation: 'tests', target: request.text, reason: `Line ${request.line}: ${TEST_REQUEST_REASONS[request.reason]}` })
      failure('tests', request.reason, request.file)
    }
    // Established, not unread: no registered route answers the request (a test of a 404, or a stale path).
    for (const request of scan.requests) {
      if (reached.has(`${request.file}:${request.line}:${request.text}`)) continue
      input.unresolved.push({ from: testId(request.file), relation: 'tests', target: request.text, reason: `Line ${request.line}: no registered route answers this request.` })
    }
  }
}
