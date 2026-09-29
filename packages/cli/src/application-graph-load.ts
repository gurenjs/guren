import { readFile, readdir } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import type { AppManifest } from '@guren/server'

import { buildApplicationGraph, graphDigest, graphId, type ApplicationGraphInputs, type GraphCoverage, type GraphEvidence, type GraphNode, type GurenApplicationGraph } from './application-graph'
import { collectFiles, moduleNameFromRelPath, NON_SOURCE_DIR_NAMES, toPosixRelative } from './discovery'
import { parseControllerMethods, type ControllerDeclaration } from './controller-methods'
import { discoverModelClasses } from './model-parser'
import { extractInertiaPageRefs, PAGE_COMPONENT_EXTENSIONS } from './inertia-pages'
import { CHECK_INTROSPECT_TIMEOUT_MS, introspectApp } from './introspect'
import { ParseCache, parseSourceFile, type ParseOutcome } from './parse-cache'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json'])

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
  const section = async (key: string, read: () => Promise<void>): Promise<void> => {
    input.coverage[key] = complete()
    try { await read() } catch { failure(key, 'read-failed') }
  }
  const source = (file: string): GraphEvidence[] => [{ kind: 'static', source: 'source', file }]
  const add = (kind: GraphNode['kind'], file: string, label: string): GraphNode => {
    const entry: GraphNode = { id: graphId(kind, file, label), kind, label, module: moduleNameFromRelPath(file), file, evidence: source(file) }
    input.nodes.push(entry)
    return entry
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
  if (options.introspect !== false) {
    await section('route', async () => {
      const result = await introspectApp(cwd, { fresh: true, modelBindings: true, timeoutMs: CHECK_INTROSPECT_TIMEOUT_MS })
      if (result.status === 'failed') { failure('route', result.reason); return }
      addRoutes(result.manifest)
      for (const warning of result.manifest.warnings) failure('route', warning.code)
    })
  } else {
    input.coverage.route = { status: 'unavailable', reasons: [{ code: 'disabled', message: 'Registration introspection is disabled; routes are not executed.' }] }
  }
  for (const relation of ['handles', 'binds']) {
    if (input.coverage.route.status !== 'complete') failure(relation, 'incomplete-routes')
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

  function addRoutes(manifest: AppManifest): void {
    input.coverage.handles = complete()
    input.coverage.binds = complete()
    const occurrences = new Map<string, number>()
    for (const [order, route] of manifest.routes.entries()) {
      const identity = graphId(route.module, route.method, route.path, route.name ?? null)
      const occurrence = occurrences.get(identity) ?? 0
      occurrences.set(identity, occurrence + 1)
      const id = graphId('route', route.module, route.method, route.path, route.name ?? null, occurrence)
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
    }
    if (input.coverage.controller?.status !== 'complete') failure('handles', 'incomplete-controllers')
    if (input.coverage.model?.status !== 'complete') failure('binds', 'incomplete-models')
  }
}
