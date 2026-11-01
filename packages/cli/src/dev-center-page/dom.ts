import { el } from '../docs-viewer-page/dom'

/** Every Dev Center read: never cached, never redirected, and a non-2xx status is a failure. */
export async function readJson(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: 'no-store', redirect: 'error' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

export function card(title: string, ...body: Node[]): HTMLElement {
  const section = el('section', 'g-card')
  const head = el('div', 'g-card-head')
  head.append(el('h2', 'g-card-title', title))
  const inner = el('div', 'g-card-body')
  inner.append(...body)
  section.append(head, inner)
  return section
}
