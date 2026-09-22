/** The Impact note on a card (RFC 0030 §2): what the scanners found, always labelled a lower bound. */

import type { PlanImpactConsumer, PlanImpactConsumerKind, PlanImpactEntry } from '../impact'
import { el, idMap } from './dom'
import { tel } from './locale'

const KIND_KEYS: Record<PlanImpactConsumerKind, string> = {
  route: 'impact.kind.route',
  apiRoute: 'impact.kind.apiRoute',
  agentTool: 'impact.kind.agentTool',
  action: 'impact.kind.action',
  model: 'impact.kind.model',
  resource: 'impact.kind.resource',
  policy: 'impact.kind.policy',
  page: 'impact.kind.page',
  test: 'impact.kind.test',
  testRequest: 'impact.kind.testRequest',
  read: 'impact.kind.read',
  write: 'impact.kind.write',
  opaqueRead: 'impact.kind.opaqueRead',
  opaqueWrite: 'impact.kind.opaqueWrite',
}

let impactFor = idMap<PlanImpactEntry>()

/** `null` is a page rendered with no application to read: no card then claims Impact found nothing. */
export function indexImpact(impact: readonly PlanImpactEntry[] | null): void {
  impactFor = idMap()
  for (const entry of impact ?? []) impactFor[entry.elementId] = entry
}

function consumerLine(consumer: PlanImpactConsumer): HTMLElement {
  const key = consumer.kind === 'read' && consumer.via !== undefined ? 'impact.kind.readVia' : KIND_KEYS[consumer.kind]
  const line = tel('span', null, key, { name: el('code', 'mono', consumer.name), via: consumer.via ?? null })
  if (consumer.file !== undefined && consumer.file !== consumer.name && consumer.kind !== 'testRequest') {
    line.appendChild(el('span', 'mono impact-at', ' (' + consumer.file + (consumer.line ? ':' + consumer.line : '') + ')'))
  }
  return line
}

export function impactNote(elementId: string): HTMLElement | null {
  const entry = impactFor[elementId]
  if (!entry) return null
  const block = el('div', 'note impact')
  block.appendChild(tel('p', 'label', 'impact.heading'))
  if (!entry.consumers.length) block.appendChild(tel('p', null, 'impact.none'))
  else {
    const items = el('ul')
    for (const consumer of entry.consumers) items.appendChild(el('li')).appendChild(consumerLine(consumer))
    block.appendChild(items)
  }
  for (const note of entry.notes) block.appendChild(tel('p', null, note.key, note.values))
  return block
}
