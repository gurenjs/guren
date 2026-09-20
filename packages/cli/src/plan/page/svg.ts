const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export type Point = [x: number, y: number]

/** Sets whatever keys it is handed, so every caller spells them as an object literal. */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NAMESPACE, tag)
  for (const key of Object.keys(attributes)) {
    node.setAttribute(key, String(attributes[key]))
  }
  return node
}

export function svgText(x: number, y: number, text: string, className?: string): SVGTextElement {
  const node = svgEl('text', { x: x, y: y })
  if (className) node.setAttribute('class', className)
  node.textContent = text
  return node
}

/** A `<title>`: what a pointer shows on hover and a screen reader reads for the group. */
export function svgTip(text: string): SVGTitleElement {
  const node = svgEl('title')
  node.textContent = text
  return node
}

/** Where the segment between two boxes leaves the first, so a label lands in the gap. */
export function borderPoint(box: Box, towards: Box): Point {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const dx = towards.x + towards.w / 2 - cx
  const dy = towards.y + towards.h / 2 - cy
  if (dx === 0 && dy === 0) return [cx, cy]
  const scale = Math.min(dx === 0 ? Infinity : box.w / 2 / Math.abs(dx), dy === 0 ? Infinity : box.h / 2 / Math.abs(dy))
  return [cx + dx * scale, cy + dy * scale]
}
