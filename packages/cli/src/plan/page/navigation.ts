/** The tabs, the two filters, and the rule that an in-page link always lands on something visible. */

import { cards } from './card'
import { byId, el } from './dom'
import { ariaLabel, localise, t, tel, words } from './locale'
import type { PlanPagePayload } from './payload'
import { SECTIONS } from './sections'

interface TabEntry {
  key: string
  button: HTMLButtonElement
  panel: HTMLElement
}

const tabEntries: TabEntry[] = []

function selectTab(key: string): void {
  for (const entry of tabEntries) {
    const selected = entry.key === key
    entry.button.setAttribute('aria-selected', selected ? 'true' : 'false')
    entry.panel.hidden = !selected
  }
}

export function mountTabs(data: PlanPagePayload): void {
  const tabs = byId('tabs')
  ariaLabel(tabs, 'aria.tabs')
  const panels = byId('panels')

  SECTIONS.forEach((section, index) => {
    const items = data.plan[section.key]
    const button = tel('button', null, 'sections.tab', () => ({ label: t(section.label), count: items.length }))
    button.type = 'button'
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', index === 0 ? 'true' : 'false')
    button.setAttribute('aria-controls', 'panel-' + section.key)
    button.addEventListener('click', () => selectTab(section.key))
    tabs.appendChild(button)

    const panel = el('section')
    panel.id = 'panel-' + section.key
    panel.setAttribute('role', 'tabpanel')
    panel.hidden = index !== 0
    // The tab names the section on screen; on paper there are no tabs.
    // Named by its heading rather than by an `aria-label`: the heading carries the
    // language it is written in, and a label on the panel would borrow the plan's.
    const heading = tel('h2', 'section-title', section.label)
    heading.id = 'panel-title-' + section.key
    panel.setAttribute('aria-labelledby', heading.id)
    panel.appendChild(heading)
    section.render(panel, data)
    if (!items.length) {
      panel.className = 'empty'
      panel.appendChild(tel('p', 'note', 'sections.empty'))
    }
    panels.appendChild(panel)
    tabEntries.push({ key: section.key, button: button, panel: panel })
  })
}

export function mountFilters(entities: readonly string[]): void {
  const entityFilter = byId<HTMLSelectElement>('entity-filter')
  const changesOnly = byId<HTMLInputElement>('changes-only')
  const visibleCount = byId('visible-count')
  words(byId('entity-filter-label'), 'filter.entity')
  words(byId('changes-only-label'), 'filter.changesOnly')
  const allOption = tel('option', null, 'filter.all')
  allOption.value = ''
  entityFilter.appendChild(allOption)
  for (const entity of entities) {
    const option = el('option', null, entity)
    option.value = entity
    entityFilter.appendChild(option)
  }

  const applyFilters = (): void => {
    const entity = entityFilter.value
    const only = changesOnly.checked
    // Read rather than cached: the link target is whatever the hash says right now,
    // so nothing has to decide when to re-run this.
    const linked = window.location.hash.slice(1)
    for (const item of cards) {
      // A link to a filtered-out element would otherwise land on a hidden card:
      // the filter is a view, not a claim that the element is gone.
      item.keep = item.node.id === linked || !((entity && item.entity !== entity) || (only && item.existing))
    }
    // A matching card is unreachable while an ancestor is hidden, so every
    // ancestor of a match is kept too.
    for (const item of cards) {
      if (!item.keep) continue
      for (let ancestor = item.parent; ancestor && !ancestor.keep; ancestor = ancestor.parent) ancestor.keep = true
    }
    let shown = 0
    for (const item of cards) {
      item.node.hidden = !item.keep
      if (item.keep) shown += 1
    }
    visibleCount.textContent = t('filter.count', { shown: shown, total: cards.length })
  }

  // An in-page link may point into a hidden panel or at a card the filter hides;
  // show the panel that holds it, then re-filter so the card itself survives.
  const revealHash = (): void => {
    const node = document.getElementById(window.location.hash.slice(1))
    if (!node) return
    for (const entry of tabEntries) {
      if (entry.panel.contains(node)) selectTab(entry.key)
    }
    applyFilters()
    node.scrollIntoView()
  }

  window.addEventListener('hashchange', revealHash)
  entityFilter.addEventListener('change', applyFilters)
  changesOnly.addEventListener('change', applyFilters)
  // The count is a sentence in the current locale, and the filter is what knows it.
  localise(applyFilters)
  revealHash()
}
