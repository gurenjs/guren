/** Dragging the panel's left edge. The width is a per-browser convenience: storage may be blocked, and the default then holds. */
import { byId } from './dom'
import { panelElement } from './panel'

const WIDTH_KEY = 'guren-docs-panel-width'
/** The CSS caps the width at 92vw; only the floor is enforced here. */
const MIN_WIDTH = 320

export function mountResize(): void {
  const panel = panelElement()
  const resizer = byId('panel-resize')
  const setPanelWidth = (px: number | null): void => {
    for (const node of [panel, resizer]) {
      if (px === null) node.style.removeProperty('--panel-width')
      else node.style.setProperty('--panel-width', `${Math.round(Math.max(px, MIN_WIDTH))}px`)
    }
  }
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY))
    if (saved > 0) setPanelWidth(saved)
  } catch {
    // Storage blocked: the default width holds.
  }

  let pendingWidth: number | null = null
  resizer.addEventListener('pointerdown', (ev) => {
    ev.preventDefault()
    resizer.setPointerCapture(ev.pointerId)
    resizer.classList.add('active')
    document.body.classList.add('resizing')
  })
  resizer.addEventListener('pointermove', (ev) => {
    if (!resizer.hasPointerCapture(ev.pointerId)) return
    if (pendingWidth === null) {
      requestAnimationFrame(() => {
        setPanelWidth(pendingWidth)
        pendingWidth = null
      })
    }
    pendingWidth = innerWidth - ev.clientX
  })
  const endResize = (): void => {
    if (pendingWidth !== null) setPanelWidth(pendingWidth)
    resizer.classList.remove('active')
    document.body.classList.remove('resizing')
    try {
      localStorage.setItem(WIDTH_KEY, String(panel.getBoundingClientRect().width))
    } catch {
      // Storage blocked: the width lasts for this page only.
    }
  }
  resizer.addEventListener('pointerup', endResize)
  resizer.addEventListener('pointercancel', endResize)
  resizer.addEventListener('dblclick', () => {
    setPanelWidth(null)
    try {
      localStorage.removeItem(WIDTH_KEY)
    } catch {
      // Storage blocked: nothing was saved.
    }
  })
}
