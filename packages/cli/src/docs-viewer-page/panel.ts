/** The detail panel: a document, a satellite node or an open plan, and the panel's reading mode. */
import type { DocActorEvent } from '../docs-index'
import type { DocsViewerDoc } from '../docs-viewer'
import type { IssueLink } from '../issue-refs'
import { byId, el } from './dom'
import { markSelected } from './graph'
import { kindOf, type Verdict, type ViewEdge, type ViewNode } from './model'
import { appendPageLink, buildPlanDetail } from './plans'
import { state } from './state'

const VERDICT_GLYPH: Record<Verdict, string> = { pass: '●', warn: '▲', fail: '✕' }

interface MermaidApi {
  initialize(config: { startOnLoad: boolean; theme: string; securityLevel: string }): void
  run(options: { nodes: ArrayLike<HTMLElement> }): Promise<void>
}

declare global {
  interface Window {
    mermaid?: MermaidApi
  }
}

let panel: HTMLElement
let content: HTMLElement
let expandButton: HTMLElement
let expanded = false
const prefersDark = matchMedia('(prefers-color-scheme: dark)')

export function metaRow(grid: HTMLElement, key: string, value: string): void {
  grid.append(el('div', 'meta-key', key), el('div', 'meta-value', value))
}

/** Outlinks only: issue state lives on GitHub, and the viewer never fetches (RFC 0018). */
function issueRow(grid: HTMLElement, issues: IssueLink[]): void {
  const cell = el('div', 'meta-value')
  issues.forEach((issue, index) => {
    if (index > 0) cell.append(', ')
    cell.append(issue.url ? Object.assign(el('a', 'issue-link', issue.label), { href: issue.url, target: '_blank', rel: 'noopener noreferrer' }) : issue.label)
  })
  grid.append(el('div', 'meta-key', 'issues'), cell)
}

export function actorLine(event: Partial<DocActorEvent>): string {
  return (event.by || '—') + (event.at ? ` · ${event.at}` : '')
}

export function relationItem(target: string, verdict: Verdict, openTarget: string | null): HTMLLIElement {
  const li = el('li')
  li.append(el('span', `verdict ${verdict}`, VERDICT_GLYPH[verdict]))
  const span = el('span', `rel-target${openTarget ? ' as-link' : ''}`, target)
  if (openTarget) span.addEventListener('click', () => openPanel(openTarget))
  li.append(span)
  return li
}

function nodeLabel(id: string): string {
  const doc = state.docByPath.get(id)
  if (doc?.title) return doc.title
  const node = state.byId.get(id)
  if (!node) return id
  if (node.members) return `${node.label} ×${node.members.length}`
  return node.plan ? `${node.label} (${node.plan.standing})` : node.label
}

/** A titled list of edges, reading `endpoint` off each. */
export function relationSection(front: HTMLElement, title: string, spaced: boolean, edges: readonly ViewEdge[], endpoint: 'from' | 'to'): void {
  front.append(el('p', `panel-label${spaced ? ' panel-label-spaced' : ''}`, title))
  const list = el('ul', 'relations')
  if (edges.length === 0) list.append(el('li', 'rel-empty', 'Nothing links here.'))
  for (const edge of edges) list.append(relationItem(nodeLabel(edge[endpoint]), edge.verdict, edge[endpoint]))
  front.append(list)
}

function buildDocDetail(doc: DocsViewerDoc): HTMLElement {
  const root = el('article', 'doc-detail')
  const head = el('div', 'doc-head')
  head.append(el('p', 'path', doc.path), el('h1', '', doc.title || doc.path))
  if (doc.description) head.append(el('p', 'description', doc.description))

  const chips = el('div', 'chips')
  chips.append(el('span', 'chip chip-type', doc.type || 'untyped'))
  chips.append(el('span', `chip chip-status-${doc.status || 'stable'}`, doc.status || 'stable'))
  chips.append(el('span', `chip chip-trust-${doc.trustTier}`, doc.trustTier))
  if (doc.stale) chips.append(el('span', 'chip chip-stale', 'stale'))
  if (doc.closedPlanHash) chips.append(el('span', 'chip chip-plan', `closed ${doc.closedPlanHash.slice(0, 12)}`))
  head.append(chips)
  const page = state.data.planPages.find((entry) => entry.doc === doc.path)
  if (page) appendPageLink(head, page)
  root.append(head)

  const front = el('div', 'frontmatter')
  front.append(el('p', 'panel-label', 'Frontmatter'))
  const grid = el('div', 'meta-grid')
  metaRow(grid, 'type', doc.type || '—')
  metaRow(grid, 'status', doc.status || 'stable')
  metaRow(grid, 'generated', doc.generated ? actorLine(doc.generated) : '—')
  metaRow(grid, 'verified', doc.verified.length > 0 ? doc.verified.map(actorLine).join('\n') : '—')
  if (doc.closedPlanHash) metaRow(grid, 'plan_hash', doc.closedPlanHash)
  if (doc.staleAfter) metaRow(grid, 'stale_after', doc.staleAfter)
  if (doc.tags.length > 0) metaRow(grid, 'tags', doc.tags.join(', '))
  if (doc.issues.length > 0) issueRow(grid, doc.issues)
  front.append(grid)

  front.append(el('p', 'panel-label panel-label-spaced', 'Relations'))
  const list = el('ul', 'relations')
  const outgoing = state.edges.filter((edge) => edge.from === doc.path)
  if (outgoing.length === 0) list.append(el('li', 'rel-empty', 'No declared links.'))
  for (const edge of outgoing) {
    const node = state.byId.get(edge.to)
    list.append(relationItem(node ? node.label : edge.to, edge.verdict, node ? edge.to : null))
  }
  front.append(list)
  const verifiedBy = state.edges.filter((edge) => edge.to === doc.path && edge.relation === 'verifies')
  if (verifiedBy.length > 0) relationSection(front, 'Verified by', true, verifiedBy, 'from')
  root.append(front)

  const prose = el('div', 'prose')
  // The server renders the body and escapes every payload string it interpolates (docs-render.ts).
  prose.innerHTML = doc.html
  // data-target already carries the app-root path the server resolved, so this is a lookup.
  prose.querySelectorAll<HTMLElement>('.md-link').forEach((link) => {
    const target = link.dataset.target || ''
    if (!state.byId.has(target)) return
    link.classList.add('as-link')
    link.addEventListener('click', () => openPanel(target))
  })
  root.append(prose)
  return root
}

/** Each id the node stands for, with the test files whose titles carry it. */
function testSection(front: HTMLElement, node: ViewNode, spaced: boolean): void {
  front.append(el('p', `panel-label${spaced ? ' panel-label-spaced' : ''}`, node.members ? 'Acceptance ids' : 'Test files'))
  const list = el('ul', 'relations')
  for (const member of node.members ?? [{ id: node.id, label: node.label, verdict: 'pass' as Verdict }]) {
    const files = state.testFiles.get(member.label) ?? []
    const li = node.members ? relationItem(member.label, member.verdict, null) : el('li')
    li.classList.add('rel-member')
    const fileList = el('span', 'rel-files')
    if (files.length === 0) fileList.append(el('span', '', 'no test title carries this id'))
    for (const file of files) fileList.append(el('span', '', file))
    li.append(fileList)
    list.append(li)
  }
  front.append(list)
}

/** A note that names a command: the text around it as text, the command in a `<code>`. */
function noteWith(parts: Array<string | { code: string }>): HTMLElement {
  const note = el('p', 'rel-note')
  for (const part of parts) note.append(typeof part === 'string' ? part : el('code', '', part.code))
  return note
}

function buildSatelliteDetail(node: ViewNode): HTMLElement {
  const root = el('article', 'doc-detail')
  const head = el('div', 'doc-head')
  const kindLabel = node.members
    ? `${node.members.length} acceptance tests`
    : node.kind === 'entity' ? 'Model entity' : node.kind === 'test' ? 'Acceptance test' : 'Code'
  head.append(el('p', 'path', kindLabel), el('h1', 'mono-title', node.label))
  const page = node.kind === 'code' ? state.data.planPages.find((entry) => entry.plan === node.id) : undefined
  if (page) appendPageLink(head, page)
  root.append(head)

  const isPlan = (edge: ViewEdge): boolean => {
    const from = state.byId.get(edge.from)
    return from !== undefined && kindOf(from) === 'plan'
  }
  const incoming = state.edges.filter((edge) => edge.to === node.id && edge.relation !== 'derives' && edge.relation !== 'verifies')
  const plans = incoming.filter(isPlan)
  const governedBy = incoming.filter((edge) => !isPlan(edge))
  const feeds = state.edges.filter((edge) => edge.from === node.id && edge.relation === 'derives')
  const verifiedBy = state.edges.filter((edge) => edge.to === node.id && edge.relation === 'verifies')
  const verifies = state.edges.filter((edge) => edge.from === node.id && edge.relation === 'verifies')

  const front = el('div', 'frontmatter')
  if (governedBy.length > 0) relationSection(front, 'Governed by', false, governedBy, 'from')
  if (feeds.length > 0) relationSection(front, 'Feeds spec views', governedBy.length > 0, feeds, 'to')
  if (plans.length > 0) relationSection(front, 'Plans', governedBy.length + feeds.length > 0, plans, 'from')
  if (verifiedBy.length > 0) relationSection(front, 'Verified by', incoming.length + feeds.length > 0, verifiedBy, 'from')
  if (verifies.length > 0) relationSection(front, 'Verifies', false, verifies, 'to')
  if (node.kind === 'test') testSection(front, node, verifies.length > 0)
  if (node.kind !== 'test' && incoming.length === 0 && feeds.length === 0 && verifiedBy.length === 0) {
    relationSection(front, 'Unlinked', false, [], 'from')
  }
  root.append(front)

  if (node.kind === 'test') {
    root.append(noteWith([
      node.members ? 'Ids verifying the same documents, grouped (toggle group tests). ' : '',
      'A test whose title carries an acceptance id verifies the documents citing it. A citation no test carries warns in ',
      { code: 'guren check --docs' },
      '.',
    ]))
  } else if (node.kind === 'entity' && governedBy.length === 0 && plans.length > 0) {
    root.append(noteWith(['A model the plans above change. No document names it yet; plan:close writes its entity document.']))
  } else if (node.kind === 'entity') {
    root.append(noteWith(['A model class linked by name from doc frontmatter (survives file moves). Explore it with ', { code: `guren context ${node.label}` }, '.']))
  } else if (feeds.length > 0 && governedBy.length === 0) {
    root.append(noteWith([
      'Source code a generated spec view derives from: change it and ',
      { code: 'guren check --spec' },
      ' flags the stale view until ',
      { code: 'guren spec:generate' },
      ' reruns.',
    ]))
  } else {
    root.append(noteWith(['A code path linked from doc frontmatter. Renaming it without updating the doc fails ', { code: 'guren check --docs' }, '.']))
  }
  return root
}

const mermaidReady = (): boolean => window.mermaid !== undefined && window.mermaid !== null

function isDarkTheme(): boolean {
  const override = document.documentElement.dataset.theme
  return override === 'dark' || (override !== 'light' && prefersDark.matches)
}

function initMermaid(): void {
  window.mermaid?.initialize({ startOnLoad: false, theme: isDarkTheme() ? 'dark' : 'neutral', securityLevel: 'strict' })
}

function runMermaid(): void {
  const pres = content.querySelectorAll<HTMLElement>('pre.mermaid:not([data-processed])')
  if (pres.length === 0) return
  if (mermaidReady()) {
    // Keep the source around so a theme change can re-render.
    pres.forEach((pre) => {
      if (!pre.dataset.source) pre.dataset.source = pre.textContent ?? ''
    })
    window.mermaid!.run({ nodes: pres }).catch(() => {})
    return
  }
  pres.forEach((pre) => {
    pre.setAttribute('data-processed', 'true')
    pre.after(el('p', 'mermaid-hint', 'diagram source shown: bun add -d mermaid to render it'))
  })
}

export function openPanel(id: string, options: { keepScroll?: boolean } = {}): void {
  const node = state.byId.get(id)
  if (!node) return
  state.selected = id
  content.textContent = ''
  const doc = state.docByPath.get(id)
  content.append(doc ? buildDocDetail(doc) : node.plan ? buildPlanDetail(node.plan) : buildSatelliteDetail(node))
  markSelected(id)
  panel.classList.add('open')
  panel.setAttribute('aria-hidden', 'false')
  document.body.classList.add('panel-open')
  if (!options.keepScroll) panel.scrollTop = 0
  requestAnimationFrame(runMermaid)
}

export function closePanel(): void {
  state.selected = null
  panel.classList.remove('open')
  panel.setAttribute('aria-hidden', 'true')
  document.body.classList.remove('panel-open')
  markSelected(null)
}

/** Reading mode: the panel takes the whole viewport, and stays so from doc to doc until toggled back. */
export function toggleExpanded(): void {
  expanded = !expanded
  panel.classList.toggle('expanded', expanded)
  expandButton.textContent = expanded ? '⤡ collapse' : '⤢ expand'
  expandButton.setAttribute('aria-pressed', String(expanded))
}

export function panelElement(): HTMLElement {
  return panel
}

export function mountPanel(): void {
  panel = byId('panel')
  content = byId('panel-content')
  expandButton = byId('expand')
  expandButton.addEventListener('click', toggleExpanded)
  byId('close').addEventListener('click', closePanel)
  initMermaid()
  // Re-render open diagrams when the color scheme flips: an already processed SVG keeps its old palette.
  prefersDark.addEventListener('change', () => {
    if (!mermaidReady()) return
    initMermaid()
    content.querySelectorAll<HTMLElement>('pre.mermaid[data-processed]').forEach((pre) => {
      if (!pre.dataset.source) return
      pre.textContent = pre.dataset.source
      pre.removeAttribute('data-processed')
    })
    runMermaid()
  })
}
