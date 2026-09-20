/** What stands above the tabs: the plan's own prose, its scope, and the findings that block it. */

import { byId, el, link, list } from './dom'
import { ariaLabel, tel } from './locale'
import type { PlanPagePayload } from './payload'

function scopeBlock(title: string, items: readonly string[]): HTMLDivElement {
  const block = el('div')
  block.appendChild(tel('h4', null, title))
  if (items.length) block.appendChild(list(items))
  else block.appendChild(tel('p', 'note', 'scope.none'))
  return block
}

export function renderHeader({ plan, planHash }: PlanPagePayload): void {
  // The prose is most of the page, so the document's language is the plan's: it governs
  // line breaking and the font the system picks. The page's own words carry their own.
  if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(plan.locale)) {
    document.documentElement.setAttribute('lang', plan.locale)
  }

  byId('plan-title').textContent = plan.title
  document.title = plan.title
  byId('plan-summary').textContent = plan.summary

  const meta = byId('plan-meta')
  if (planHash) {
    meta.appendChild(el('span', 'mono', 'plan ' + planHash.slice(0, 12)))
    if ('baseline' in plan && plan.baseline) meta.appendChild(el('span', 'mono', 'baseline ' + plan.baseline.rev))
  } else {
    meta.appendChild(tel('span', null, 'header.draft'))
  }

  const scope = byId('plan-scope')
  scope.appendChild(scopeBlock('scope.goals', plan.scope.goals))
  scope.appendChild(scopeBlock('scope.nonGoals', plan.scope.nonGoals))
  scope.appendChild(scopeBlock('scope.assumptions', plan.assumptions))
  if (plan.hints.length) scope.appendChild(scopeBlock('scope.hints', plan.hints))
}

export function renderPinned({ checks, breaking }: PlanPagePayload): void {
  const pinned = byId('pinned')
  ariaLabel(pinned, 'aria.pinned')
  const blocking = checks.filter((result) => result.status !== 'pass')
  if (!blocking.length && !breaking.length) return

  pinned.hidden = false
  pinned.appendChild(tel('h2', null, 'pinned.heading'))
  for (const result of blocking) {
    const item = el('div', 'pinned-item')
    item.appendChild(
      tel('span', null, result.elementId ? 'pinned.checkOn' : 'pinned.check', {
        status: el('span', 'badge badge-' + result.status, result.status),
        title: result.title,
        element: result.elementId ? link(result.elementId) : null,
      }),
    )
    item.appendChild(el('p', 'note', result.message))
    if (result.suggestion) item.appendChild(el('p', 'note', result.suggestion))
    pinned.appendChild(item)
  }
  for (const item of breaking) {
    const node = el('div', 'pinned-item')
    node.appendChild(
      tel('span', null, 'pinned.breaking', {
        badge: tel('span', 'badge badge-drop', 'badge.breaking'),
        title: item.title,
        element: link(item.elementId),
      }),
    )
    node.appendChild(tel('p', 'note', item.reasonKey, item.reasonValues))
    pinned.appendChild(node)
  }
}
