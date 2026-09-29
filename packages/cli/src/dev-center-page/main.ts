import type { GraphNode, GurenApplicationGraph, GraphResult } from '../application-graph'
import { runtimeErrorResultSchema } from '../runtime-errors'

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing element: ${id}`)
  return node as T
}
function text(tag: string, value: string, className?: string): HTMLElement {
  const node = document.createElement(tag)
  node.textContent = value
  if (className) node.className = className
  return node
}
let graph: GurenApplicationGraph | undefined
let selected: string | undefined
const nodes = element('nodes')
const detail = element('detail')
const search = element<HTMLInputElement>('search')
const kind = element<HTMLSelectElement>('kind')
const refresh = element<HTMLButtonElement>('refresh')
const errorsButton = element<HTMLButtonElement>('refresh-errors')

function showNode(node: GraphNode): void {
  selected = node.id
  detail.replaceChildren(text('span', node.kind, 'tag'), text('h2', node.label), text('p', `Module: ${node.module ?? 'app'}`))
  if (node.file) detail.append(text('pre', node.file))
  if (node.route) detail.append(text('pre', JSON.stringify(node.route, null, 2)))
  detail.append(text('h3', 'Evidence'), text('pre', JSON.stringify(node.evidence, null, 2)), text('h3', 'Relationships'))
  const edges = graph!.edges.filter((edge) => edge.from === node.id || edge.to === node.id)
  if (!edges.length) detail.append(text('p', 'No resolved relationships in this snapshot.'))
  for (const edge of edges) {
    const outgoing = edge.from === node.id
    const target = graph!.nodes.find((candidate) => candidate.id === (outgoing ? edge.to : edge.from))
    if (!target) continue
    const button = text('button', `${outgoing ? '→' : '←'} ${edge.relation} · ${target.label}`, 'node') as HTMLButtonElement
    button.type = 'button'
    button.onclick = () => { showNode(target); renderNodes() }
    const evidence = text('details', '')
    evidence.append(text('summary', 'Relationship evidence'), text('pre', JSON.stringify(edge.evidence, null, 2)))
    detail.append(button, evidence)
  }
}
function renderNodes(): void {
  nodes.replaceChildren()
  if (!graph) return
  const query = search.value.toLowerCase()
  const matching = graph.nodes.filter((node) => (!kind.value || node.kind === kind.value)
    && [node.label, node.file, node.module].some((value) => value?.toLowerCase().includes(query)))
  if (!matching.length) nodes.append(text('p', 'No matching symbols in this snapshot.'))
  for (const node of matching) {
    const button = text('button', '', 'node') as HTMLButtonElement
    button.type = 'button'
    button.setAttribute('aria-pressed', String(node.id === selected))
    button.append(text('span', node.kind, 'tag'), document.createTextNode(node.label), text('div', `${node.module ?? 'app'}${node.file ? ` · ${node.file}` : ''}`, 'meta'))
    button.onclick = () => { showNode(node); renderNodes() }
    nodes.append(button)
  }
}
async function readJson(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: 'no-store', redirect: 'error' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}
async function loadGraph(): Promise<void> {
  refresh.disabled = true
  const status = element('graph-status')
  status.textContent = 'Reading application…'
  try {
    // The local endpoint returns the same versioned union as the CLI and MCP.
    const result = await readJson('/_guren/graph.json') as GraphResult
    if ('error' in result) throw new Error(result.error.message)
    if (result.schemaVersion !== 1 || !result.snapshot || !Array.isArray(result.nodes)) throw new Error('Unsupported graph payload')
    graph = result
    const incomplete = Object.values(graph.coverage).some((section) => section.status !== 'complete')
    status.textContent = `${graph.nodes.length} symbols · ${graph.edges.length} relationships · ${incomplete ? 'Incomplete coverage' : 'Complete coverage'}${graph.snapshot.consistency === 'changed' ? ' · Sources changed during scan; refresh again' : ''}`
    status.className = incomplete || graph.snapshot.consistency === 'changed' ? 'warning' : 'good'
    element('snapshot').textContent = `Captured ${graph.snapshot.capturedAt} · Snapshot ${graph.snapshot.id}`
    const coverage = element('coverage')
    coverage.replaceChildren()
    for (const [name, section] of Object.entries(graph.coverage)) {
      const item = text('details', '')
      item.append(text('summary', `${name} · ${section.status}`, section.status === 'complete' ? 'good' : 'warning'))
      for (const reason of section.reasons) item.append(text('p', `${reason.code}: ${reason.message}${reason.file ? ` (${reason.file})` : ''}`))
      coverage.append(item)
    }
    element('unresolved-title').textContent = `Unresolved relationships (${graph.unresolved.length})`
    element('unresolved').replaceChildren(...graph.unresolved.map((item) => text('li', `${item.relation ?? 'reference'}: ${item.target} — ${item.reason}`)))
    const previous = graph.nodes.find((node) => node.id === selected)
    if (previous) showNode(previous)
    else { selected = undefined; detail.replaceChildren() }
    renderNodes()
  } catch (error) {
    status.textContent = `Graph unavailable: ${error instanceof Error ? error.message : 'Read failed'}. Refresh to retry.`
    status.className = 'error'
    graph = undefined
    nodes.replaceChildren(); detail.replaceChildren(); element('coverage').replaceChildren(); element('unresolved').replaceChildren()
    element('snapshot').textContent = ''
    element('unresolved-title').textContent = 'Unresolved relationships (unavailable)'
  } finally { refresh.disabled = false }
}
async function loadErrors(): Promise<void> {
  errorsButton.disabled = true
  const status = element('error-status')
  status.textContent = 'Reading runtime errors…'
  const list = element('errors')
  list.replaceChildren()
  try {
    // Read the complete retained window (at most 100), replacing the UI on every refresh.
    const result = runtimeErrorResultSchema.parse(await readJson('/_guren/runtime/errors?limit=100'))
    if (result.status === 'unavailable') { status.textContent = `Unavailable: ${result.reason}`; return }
    status.textContent = `${result.events.length} retained errors · ${result.dropped} dropped · Session ${result.sessionId} · Collection started ${result.startedAt}${result.cursorExpired ? ' · Earlier events are no longer retained' : ''}`
    if (!result.events.length) list.append(text('p', 'No retained server exceptions in this collection window.'))
    for (const event of [...result.events].reverse()) {
      const row = text('article', '', 'event')
      row.append(text('strong', `${event.status} · ${event.method} ${event.route?.pattern ?? '(route unavailable)'}`), text('div', `${event.occurredAt} · #${event.sequence} · Runtime correlation: ${event.correlation}`, 'meta'))
      if (event.route) row.append(text('div', event.route.name ?? '', 'meta'))
      row.append(text('pre', event.frames.map((frame) => `${frame.file}:${frame.line ?? '?'}:${frame.column ?? '?'}`).join('\n') || 'No project-local stack locations.'))
      list.append(row)
    }
  } catch (error) { status.textContent = `Runtime unavailable: ${error instanceof Error ? error.message : 'Read failed'}. Refresh to retry.` }
  finally { errorsButton.disabled = false }
}
search.oninput = renderNodes
kind.onchange = renderNodes
refresh.onclick = () => { void loadGraph() }
errorsButton.onclick = () => { void loadErrors() }
void loadGraph()
void loadErrors()
