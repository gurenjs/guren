/** The SVG graph: building it from the payload, the force layout, node interaction and the filters. */
import type { DocsViewerData } from '../docs-viewer'
import { byId, el, svgEl } from './dom'
import { groupTests, kindOf, TOGGLE_KINDS, withOpenPlans, type ViewNode } from './model'
import { closePanel, openPanel } from './panel'
import { renderPlanList, renderScanWarnings } from './plans'
import { H, state, W, type SimNode } from './state'

const RADIUS = { doc: 22, entity: 15, code: 10, test: 9, openplan: 19 } as const
const GROUP_RADIUS = 14

let svg: SVGSVGElement

export function graphSvg(): SVGSVGElement {
  return svg
}

export function toGraph(clientX: number, clientY: number): DOMPoint {
  const point = svg.createSVGPoint()
  point.x = clientX
  point.y = clientY
  return point.matrixTransform(svg.getScreenCTM()!.inverse())
}

export function rebuild(data: DocsViewerData): void {
  const previous = state.byId
  state.data = data
  state.docByPath = new Map(data.docs.map((doc) => [doc.path, doc]))
  state.testFiles = new Map(data.tests.map((test) => [test.id, test.files]))
  const payload = { nodes: data.nodes, edges: data.edges }
  const view = withOpenPlans(state.testsGrouped ? groupTests(payload) : payload, data.plans)
  state.nodes = view.nodes.map((node): SimNode => {
    const old = previous.get(node.id)
    return {
      ...node,
      x: old ? old.x : W / 2 + (Math.random() - 0.5) * 60,
      y: old ? old.y : H / 2 + (Math.random() - 0.5) * 60,
      vx: 0,
      vy: 0,
      r: node.members ? GROUP_RADIUS : RADIUS[node.kind],
    }
  })
  // Fresh graphs get ring seeding: docs and plans inner, satellites outer.
  if (previous.size === 0) {
    const inner = state.nodes.filter((node) => node.kind === 'doc' || node.kind === 'openplan')
    const outer = state.nodes.filter((node) => node.kind !== 'doc' && node.kind !== 'openplan')
    inner.forEach((node, index) => {
      const angle = (index / Math.max(inner.length, 1)) * Math.PI * 2
      node.x = W / 2 + Math.cos(angle) * 130
      node.y = H / 2 + Math.sin(angle) * 130
    })
    outer.forEach((node, index) => {
      const angle = (index / Math.max(outer.length, 1)) * Math.PI * 2 + 0.5
      node.x = W / 2 + Math.cos(angle) * 300
      node.y = H / 2 + Math.sin(angle) * 300
    })
  }
  state.edges = view.edges
  state.byId = new Map(state.nodes.map((node) => [node.id, node]))
  state.neighbors = new Map(state.nodes.map((node) => [node.id, new Set([node.id])]))
  for (const edge of state.edges) {
    state.neighbors.get(edge.from)?.add(edge.to)
    state.neighbors.get(edge.to)?.add(edge.from)
  }
  renderDom()
  renderStats()
  applyFilters()
  // A scan that stopped is not an empty bundle: the warning above the plan list says why.
  byId('empty-state').classList.toggle('visible', data.docs.length === 0 && !data.docsScanFailure)
  if (state.selected && !state.byId.has(state.selected)) closePanel()
  else if (state.selected) openPanel(state.selected, { keepScroll: true })
  settle(320)
}

function renderDom(): void {
  svg.textContent = ''
  const edgeLayer = svgEl('g')
  const nodeLayer = svgEl('g')
  svg.append(edgeLayer, nodeLayer)

  state.edgeEls = state.edges.map((e) => {
    const line = svgEl('line')
    line.setAttribute('class', `edge ${e.relation}${e.verdict !== 'pass' ? ` ${e.verdict}` : ''}`)
    edgeLayer.append(line)
    return { e, line }
  })

  state.nodeEls = state.nodes.map((n) => {
    const g = svgEl('g')
    const kind = kindOf(n)
    g.setAttribute('class', `node ${n.kind}${kind !== n.kind ? ` ${kind}` : ''}${n.members ? ' group' : ''}`)
    g.setAttribute('tabindex', '0')
    g.setAttribute('role', 'button')
    g.setAttribute('aria-label', n.label)

    const halo = svgEl('circle')
    halo.setAttribute('class', 'halo')
    halo.setAttribute('r', String(n.r + 5))
    const circle = svgEl('circle')
    circle.setAttribute('r', String(n.r))
    g.append(halo, circle)

    const tagText = n.plan ? n.plan.standing : n.kind === 'doc' ? n.docType : undefined
    if (tagText) {
      const tag = svgEl('text')
      tag.setAttribute('class', 'kindtag')
      tag.setAttribute('dy', '3')
      tag.textContent = tagText
      g.append(tag)
    }
    if (n.members) {
      const count = svgEl('text')
      count.setAttribute('class', 'count')
      count.setAttribute('dy', '3.5')
      count.textContent = `×${n.members.length}`
      g.append(count)
    }
    const name = svgEl('text')
    name.setAttribute('class', 'name')
    name.setAttribute('dy', String(n.r + 15))
    name.textContent = n.label
    g.append(name)

    wireNode(n, g)
    nodeLayer.append(g)
    return { n, g }
  })
}

function renderStats(): void {
  const { data } = state
  const human = data.docs.filter((doc) => doc.trustTier === 'human-reviewed').length
  const stats: Array<[string, number]> = [
    ['concepts', data.docs.length],
    ['relations', data.edges.length],
    ['human-reviewed', human],
    ['open plans', data.plans.length],
  ]
  renderScanWarnings()
  renderPlanList()
  const host = byId('stats')
  host.textContent = ''
  for (const [label, value] of stats) {
    const stat = el('div', 'stat')
    stat.append(el('span', 'stat-value', String(value)), el('span', 'stat-label', label))
    host.append(stat)
  }
}

let alpha = 1
let dragged: SimNode | null = null
let ticking = false

function step(): void {
  const { nodes, edges, byId: nodeById } = state
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      const d2 = dx * dx + dy * dy || 1
      const d = Math.sqrt(d2)
      const push = Math.min(3200 / d2, 8)
      dx /= d
      dy /= d
      a.vx -= dx * push
      a.vy -= dy * push
      b.vx += dx * push
      b.vy += dy * push
    }
  }
  for (const edge of edges) {
    const a = nodeById.get(edge.from)
    const b = nodeById.get(edge.to)
    if (!a || !b) continue
    const rest = a.kind === 'doc' && b.kind === 'doc' ? 190 : 120
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.sqrt(dx * dx + dy * dy) || 1
    const pull = (d - rest) * 0.012
    a.vx += (dx / d) * pull
    a.vy += (dy / d) * pull
    b.vx -= (dx / d) * pull
    b.vy -= (dy / d) * pull
  }
  for (const node of nodes) {
    node.vx += (W / 2 - node.x) * 0.0035
    node.vy += (H / 2 - node.y) * 0.0035
    if (node !== dragged) {
      node.x += node.vx * alpha
      node.y += node.vy * alpha
    }
    node.vx *= 0.86
    node.vy *= 0.86
    const margin = 30
    node.x = Math.max(margin, Math.min(W - margin, node.x))
    node.y = Math.max(margin, Math.min(H - margin, node.y))
  }
  alpha = Math.max(alpha * 0.995, 0.02)
}

function tick(): void {
  ticking = true
  step()
  render()
  if (alpha > 0.02 || dragged) requestAnimationFrame(tick)
  else ticking = false
}

/**
 * Settling runs synchronously so the layout never depends on requestAnimationFrame: a background
 * tab gets no frames, and the graph would otherwise freeze mid-simulation until focused.
 */
function settle(steps: number): void {
  alpha = 1
  for (let i = 0; i < steps; i++) step()
  alpha = 0.02
  render()
}

function reheat(): void {
  alpha = 0.9
  if (!ticking) requestAnimationFrame(tick)
}

function render(): void {
  for (const { e, line } of state.edgeEls) {
    const a = state.byId.get(e.from)
    const b = state.byId.get(e.to)
    if (!a || !b) continue
    line.setAttribute('x1', String(a.x))
    line.setAttribute('y1', String(a.y))
    line.setAttribute('x2', String(b.x))
    line.setAttribute('y2', String(b.y))
  }
  for (const { n, g } of state.nodeEls) g.setAttribute('transform', `translate(${n.x},${n.y})`)
}

function wireNode(n: SimNode, g: SVGGElement): void {
  let moved = false
  g.addEventListener('pointerdown', (ev) => {
    dragged = n
    moved = false
    svg.classList.add('dragging')
    g.setPointerCapture(ev.pointerId)
    reheat()
  })
  g.addEventListener('pointermove', (ev) => {
    if (dragged !== n) return
    moved = true
    const point = toGraph(ev.clientX, ev.clientY)
    n.x = point.x
    n.y = point.y
  })
  const finish = (): void => {
    if (dragged !== n) return
    dragged = null
    svg.classList.remove('dragging')
  }
  g.addEventListener('pointerup', () => {
    finish()
    if (!moved) openPanel(n.id)
  })
  g.addEventListener('pointercancel', finish)
  g.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    ev.preventDefault()
    openPanel(n.id)
  })
  g.addEventListener('pointerenter', () => highlight(n.id))
  g.addEventListener('pointerleave', () => highlight(null))
}

export function markSelected(id: string | null): void {
  for (const { n, g } of state.nodeEls) g.classList.toggle('selected', n.id === id)
}

/** Unhovering restores the filter state rather than restating it: the search-dim rule lives in applyFilters only. */
function highlight(id: string | null): void {
  if (!id) {
    for (const { line } of state.edgeEls) line.classList.remove('hot')
    applyFilters()
    return
  }
  const hood = state.neighbors.get(id) ?? new Set([id])
  for (const { n, g } of state.nodeEls) g.classList.toggle('dim', !hood.has(n.id))
  for (const { e, line } of state.edgeEls) {
    const touches = e.from === id || e.to === id
    line.classList.toggle('hot', touches)
    line.classList.toggle('dim', !touches)
  }
}

function matchesSearch(node: ViewNode | undefined): boolean {
  if (!node || state.searchTerm === '') return true
  return (node.searchText ?? `${node.label} ${node.id}`.toLowerCase()).includes(state.searchTerm)
}

function applyFilters(): void {
  const searching = state.searchTerm !== ''
  for (const { n, g } of state.nodeEls) {
    g.classList.toggle('hidden', !state.kindEnabled[kindOf(n)])
    g.classList.toggle('dim', searching && !matchesSearch(n))
  }
  for (const { e, line } of state.edgeEls) {
    const a = state.byId.get(e.from)
    const b = state.byId.get(e.to)
    const visible = a !== undefined && b !== undefined && state.kindEnabled[kindOf(a)] && state.kindEnabled[kindOf(b)]
    line.classList.toggle('hidden', !visible)
    line.classList.toggle('dim', searching && !(matchesSearch(a) || matchesSearch(b)))
  }
}

export function mountGraph(): void {
  svg = byId<SVGSVGElement>('graph')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')

  byId<HTMLInputElement>('search').addEventListener('input', (ev) => {
    state.searchTerm = (ev.target as HTMLInputElement).value.trim().toLowerCase()
    applyFilters()
  })

  const toggleHost = byId('kind-toggles')
  for (const kind of TOGGLE_KINDS) {
    const button = el('button', '', kind)
    button.setAttribute('aria-pressed', 'true')
    button.addEventListener('click', () => {
      state.kindEnabled[kind] = !state.kindEnabled[kind]
      button.setAttribute('aria-pressed', String(state.kindEnabled[kind]))
      applyFilters()
    })
    toggleHost.append(button)
  }
  const groupButton = byId('group-tests')
  groupButton.addEventListener('click', () => {
    state.testsGrouped = !state.testsGrouped
    groupButton.setAttribute('aria-pressed', String(state.testsGrouped))
    rebuild(state.data)
  })
}
