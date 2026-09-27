/**
 * Plans in the viewer (RFC 0030 §7): the open-plan list, a plan's progress panel, and the link
 * to a rendered plan page. Commands are copied, never run: approving, verifying and closing
 * stay CLI acts.
 */
import type { DocsViewerPlanPage } from '../docs-viewer'
import type { DocsViewerOpenPlan, DocsViewerStepState } from '../docs-viewer-plans'
import { byId, el } from './dom'
import { planNodeId } from './model'
import { actorLine, metaRow, openPanel, relationItem, relationSection } from './panel'
import { BASE_URL, state } from './state'

const STEP_GLYPH: Record<DocsViewerStepState, string> = {
  verified: '●',
  drifted: '▲',
  incomplete: '▲',
  'waiver-withdrawn': '▲',
  blocked: '■',
  failed: '✕',
  outdated: '○',
  'not-run': '○',
}

const verifiedCount = (plan: DocsViewerOpenPlan): number => plan.steps.filter((step) => step.state === 'verified').length

export function renderPlanList(): void {
  const host = byId('plan-list')
  host.textContent = ''
  for (const plan of state.data.plans) {
    const button = el('button')
    button.append(el('span', '', plan.title), el('span', 'progress', `${plan.standing} · ${verifiedCount(plan)}/${plan.steps.length}`))
    button.title = plan.file
    button.addEventListener('click', () => openPanel(planNodeId(plan)))
    host.append(button)
  }
}

export function commandRow(text: string): HTMLElement {
  const row = el('div', 'command')
  const code = el('code', '', text)
  const button = el('button', '', 'copy')
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = 'copied'
    } catch {
      getSelection()?.selectAllChildren(code)
      button.textContent = 'selected'
    }
    setTimeout(() => {
      button.textContent = 'copy'
    }, 1600)
  })
  row.append(code, button)
  return row
}

/** The page link, and where the page is older than its plan, the command that renders it again. */
export function appendPageLink(head: HTMLElement, page: DocsViewerPlanPage): void {
  head.append(Object.assign(el('a', 'page-link', 'open plan page ↗'), {
    href: `${BASE_URL}/plans/${encodeURIComponent(page.slug)}`,
    target: '_blank',
    rel: 'noopener',
    title: page.page,
  }))
  if (page.stale && page.render) {
    head.append(el('p', 'plan-reason', 'The page was rendered from an earlier version of the plan.'), commandRow(page.render))
  }
}

export function buildPlanDetail(plan: DocsViewerOpenPlan): HTMLElement {
  const root = el('article', 'doc-detail')
  const head = el('div', 'doc-head')
  head.append(el('p', 'path', plan.file), el('h1', '', plan.title))
  const chips = el('div', 'chips')
  chips.append(el('span', `chip chip-standing-${plan.standing}`, plan.standing))
  chips.append(el('span', 'chip', `${verifiedCount(plan)}/${plan.steps.length} steps verified`))
  const page = state.data.planPages.find((entry) => entry.plan === plan.file)
  if (page?.stale) chips.append(el('span', 'chip chip-stale', 'page is stale'))
  head.append(chips)
  if (page) appendPageLink(head, page)
  root.append(head)

  const front = el('div', 'frontmatter')
  if (plan.next.length > 0) {
    front.append(el('p', 'panel-label', 'Next'))
    for (const command of plan.next) front.append(commandRow(command))
  }
  if (plan.reason) front.append(el('p', 'plan-reason', plan.reason))
  for (const reason of plan.unreadable ?? []) front.append(el('p', 'plan-reason', reason))
  const grid = el('div', 'meta-grid')
  metaRow(grid, 'approved', plan.approval ? actorLine(plan.approval) : '—')
  front.append(el('p', 'panel-label panel-label-spaced', 'Plan'), grid)
  if (plan.entities.length > 0) {
    const edges = plan.entities.map((name) => ({ from: planNodeId(plan), to: `entity:${name}`, relation: 'plans' as const, verdict: 'pass' as const }))
    relationSection(front, 'Entities', true, edges, 'to')
  }
  if (plan.waivers.length > 0) {
    front.append(el('p', 'panel-label panel-label-spaced', 'Waivers'))
    const list = el('ul', 'relations')
    for (const waiver of plan.waivers) {
      const li = relationItem(waiver.elementId, 'warn', null)
      li.classList.add('rel-member')
      li.append(el('span', 'rel-files', `${waiver.reason} (${actorLine(waiver)})`))
      list.append(li)
    }
    front.append(list)
  }
  front.append(el('p', 'panel-label panel-label-spaced', 'Element states and freshness'), commandRow(plan.status))
  root.append(front)

  const progress = el('div', 'prose plan-progress')
  let task: string | null = null
  let list: HTMLUListElement | null = null
  for (const step of plan.steps) {
    if (step.task !== task || list === null) {
      task = step.task
      list = el('ul', 'steps')
      progress.append(el('h3', '', task), list)
    }
    const li = el('li', step.active ? 'active' : '')
    li.append(el('span', `state-${step.state}`, STEP_GLYPH[step.state]), el('span', 'step-id', step.id))
    if (step.active) li.append(el('span', 'badge', 'current'))
    li.append(el('span', `step-state state-${step.state}`, step.state + (step.ranAt ? ` · ${step.ranAt}` : '')))
    if (step.changed) li.append(el('span', 'step-note', `changed since: ${step.changed.join(', ')}`))
    if (step.stall) li.append(el('span', 'step-note', `stalled ${step.stall.at}: ${step.stall.reason}`))
    list.append(li)
  }
  if (plan.steps.length === 0) progress.append(el('p', '', 'No steps derived.'))
  root.append(progress)

  root.append(el('p', 'rel-note', "Step records come from .guren/plans/, which git ignores: this is this checkout's progress, not the team's."))
  return root
}
