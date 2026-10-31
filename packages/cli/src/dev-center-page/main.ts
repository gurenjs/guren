import type { GraphNode, GurenApplicationGraph, GraphResult } from '../application-graph'
import { planPagePath, planReviewPath, planSlugFromPath, savedReviewPrompt } from '../dev-center-links'
import type { PlanOverview } from '../docs-viewer-plans'
import { commandRow } from '../docs-viewer-page/dom'
import type { RuntimeErrorResult } from '../runtime-errors'
import { planAttention, sortPlans, STEP_TONE, stepsByTask, verifiedCount, type DevCenterPlan, type PlanAttention } from './plans'

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
const COVERAGE_KEY = { complete: 'ok', partial: 'rule', unavailable: 'note' } as const
let graph: GurenApplicationGraph | undefined
let selected: string | undefined
const nodes = element('nodes')
const detail = element('detail')
const search = element<HTMLInputElement>('search')
const kind = element<HTMLSelectElement>('kind')
const refresh = element<HTMLButtonElement>('refresh')
const errorsButton = element<HTMLButtonElement>('refresh-errors')

function empty(title: string, body: string): HTMLElement {
  const node = text('div', '', 'g-empty')
  node.append(text('h3', title), text('p', body))
  return node
}
function stat(id: string, value: number | undefined): void {
  element(id).textContent = value === undefined ? '–' : String(value)
}
function showNode(node: GraphNode): void {
  selected = node.id
  detail.replaceChildren(text('span', node.kind, 'kind'), text('h2', node.label, 'g-card-title'), text('p', `Module: ${node.module ?? 'app'}`, 'meta'))
  if (node.file) detail.append(text('pre', node.file, 'g-code'))
  if (node.route) detail.append(text('pre', JSON.stringify(node.route, null, 2), 'g-code'))
  detail.append(text('h3', 'Evidence'), text('pre', JSON.stringify(node.evidence, null, 2), 'g-code'), text('h3', 'Relationships'))
  const edges = graph!.edges.filter((edge) => edge.from === node.id || edge.to === node.id)
  if (!edges.length) detail.append(text('p', 'No resolved relationships in this snapshot.', 'meta'))
  for (const edge of edges) {
    const outgoing = edge.from === node.id
    const target = graph!.nodes.find((candidate) => candidate.id === (outgoing ? edge.to : edge.from))
    if (!target) continue
    const button = text('button', `${outgoing ? '→' : '←'} ${edge.relation} · ${target.label}`, 'node rel') as HTMLButtonElement
    button.type = 'button'
    button.onclick = () => { showNode(target); renderNodes() }
    const evidence = text('details', '')
    evidence.append(text('summary', 'Relationship evidence'), text('pre', JSON.stringify(edge.evidence, null, 2), 'g-code'))
    detail.append(button, evidence)
  }
}
function renderNodes(): void {
  nodes.replaceChildren()
  if (!graph) return
  const query = search.value.toLowerCase()
  const matching = graph.nodes.filter((node) => (!kind.value || node.kind === kind.value)
    && [node.label, node.file, node.module].some((value) => value?.toLowerCase().includes(query)))
  if (!matching.length) nodes.append(empty('No matching symbols', 'Nothing in this snapshot matches the filter.'))
  for (const node of matching) {
    const button = text('button', '', 'node') as HTMLButtonElement
    button.type = 'button'
    button.setAttribute('aria-pressed', String(node.id === selected))
    button.append(text('span', node.kind, 'kind'), document.createTextNode(node.label), text('div', `${node.module ?? 'app'}${node.file ? ` · ${node.file}` : ''}`, 'meta mono'))
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
    stat('stat-symbols', graph.nodes.length)
    stat('stat-edges', graph.edges.length)
    stat('stat-unresolved', graph.unresolved.length)
    element('snapshot').textContent = `Captured ${graph.snapshot.capturedAt} · Snapshot ${graph.snapshot.id}`
    const coverage = element('coverage')
    coverage.replaceChildren()
    for (const [name, section] of Object.entries(graph.coverage)) {
      const key = COVERAGE_KEY[section.status]
      const body = text('div', '', 'b')
      body.append(text('code', name), document.createTextNode(` ${section.status}`))
      for (const reason of section.reasons) body.append(text('span', `${reason.code}: ${reason.message}${reason.file ? ` (${reason.file})` : ''}`, 'meta'))
      const row = text('div', '', `g-callout ${key}`)
      row.append(text('span', key, 'k'), body)
      coverage.append(row)
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
    for (const id of ['stat-symbols', 'stat-edges', 'stat-unresolved']) stat(id, undefined)
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
  stat('stat-errors', undefined)
  try {
    // Read the complete retained window (at most 100), replacing the UI on every refresh.
    const result = await readJson('/_guren/runtime/errors?limit=100') as RuntimeErrorResult
    if (result?.schemaVersion !== 1 || (result.status === 'available' && !Array.isArray(result.events))) throw new Error('Unsupported runtime payload')
    if (result.status === 'unavailable') { status.textContent = `Unavailable: ${result.reason}`; return }
    stat('stat-errors', result.events.length)
    status.textContent = `${result.events.length} retained errors · ${result.dropped} dropped · Session ${result.sessionId} · Collection started ${result.startedAt}${result.cursorExpired ? ' · Earlier events are no longer retained' : ''}`
    if (!result.events.length) list.append(empty('No retained server exceptions', 'Nothing has failed in this collection window.'))
    for (const event of [...result.events].reverse()) {
      const row = text('article', '', 'event')
      const head = text('div', '', 'event-head')
      head.append(text('span', String(event.status), 'g-badge g-badge-danger'), text('strong', `${event.method} ${event.route?.pattern ?? '(route unavailable)'}`, 'mono'))
      row.append(head, text('div', `${event.occurredAt} · #${event.sequence} · Runtime correlation: ${event.correlation}`, 'meta mono'))
      if (event.route?.name) row.append(text('div', event.route.name, 'meta mono'))
      row.append(text('pre', event.frames.map((frame) => `${frame.file}:${frame.line ?? '?'}:${frame.column ?? '?'}`).join('\n') || 'No project-local stack locations.', 'g-code'))
      list.append(row)
    }
  } catch (error) { status.textContent = `Runtime unavailable: ${error instanceof Error ? error.message : 'Read failed'}. Refresh to retry.` }
  finally { errorsButton.disabled = false }
}
async function readPlans(): Promise<PlanOverview> {
  const result = await readJson('/_guren/plans.json') as PlanOverview
  if (result.schemaVersion !== 1 || !Array.isArray(result.plans)) throw new Error('Unsupported plans payload')
  return result
}
function attentionBox(attention: PlanAttention): HTMLElement {
  const box = text('div', '', `attention ${attention.who}`)
  box.append(text('span', attention.who === 'person' ? 'Waiting on a person' : 'Agent can continue', 'label'), text('strong', attention.title), text('span', attention.detail, 'meta'))
  return box
}
function progress(plan: DevCenterPlan): HTMLElement[] {
  const done = verifiedCount(plan)
  const bar = text('div', '', 'progress')
  const fill = document.createElement('span')
  fill.style.width = plan.steps.length ? `${(done / plan.steps.length) * 100}%` : '0'
  bar.append(fill)
  return [text('div', `${done} of ${plan.steps.length} steps verified`, 'meta'), bar]
}
async function loadPlans(): Promise<void> {
  const button = element<HTMLButtonElement>('refresh-plans')
  const status = element('plans-status')
  const list = element('plans')
  button.disabled = true
  status.textContent = 'Reading plans…'
  list.replaceChildren()
  element('plans-unreadable').replaceChildren()
  try {
    const result = await readPlans()
    const plans = sortPlans(result.plans)
    const waiting = plans.filter(({ attention }) => attention.who === 'person').length
    status.textContent = `${plans.length} open ${plans.length === 1 ? 'plan' : 'plans'} · ${waiting} waiting on a person`
    status.className = waiting ? 'warning' : ''
    if (!plans.length) list.append(empty('No open plans', 'Plans appear here once an agent writes one with the plan-write skill.'))
    for (const { plan, attention } of plans) {
      const card = text('a', '', 'g-card plan-card') as HTMLAnchorElement
      card.href = planPagePath(plan.slug)
      card.append(text('span', plan.standing, 'kind'), text('h3', plan.title, 'g-card-title'), text('div', plan.file, 'meta mono'), ...progress(plan), attentionBox(attention))
      list.append(card)
    }
    element('plans-unreadable').replaceChildren(...result.unreadable.map((dir) => text('li', `${dir.dir} would not list, so its plans are missing: ${dir.reason}`)))
  } catch (error) {
    status.textContent = `Plans unavailable: ${error instanceof Error ? error.message : 'Read failed'}. Refresh to retry.`
    status.className = 'error'
  } finally { button.disabled = false }
}
function card(title: string, ...body: Node[]): HTMLElement {
  const section = text('section', '', 'g-card')
  const head = text('div', '', 'g-card-head')
  head.append(text('h2', title, 'g-card-title'))
  const inner = text('div', '', 'g-card-body')
  inner.append(...body)
  section.append(head, inner)
  return section
}
function stepRow(step: DevCenterPlan['steps'][number]): HTMLElement {
  const row = text('div', '', 'step')
  const badge = text('div', '')
  badge.append(text('span', step.state, `g-badge g-badge-${STEP_TONE[step.state]}`))
  const body = text('div', '')
  body.append(text('div', step.id, 'id mono'))
  if (step.active) body.append(text('div', 'Marked by plan:next: the Stop hook verifies this step on every stop.', 'meta marked'))
  if (step.ranAt) body.append(text('div', `Last plan:verify run ${step.ranAt}`, 'meta mono'))
  if (step.stall) body.append(text('div', `Stalled ${step.stall.at}: ${step.stall.reason}`, 'meta error'))
  if (step.changed?.length) body.append(text('div', `Changed since verified: ${step.changed.join(', ')}`, 'meta mono'))
  row.append(badge, body)
  return row
}
function reviewCard(plan: DevCenterPlan): HTMLElement {
  const link = text('a', 'Review this plan', 'g-btn g-btn-secondary') as HTMLAnchorElement
  link.href = planReviewPath(plan.slug)
  const parts: Node[] = [text('p', 'Mark each element and answer the open questions on the page plan:render wrote. Every change is saved for plan:revise to read.', 'meta'), link]
  const saved = plan.feedback
  if (saved) {
    parts.push(text('p', `Saved ${saved.savedAt}: ${saved.approved} approved, ${saved.changes} changes requested, ${saved.comments} commented, ${saved.answers} answered.`, 'meta mono'))
    if (saved.current) parts.push(text('p', 'Send the agent:', 'meta'), commandRow(savedReviewPrompt(plan.file, plan.slug)))
    // Approving stamps a baseline, which moves the digest, so an approved plan's earlier review is no prompt to review again.
    else if (plan.standing !== 'approved') parts.push(text('p', 'Saved on an earlier version of the plan, so plan:revise will not apply it. Review the plan again.', 'meta warning'))
  }
  return card('Review', ...parts)
}
function byline(at: string, by: string | undefined): string {
  return by ? `${at} by ${by}` : at
}
async function loadPlan(slug: string): Promise<void> {
  const button = element<HTMLButtonElement>('refresh-plan')
  const status = element('plan-status')
  const body = element('plan-body')
  button.disabled = true
  status.textContent = 'Reading plan…'
  body.replaceChildren()
  try {
    const matching = (await readPlans()).plans.filter((plan) => plan.slug === slug)
    if (!matching.length) {
      element('plan-title').textContent = slug
      status.textContent = 'No open plan has this name: it may be closed, renamed or unreadable.'
      status.className = 'warning'
      return
    }
    // Two plans may share a slug; `guren check --plan` warns about it, and both are shown.
    status.textContent = matching.length > 1 ? `${matching.length} open plans share this name` : ''
    status.className = matching.length > 1 ? 'warning' : ''
    const { title } = matching[0]!
    element('plan-title').textContent = title
    document.title = `${title} · Guren Dev Center`
    for (const plan of matching) {
      const standing = plan.approval ? `approved ${byline(plan.approval.at, plan.approval.by)}` : plan.standing
      const meta = [plan.file, standing, plan.entities.join(', ')].filter(Boolean).join(' · ')
      body.append(text('p', meta, 'lede mono'), attentionBox(planAttention(plan)))
      // Shown apart from the attention box, which a draft's or an edited plan's approval outranks.
      if (plan.unreadable?.length) body.append(card('Records', ...plan.unreadable.map((reason) => text('p', reason, 'warning'))))
      body.append(reviewCard(plan))
      const steps = stepsByTask(plan).flatMap((group) => [text('h3', group.task), ...group.steps.map(stepRow)])
      body.append(card('Steps', ...progress(plan), ...(steps.length ? steps : [empty('No steps', 'The plan derives no steps.')])))
      if (plan.waivers.length) {
        body.append(card('Waivers', ...plan.waivers.map((waiver) => text('p', `${waiver.elementId}: ${waiver.reason} (${byline(waiver.at, waiver.by)})`, 'meta'))))
      }
      body.append(card('Commands', text('p', 'What the records say comes next, then the full status:', 'meta'), ...[...plan.next, plan.status].map(commandRow)))
    }
  } catch (error) {
    status.textContent = `Plan unavailable: ${error instanceof Error ? error.message : 'Read failed'}. Refresh to retry.`
    status.className = 'error'
  } finally { button.disabled = false }
}
search.oninput = renderNodes
kind.onchange = renderNodes
refresh.onclick = () => { void loadGraph() }
errorsButton.onclick = () => { void loadErrors() }
const planPage = planSlugFromPath(location.pathname)
if (planPage === undefined) {
  element<HTMLButtonElement>('refresh-plans').onclick = () => { void loadPlans() }
  void loadPlans()
  void loadGraph()
  void loadErrors()
} else {
  element('home').hidden = true
  element('plan-view').hidden = false
  element<HTMLButtonElement>('refresh-plan').onclick = () => { void loadPlan(planPage) }
  void loadPlan(planPage)
}
