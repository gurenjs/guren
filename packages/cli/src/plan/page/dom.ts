/**
 * The page's only ways to make a node. A plan string reaches the document as
 * `textContent` or as a text node, and a link target only through `anchorId()`.
 */

// The schema's own id pattern. Anchors are built from ids that match it and from
// nothing else, so no plan string ever reaches an href.
const ID_RE = /^[A-Za-z][A-Za-z0-9_.:-]*$/

export type IdMap<T> = Record<string, T | undefined>

/**
 * Every map keyed by a plan id is built here and nowhere else. `constructor`,
 * `toString` and `valueOf` all match the schema's id pattern, and on a plain
 * object each reads back as the inherited function rather than as absent. The
 * source test asserts this factory holds the page's only null-prototype
 * construction, so a map added later is covered without anyone listing it.
 */
export function idMap<T>(): IdMap<T> {
  return Object.create(null) as IdMap<T>
}

/** An id-keyed multimap: the one place the `(m[k] = m[k] || []).push(v)` idiom lives. */
export function groupBy<T>(items: readonly T[], keyOf: (item: T) => string | null | undefined): IdMap<T[]> {
  const map = idMap<T[]>()
  for (const item of items) {
    const key = keyOf(item)
    if (key === undefined || key === null) continue
    ;(map[key] ??= []).push(item)
  }
  return map
}

export function own(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

export function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && Boolean((value as Partial<Node>).nodeType)
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  text?: string | number | null,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

export function anchorId(id: string): string | null {
  return ID_RE.test(id) ? 'el-' + id : null
}

export function link(id: string, text?: string): HTMLElement {
  const anchor = anchorId(id)
  if (!anchor) return el('code', 'mono', id)
  const node = el('a', 'mono', text === undefined ? id : text)
  node.setAttribute('href', '#' + anchor)
  return node
}

/** A span of strings and nodes in order. A string is always text, never markup. */
export function span(parts: ReadonlyArray<string | Node | null | undefined>): HTMLSpanElement {
  const node = el('span')
  for (const part of parts) {
    if (part === null || part === undefined) continue
    node.appendChild(isNode(part) ? part : document.createTextNode(String(part)))
  }
  return node
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function list(items: ReadonlyArray<string | Node>): HTMLUListElement
export function list<T>(items: readonly T[], mapper: (item: T) => string | Node): HTMLUListElement
export function list<T>(items: readonly T[], mapper?: (item: T) => string | Node): HTMLUListElement {
  const ul = el('ul')
  for (const item of items) {
    const li = el('li')
    const content = mapper ? mapper(item) : isNode(item) ? item : el('span', null, item as string)
    if (typeof content === 'string') li.textContent = content
    else li.appendChild(content)
    ul.appendChild(li)
  }
  return ul
}
