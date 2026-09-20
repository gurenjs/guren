/** The ER diagram, drawn from the `{ tables, edges }` the renderer derived. */

import type { PlanDiagram, PlanDiagramColumn, PlanDiagramTable } from '../diagram'
import { clear, idMap } from './dom'
import { localise, spoken, t } from './locale'
import { borderPoint, svgEl, svgText, type Box } from './svg'

const BOX_WIDTH = 230
const GAP_X = 76
const GAP_Y = 36
const ROW_HEIGHT = 22
const HEADER_HEIGHT = 44

interface PlacedTable extends Box {
  open: boolean
}

const expanded = idMap<boolean>()
let drawnColumns: number | null = null

/** The facts about a column that are true, in the order the page always writes them. */
export function columnFlags(column: { primaryKey?: boolean; nullable: boolean; unique: boolean; index: boolean }): string[] {
  const flags: string[] = []
  if (column.primaryKey) flags.push('pk')
  if (column.nullable) flags.push('null')
  if (column.unique) flags.push('uniq')
  if (column.index) flags.push('idx')
  return flags
}

function columnLine(column: PlanDiagramColumn): string {
  return [column.name, column.type, ...columnFlags(column)].join(' ')
}

/**
 * `.wrap` rather than the diagram's own host: the host's panel is hidden on every
 * tab but the first, and a hidden element measures 0, which would lay the diagram
 * out for a width no one is looking at.
 */
function diagramColumns(tableCount: number): number {
  const width = (document.querySelector('.wrap') as Element).clientWidth - 32
  return Math.max(1, Math.min(3, Math.floor((width + GAP_X) / (BOX_WIDTH + GAP_X)), tableCount || 1))
}

function drawDiagram(host: HTMLElement, diagram: PlanDiagram): void {
  clear(host)
  const tables = diagram.tables
  if (!tables.length) {
    host.appendChild(spoken('p', 'note', 'diagram.empty'))
    return
  }

  const columns = diagramColumns(tables.length)
  drawnColumns = columns

  const placed = idMap<PlacedTable>()
  let top = 0
  for (let index = 0; index < tables.length; index += columns) {
    let tallest = 0
    tables.slice(index, index + columns).forEach((table, offset) => {
      const open = Boolean(expanded[table.id])
      const height = HEADER_HEIGHT + (open ? table.columns.length * ROW_HEIGHT + 8 : 0)
      placed[table.id] = { x: offset * (BOX_WIDTH + GAP_X), y: top, w: BOX_WIDTH, h: height, open: open }
      if (height > tallest) tallest = height
    })
    top += tallest + GAP_Y
  }

  const totalWidth = columns * BOX_WIDTH + (columns - 1) * GAP_X
  const totalHeight = Math.max(top - GAP_Y, HEADER_HEIGHT)
  const svg = svgEl('svg', {
    class: 'er',
    width: totalWidth,
    height: totalHeight,
    viewBox: '0 0 ' + totalWidth + ' ' + totalHeight,
    role: 'img',
    'aria-label': t('diagram.label'),
  })

  const edgeLabels: SVGTextElement[] = []
  for (const edge of diagram.edges) {
    const from = placed[edge.from]
    const to = placed[edge.to]
    if (!from || !to) continue
    const [x1, y1] = borderPoint(from, to)
    const [x2, y2] = borderPoint(to, from)
    const line = svgEl('line', { x1: x1, y1: y1, x2: x2, y2: y2 })
    if (edge.kind === 'relationship') line.setAttribute('class', 'relationship')
    svg.appendChild(line)
    const label = svgText((x1 + x2) / 2, (y1 + y2) / 2 - 4, edge.label, 'edge-label')
    label.setAttribute('text-anchor', 'middle')
    // Appended after the boxes: an opaque box drawn later would paint over it.
    edgeLabels.push(label)
  }

  for (const table of tables) svg.appendChild(tableGroup(table, placed[table.id] as PlacedTable, () => drawDiagram(host, diagram)))
  for (const label of edgeLabels) svg.appendChild(label)

  host.appendChild(svg)
  host.appendChild(spoken('p', 'note', 'diagram.hint'))
}

function tableGroup(table: PlanDiagramTable, box: PlacedTable, redraw: () => void): SVGGElement {
  const group = svgEl('g', { class: 'table', tabindex: '0', role: 'button' })
  group.setAttribute('aria-expanded', box.open ? 'true' : 'false')
  const rect = svgEl('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: 8 })
  rect.setAttribute('class', 'box ' + table.change)
  group.appendChild(rect)
  group.appendChild(svgText(box.x + 12, box.y + 20, table.table, 'title'))
  group.appendChild(svgText(box.x + 12, box.y + 36, table.model + ' - ' + table.change, 'muted'))
  if (box.open) {
    table.columns.forEach((column, index) => {
      group.appendChild(svgText(box.x + 12, box.y + HEADER_HEIGHT + 14 + index * ROW_HEIGHT, columnLine(column)))
    })
  }
  const toggle = (): void => {
    expanded[table.id] = !expanded[table.id]
    redraw()
  }
  group.addEventListener('click', toggle)
  group.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle()
    }
  })
  return group
}

/**
 * Drawn once the panels are in the document: the layout is measured, and the page
 * measures no element it has not yet appended. Bound like any worded node, since the
 * drawing says three things in the page's language.
 */
export function mountDiagram(host: HTMLElement, diagram: PlanDiagram): void {
  localise(() => drawDiagram(host, diagram))

  // Coalesced into one frame, and skipped when the column count has not moved: the
  // width read is a synchronous layout of the whole document, and the column count
  // is the only width-dependent quantity, so an unchanged one redraws the same SVG.
  let resizePending = false
  window.addEventListener('resize', () => {
    if (resizePending) return
    resizePending = true
    window.requestAnimationFrame(() => {
      resizePending = false
      if (diagramColumns(diagram.tables.length) !== drawnColumns) drawDiagram(host, diagram)
    })
  })
}
