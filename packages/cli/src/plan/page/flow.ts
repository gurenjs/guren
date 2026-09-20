/**
 * A flow, from the placement `layoutPlanFlows()` computed. Where a step goes is
 * that value's to say, so it is the same here, in print, and in any later view.
 * How an edge gets between two steps is the page's: it depends on the sizes below.
 */

import type { PlanFlowLayout, PlanFlowLayoutEdge, PlanFlowLayoutNode } from '../flow'
import { anchorId, idMap, type IdMap } from './dom'
import { borderPoint, svgEl, svgText, svgTip, type Box, type Point } from './svg'

const FLOW_NODE_W = 150
export const FLOW_NODE_H = 56
const FLOW_GAP_X = 58
export const FLOW_GAP_Y = 18
const FLOW_PAD_X = 20
const FLOW_PITCH_X = FLOW_NODE_W + FLOW_GAP_X
const FLOW_PITCH_Y = FLOW_NODE_H + FLOW_GAP_Y
const FLOW_LANE = 16
const FLOW_LANE_INSET = 8
const FLOW_CLEAR = 3
const FLOW_STEM = 14
const FLOW_ARROW = 7

type Lane = 'over' | 'under'

interface RoutedEdge {
  edge: PlanFlowLayoutEdge
  from: Box
  to: Box
  start: Point
  end: Point
  lane: Lane | null
  index: number
}

function flowBox(node: PlanFlowLayoutNode, top: number): Box {
  return {
    x: FLOW_PAD_X + node.column * FLOW_PITCH_X,
    y: top + node.row * FLOW_PITCH_Y,
    w: FLOW_NODE_W,
    h: FLOW_NODE_H,
  }
}

/** A filled head at the end of an edge, drawn as geometry: a `marker` is a `url()` reference. */
function flowArrow(x: number, y: number, angle: number, back: boolean): SVGPolygonElement {
  const point = (reach: number, turn: number): string =>
    (x + reach * Math.cos(angle + turn)).toFixed(1) + ',' + (y + reach * Math.sin(angle + turn)).toFixed(1)
  const head = svgEl('polygon', {
    points: [point(0, 0), point(FLOW_ARROW, Math.PI - 0.4), point(FLOW_ARROW, Math.PI + 0.4)].join(' '),
  })
  head.setAttribute('class', 'arrow' + (back ? ' back' : ''))
  return head
}

/**
 * Whether the straight line between two boxes runs through a third. It asks only
 * the cells the line passes over, so the cost is the edge's span and not the flow's
 * size. The test is the bounding box of the line within a column: it may route an
 * edge that would have grazed a corner, never draw one through a box.
 */
export function flowBlocked(start: Point, end: Point, cells: IdMap<Box>, from: Box, to: Box): boolean {
  const minX = Math.min(start[0], end[0])
  const maxX = Math.max(start[0], end[0])
  const slope = end[0] === start[0] ? null : (end[1] - start[1]) / (end[0] - start[0])
  const lastColumn = Math.floor((maxX - FLOW_PAD_X) / FLOW_PITCH_X)
  for (let column = Math.max(0, Math.floor((minX - FLOW_PAD_X) / FLOW_PITCH_X)); column <= lastColumn; column += 1) {
    const left = Math.max(minX, FLOW_PAD_X + column * FLOW_PITCH_X - FLOW_CLEAR)
    const right = Math.min(maxX, FLOW_PAD_X + column * FLOW_PITCH_X + FLOW_NODE_W + FLOW_CLEAR)
    if (left > right) continue
    const ya = slope === null ? start[1] : start[1] + slope * (left - start[0])
    const yb = slope === null ? end[1] : start[1] + slope * (right - start[0])
    const low = Math.min(ya, yb) - FLOW_CLEAR
    const high = Math.max(ya, yb) + FLOW_CLEAR
    for (let row = Math.max(0, Math.floor((low - FLOW_NODE_H) / FLOW_PITCH_Y)); row * FLOW_PITCH_Y <= high; row += 1) {
      const box = cells[column + ',' + row]
      if (box && box !== from && box !== to && box.y <= high && box.y + box.h >= low) return true
    }
  }
  return false
}

/** The room `count` lanes take beside the grid, the inset between the last one and the edge included. */
function band(count: number): number {
  return count ? FLOW_LANE_INSET + count * FLOW_LANE : 0
}

export function drawFlow(flow: PlanFlowLayout, declared: object, label: string): SVGSVGElement {
  const at = idMap<Box>()
  const cells = idMap<Box>()
  for (const node of flow.nodes) cells[node.column + ',' + node.row] = at[node.id] = flowBox(node, 0)

  // An edge a straight line cannot show is routed instead: out of the side of its
  // box, along the gap between two columns (which no box stands in), and across in
  // a lane of its own. A back edge takes a lane under the grid, a forward edge that
  // would run through a box takes one over it.
  const routes: RoutedEdge[] = []
  // Fixed keys, so a plain object: no plan string names a lane.
  const laneCount = { over: 0, under: 0 }
  for (const edge of flow.edges) {
    const from = at[edge.from]
    const to = at[edge.to]
    // The layout drops these already; a payload built elsewhere may not have.
    if (!from || !to || edge.from === edge.to) continue
    const start = borderPoint(from, to)
    const end = borderPoint(to, from)
    const lane: Lane | null = edge.back ? 'under' : flowBlocked(start, end, cells, from, to) ? 'over' : null
    const index = lane ? laneCount[lane]++ : 0
    routes.push({ edge: edge, from: from, to: to, start: start, end: end, lane: lane, index: index })
  }

  const top = band(laneCount.over)
  const grid = flow.rows * FLOW_NODE_H + (flow.rows - 1) * FLOW_GAP_Y
  const width = 2 * FLOW_PAD_X + flow.columns * FLOW_NODE_W + (flow.columns - 1) * FLOW_GAP_X
  const height = top + grid + band(laneCount.under)
  const svg = svgEl('svg', {
    class: 'flow',
    width: width,
    height: height,
    viewBox: '0 0 ' + width + ' ' + height,
    // Not `img`: that makes the node links inside presentational.
    role: 'group',
    'aria-label': label,
  })

  const labels: SVGTextElement[] = []
  for (const route of routes) {
    const edge = route.edge
    let shape: SVGElement
    let head: SVGPolygonElement
    let labelAt: Point
    if (route.lane) {
      const offset = (route.index + 1) * FLOW_LANE
      const laneY = route.lane === 'under' ? top + grid + offset : top - offset
      // Off centre, so the stub does not lie on a straight edge leaving the same side.
      const shift = route.lane === 'under' ? 12 : -12
      const y1 = top + route.from.y + route.from.h / 2 + shift
      const y2 = top + route.to.y + route.to.h / 2 + shift
      const x1 = route.from.x + route.from.w + FLOW_STEM
      const x2 = route.to.x - FLOW_STEM
      shape = svgEl('path', {
        d:
          'M ' + (route.from.x + route.from.w) + ' ' + y1 + ' H ' + x1 + ' V ' + laneY +
          ' H ' + x2 + ' V ' + y2 + ' H ' + route.to.x,
      })
      head = flowArrow(route.to.x, y2, 0, edge.back)
      labelAt = [(x1 + x2) / 2, laneY - 4]
    } else {
      const start: Point = [route.start[0], route.start[1] + top]
      const end: Point = [route.end[0], route.end[1] + top]
      shape = svgEl('line', { x1: start[0], y1: start[1], x2: end[0], y2: end[1] })
      head = flowArrow(end[0], end[1], Math.atan2(end[1] - start[1], end[0] - start[0]), false)
      labelAt = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2 - 5]
    }
    shape.setAttribute('class', 'edge' + (edge.kind === 'async' ? ' async' : '') + (edge.back ? ' back' : ''))
    svg.appendChild(shape)
    svg.appendChild(head)
    if (!edge.label) continue
    const text = svgText(labelAt[0], labelAt[1], edge.label, 'edge-label')
    text.setAttribute('text-anchor', 'middle')
    labels.push(text)
  }

  for (const node of flow.nodes) {
    // From the node, not from `at`: two steps declaring one id (a §2 finding) are
    // placed apart, and the map keeps only the last.
    const box = flowBox(node, top)
    const group = svgEl('g', { class: 'node' })
    const rect = svgEl('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: 8 })
    rect.setAttribute('class', 'box ' + node.kind)
    group.appendChild(rect)
    // The whole label, for a pointer and a screen reader: the box shows two lines of it.
    group.appendChild(svgTip(node.label))
    group.appendChild(svgText(box.x + 10, box.y + 19, node.kind, 'muted'))
    // Wrapped by hand: SVG text does not wrap, and a label is short prose.
    wrapSvgText(node.label, 20, 2).forEach((piece, index) => {
      group.appendChild(svgText(box.x + 10, box.y + 34 + index * 13, piece, 'title'))
    })
    // A node that names an element is a link into the rest of the document, through
    // the same gate every other anchor goes through. One naming an element the plan
    // does not declare is a finding on the card, and a link to nowhere if drawn as one.
    const anchor = node.element && node.element in declared ? anchorId(node.element) : null
    if (anchor) {
      const a = svgEl('a', { href: '#' + anchor })
      a.appendChild(group)
      svg.appendChild(a)
    } else {
      svg.appendChild(group)
    }
  }

  for (const text of labels) svg.appendChild(text)
  return svg
}

/** Width in Latin characters: an East Asian character is about two of them wide. */
function textUnits(text: string): number {
  let units = 0
  for (let index = 0; index < text.length; index += 1) units += text.charCodeAt(index) > 0x2e7f ? 2 : 1
  return units
}

/** The longest prefix of `text` within `limit` units, never ending inside a surrogate pair. */
function fitPrefix(text: string, limit: number): number {
  let units = 0
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    const pair = code >= 0xd800 && code <= 0xdbff ? 2 : 1
    const next = units + pair * (code > 0x2e7f ? 2 : 1)
    if (next > limit && index > 0) break
    units = next
    index += pair
  }
  return index
}

/**
 * Greedy wrap to `limit` units and `most` lines. A word too long for a line is
 * broken, which is every line of a language written without spaces; a label cut
 * short says so.
 */
export function wrapSvgText(text: string, limit: number, most: number): string[] {
  const lines: string[] = []
  let line = ''
  const pieces = text.split(/\s+/).filter(Boolean)
  // One line past `most` is all the cut needs to know about; a label has no length limit.
  for (let at = 0; at < pieces.length && lines.length <= most; at += 1) {
    const word = pieces[at]
    if (line !== '' && textUnits(line) + 1 + textUnits(word) <= limit) {
      line += ' ' + word
      continue
    }
    if (line !== '') lines.push(line)
    line = word
    for (let cut = fitPrefix(line, limit); cut < line.length && lines.length <= most; cut = fitPrefix(line, limit)) {
      lines.push(line.slice(0, cut))
      line = line.slice(cut)
    }
  }
  if (line !== '') lines.push(line)
  if (lines.length <= most) return lines
  const kept = lines.slice(0, most)
  const last = kept[most - 1]
  kept[most - 1] = last.slice(0, fitPrefix(last, limit - 1)) + '…'
  return kept
}
