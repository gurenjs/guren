/** Zoom and pan move the viewBox over the fixed simulation space, so node positions never change. */
import { byId } from './dom'
import { graphSvg, toGraph } from './graph'
import { closePanel } from './panel'
import { H, state, W } from './state'

const ZOOM_STEP = 1.25
/** deltaMode 1 (Firefox's mouse wheel) counts lines and 2 pages; both become pixels here. */
const WHEEL_UNIT = [1, 16, 400]

const view = { x: 0, y: 0, w: W, h: H }

function applyView(): void {
  graphSvg().setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`)
}

/** Screen pixels per graph unit, for turning a pointer or wheel delta into a pan. */
function pixelsPerUnit(): number {
  return graphSvg().getScreenCTM()?.a ?? 1
}

function zoomAt(point: { x: number; y: number }, factor: number): void {
  const w = Math.min(Math.max(view.w * factor, W / 10), W * 4)
  const k = w / view.w
  view.x = point.x - (point.x - view.x) * k
  view.y = point.y - (point.y - view.y) * k
  view.w = w
  view.h = (w * H) / W
  applyView()
}

export function zoomIn(): void {
  zoomAt({ x: view.x + view.w / 2, y: view.y + view.h / 2 }, 1 / ZOOM_STEP)
}

export function zoomOut(): void {
  zoomAt({ x: view.x + view.w / 2, y: view.y + view.h / 2 }, ZOOM_STEP)
}

export function fitView(): void {
  if (state.nodes.length === 0) return
  const pad = 60
  const xs = state.nodes.map((node) => node.x)
  const ys = state.nodes.map((node) => node.y)
  const minX = Math.min(...xs) - pad
  const maxX = Math.max(...xs) + pad
  const minY = Math.min(...ys) - pad
  const maxY = Math.max(...ys) + pad
  view.w = Math.max(maxX - minX, ((maxY - minY) * W) / H, W / 4)
  view.h = (view.w * H) / W
  view.x = (minX + maxX) / 2 - view.w / 2
  view.y = (minY + maxY) / 2 - view.h / 2
  applyView()
}

export function mountZoom(): void {
  const svg = graphSvg()
  // A trackpad pinch arrives as a wheel event with ctrlKey set; a plain wheel or two-finger scroll pans.
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault()
    const unit = WHEEL_UNIT[ev.deltaMode] ?? 1
    if (ev.ctrlKey || ev.metaKey) {
      zoomAt(toGraph(ev.clientX, ev.clientY), Math.exp(ev.deltaY * unit * 0.01))
      return
    }
    const scale = pixelsPerUnit()
    view.x += (ev.deltaX * unit) / scale
    view.y += (ev.deltaY * unit) / scale
    applyView()
  }, { passive: false })

  let panning: { x: number; y: number; viewX: number; viewY: number; scale: number; moved: boolean } | null = null
  const stopPan = (): void => {
    panning = null
    svg.classList.remove('dragging')
  }
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.target !== svg || ev.button !== 0) return
    try {
      svg.setPointerCapture(ev.pointerId)
    } catch {
      // A pointer the browser does not track cannot be captured; the pan still follows moves over the graph.
    }
    panning = { x: ev.clientX, y: ev.clientY, viewX: view.x, viewY: view.y, scale: pixelsPerUnit(), moved: false }
  })
  svg.addEventListener('pointermove', (ev) => {
    if (!panning) return
    if (ev.buttons === 0) return stopPan()
    const dx = ev.clientX - panning.x
    const dy = ev.clientY - panning.y
    if (!panning.moved && Math.hypot(dx, dy) < 3) return
    panning.moved = true
    svg.classList.add('dragging')
    view.x = panning.viewX - dx / panning.scale
    view.y = panning.viewY - dy / panning.scale
    applyView()
  })
  svg.addEventListener('pointerup', () => {
    if (panning && !panning.moved) closePanel()
    stopPan()
  })
  svg.addEventListener('pointercancel', stopPan)
  byId('zoom-in').addEventListener('click', zoomIn)
  byId('zoom-out').addEventListener('click', zoomOut)
  byId('zoom-fit').addEventListener('click', fitView)
}
