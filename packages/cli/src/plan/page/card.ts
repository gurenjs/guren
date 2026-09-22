/** One plan element on the page: its heading, findings, body, back references and review. */

import type { PlanChangeKind } from '../diagram'
import type { PlanChange } from '../schema'
import type { PlanCheckResult } from '../validate'
import { anchorId, el, groupBy, idMap, isNode, link, list } from './dom'
import { impactNote, indexImpact } from './impact'
import { t, tel, words } from './locale'
import type { PlanBreakingChange, PlanLink, PlanPagePayload } from './payload'
import { reviewControls } from './review'

/** A flow the plan does not declare is badged from its layout, which keeps the kind alone. */
export type CardChange = PlanChange | { kind: PlanChangeKind }

export interface CardOptions {
  id: string
  title: string
  change?: CardChange
  body?: Node
  sub?: boolean
  parent?: HTMLElement
  extraBadges?: Node[]
  noReview?: boolean
  noFilter?: boolean
}

export interface CardEntry {
  node: HTMLElement
  parent: CardEntry | null
  entity: string | null
  existing: boolean
  keep?: boolean
}

export const cards: CardEntry[] = []
// A sub-card is nested inside its parent's element, so hiding the parent hides
// it whatever the filter decided about it. Keyed by node: an id may repeat.
const cardOf = new Map<HTMLElement, CardEntry>()

export const entityOf = idMap<string | null>()
let incoming = idMap<PlanLink[]>()
let dependsOn = idMap<string[]>()
let checksFor = idMap<PlanCheckResult[]>()
let breakingFor = idMap<PlanBreakingChange[]>()
// The marks each question put on the elements it affects: RFC 0030 §3 shows them
// "until the question is answered", so answering has to be able to take them off.
export const dependsMarks = idMap<HTMLElement[]>()

export function indexPlan(data: PlanPagePayload): void {
  for (const element of data.elements) entityOf[element.id] = element.entity

  incoming = groupBy(data.links, (edge) => edge.to)

  dependsOn = idMap()
  for (const question of data.plan.questions) {
    for (const elementId of question.affects) (dependsOn[elementId] ??= []).push(question.id)
  }

  checksFor = groupBy(data.checks, (result) => result.elementId)
  breakingFor = groupBy(data.breaking, (item) => item.elementId)
  indexImpact(data.impact)
}

/** An `h4` and the list under it. The emptiness rule is the caller's: three
 * sections show their heading with an empty list. */
export function group(host: Node, heading: string, items: ReadonlyArray<string | Node>): void
export function group<T>(host: Node, heading: string, items: readonly T[], mapper: (item: T) => string | Node): void
export function group<T>(host: Node, heading: string, items: readonly T[], mapper?: (item: T) => string | Node): void {
  host.appendChild(tel('h4', null, heading))
  host.appendChild(mapper ? list(items, mapper) : list(items as ReadonlyArray<string | Node>))
}

export function kv(pairs: ReadonlyArray<readonly [key: string, value: string | Node | null | undefined]>): HTMLDListElement {
  const dl = el('dl', 'kv')
  for (const [key, value] of pairs) {
    if (value === undefined || value === null || value === '') continue
    dl.appendChild(tel('dt', null, key))
    const dd = el('dd')
    if (isNode(value)) dd.appendChild(value)
    else dd.textContent = String(value)
    dl.appendChild(dd)
  }
  return dl
}

/** A label and the elements it names, each a link, in the order given. */
export function linkLine(labelKey: string, ids: readonly string[]): HTMLParagraphElement {
  const line = el('p', 'note referenced-by')
  line.appendChild(tel('span', 'label', labelKey))
  ids.forEach((id, index) => {
    if (index) line.appendChild(document.createTextNode(', '))
    line.appendChild(link(id))
  })
  return line
}

function changeBadge(change: CardChange | undefined): HTMLElement | null {
  if (!change) return null
  const badge = el('span', 'badge badge-' + change.kind, change.kind)
  if (change.kind === 'rename') words(badge, 'badge.renameFrom', { from: 'from' in change ? change.from : undefined })
  if (change.kind === 'drop' && 'reason' in change) badge.title = change.reason
  return badge
}

export function card(options: CardOptions): HTMLElement {
  const node = el('article', 'card' + (options.sub ? ' sub' : ''))
  const anchor = anchorId(options.id)
  if (anchor) node.id = anchor

  const head = el('div', 'card-head')
  head.appendChild(el('h3', null, options.title))
  const badge = changeBadge(options.change)
  if (badge) head.appendChild(badge)
  for (const extra of options.extraBadges ?? []) head.appendChild(extra)
  head.appendChild(el('code', 'card-id', options.id))
  for (const questionId of dependsOn[options.id] ?? []) {
    const mark = words(link(questionId, ''), 'card.dependsOn', { question: questionId })
    mark.className = 'depends'
    head.appendChild(mark)
    ;(dependsMarks[questionId] ??= []).push(mark)
  }
  node.appendChild(head)

  for (const item of breakingFor[options.id] ?? []) {
    node.appendChild(tel('p', 'note', 'card.breaking', () => ({ reason: t(item.reasonKey, item.reasonValues) })))
  }
  const impact = impactNote(options.id)
  if (impact) node.appendChild(impact)
  for (const result of checksFor[options.id] ?? []) {
    const line = el('p', 'note')
    line.appendChild(el('span', 'badge badge-' + result.status, result.status))
    line.appendChild(document.createTextNode(' ' + result.title + ': ' + result.message))
    node.appendChild(line)
  }

  if (options.body) node.appendChild(options.body)

  // Only the reverse direction: what an element references is already written
  // where it belongs (a validator under Body, a policy under Policy, a target
  // in its relationship line), and repeating it as chips said it twice.
  const referrers = [...new Set((incoming[options.id] ?? []).map((edge) => edge.from))]
  if (referrers.length) node.appendChild(linkLine('card.referencedBy', referrers))

  if (!options.noReview) {
    const controls = reviewControls(options.id)
    head.appendChild(controls.mark)
    node.appendChild(controls.panel)
  }

  // A question is not filtered: it sits above the tabs and asks about every
  // entity it affects, so an entity filter would hide the thing being asked.
  if (!options.noFilter) {
    const entry: CardEntry = {
      node: node,
      parent: options.parent ? (cardOf.get(options.parent) ?? null) : null,
      entity: entityOf[options.id] || null,
      existing: options.change ? options.change.kind === 'existing' : false,
    }
    cards.push(entry)
    cardOf.set(node, entry)
  }
  return node
}
