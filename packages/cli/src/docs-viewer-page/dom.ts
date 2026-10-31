/** The page's ways to make a node. Payload text reaches the document as `textContent`, never as markup. */

const SVG_NS = 'http://www.w3.org/2000/svg'

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag)
}

/** An element the template declares; one it lacks is a template defect, not a state to handle. */
export function byId<T extends Element = HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`The docs viewer template has no #${id}.`)
  return found as unknown as T
}

/** A command to copy, never run; the Dev Center's plan page shares it. Where the clipboard is refused, it selects the text. */
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
