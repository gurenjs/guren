/**
 * The board canvas (RFC 0041 §2): notes, arrows and sections drawn from the board, and every edit
 * sent as operations to the board's ops route through `board-queue.ts`, which shows an edit before
 * the server answers. Every board string is written with `textContent`, since an agent or a person
 * wrote it.
 */

import type { DroppedBoardOp } from '../board/apply'
import { compareIds } from '../board/canonical'
import { BOARD_EXTENT, BOARD_MAX_NOTES, BOARD_NOTE_KINDS, lineProblem, NOTE_SIZE, NOTE_TEXT_MAX, SECTION_TITLE_MAX, sectionUnder, snap, snapNote, snapRect, type BoardNoteKind } from '../board/geometry'
import type { BoardOp } from '../board/ops'
import { DEFAULT_SECTION_SIZE } from '../board/place'
import type { Board, BoardArrow, BoardNote, BoardSection } from '../board/schema'
import { boardOpsPath } from '../dev-center-links'
import { el } from '../docs-viewer-page/dom'
import { borderPoint, svgEl } from '../plan/page/svg'
import { aboutOps, arrowEnds, arrowKey, besideNote, dragOps, freeSpot, newId, noteUnder } from './board-model'
import { createBoardQueue, type PostResult, type QueueStatus } from './board-queue'
import { boardWords, kindWord, type BoardWords } from './board-words'

const MIN_ZOOM = 0.2
const MAX_ZOOM = 2
const DRAG_THRESHOLD = 3
const KEY_STEP = 8
const KEY_STEP_LARGE = 40

type Selection = { notes: Set<string>; section?: string; arrow?: string }

export interface BoardCanvas {
  /** Replaces the board read again from the server, unless a save settled since `stamp()` was taken. */
  replace(board: Board, stamp: number): boolean
  /** Whether edits are waiting to be saved. */
  busy(): boolean
  stamp(): number
}

/** One request to the ops route, read into what the queue needs. */
async function postOps(slug: string, ops: BoardOp[]): Promise<PostResult> {
  const response = await fetch(boardOpsPath(slug), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops }),
    cache: 'no-store',
    redirect: 'error',
  })
  const payload = (await response.json().catch(() => ({}))) as { board?: Board; dropped?: DroppedBoardOp[]; outline?: unknown; error?: { code?: string; message?: string } }
  if (response.ok && payload.board) {
    return { ok: true, board: payload.board, dropped: payload.dropped ?? [], ...(typeof payload.outline === 'string' ? { outline: payload.outline } : {}) }
  }
  return { ok: false, locked: response.status === 409 && payload.error?.code === 'locked', reason: payload.error?.message ?? `HTTP ${response.status}` }
}

export function mountBoardCanvas(
  root: HTMLElement,
  slug: string,
  initial: Board,
  reread: () => Promise<Board>,
  onOutline: (text: string) => void = () => {},
): BoardCanvas {
  const words: BoardWords = boardWords(initial.locale)
  let view = initial
  const selection: Selection = { notes: new Set() }
  let connecting = false
  let zoom = 1
  let pan = { x: 24, y: 24 }
  let lastKind: BoardNoteKind = 'event'
  // A rebuild mid-gesture would replace the node holding the pointer capture, so it waits.
  let gesturing = false
  let stale = false

  const tools = el('div', 'board-tools')
  const status = el('p', 'board-status meta')
  status.setAttribute('role', 'status')
  const viewport = el('div', 'board-viewport')
  viewport.tabIndex = 0
  viewport.setAttribute('role', 'application')
  viewport.setAttribute('aria-label', words('aria.canvas'))
  const world = el('div', 'board-world')
  const sectionLayer = el('div', 'board-layer')
  const arrows = svgEl('svg', { class: 'board-arrows', width: BOARD_EXTENT, height: BOARD_EXTENT, viewBox: `0 0 ${BOARD_EXTENT} ${BOARD_EXTENT}` })
  const noteLayer = el('div', 'board-layer')
  world.append(sectionLayer, arrows, noteLayer)
  viewport.append(world)
  // A sibling of the viewport, so its keys and pointers never reach the canvas handlers.
  const zoomBar = el('div', 'board-zoom')
  const stage = el('div', 'board-stage')
  stage.append(viewport, zoomBar)
  root.replaceChildren(tools, stage, status, el('p', 'meta', words('help')))

  const say = (text: string, tone: '' | 'warning' | 'error' = '') => {
    status.textContent = text
    status.className = `board-status meta ${tone}`.trim()
  }

  const applyView = () => {
    world.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
  }

  const toWorld = (clientX: number, clientY: number) => {
    const rect = viewport.getBoundingClientRect()
    return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom }
  }

  const viewportCentre = () => {
    const rect = viewport.getBoundingClientRect()
    return toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }

  const onChange = (next: Board) => {
    view = next
    for (const id of selection.notes) if (!view.notes.some((note) => note.id === id)) selection.notes.delete(id)
    if (selection.section && !view.sections.some((section) => section.id === selection.section)) selection.section = undefined
    if (selection.arrow && !view.arrows.some((arrow) => arrowKey(arrow) === selection.arrow)) selection.arrow = undefined
    if (gesturing) stale = true
    else render()
  }

  const onStatus = (next: QueueStatus) => {
    if (next.kind === 'saving') say(words('status.saving'))
    else if (next.kind === 'saved') say(words('status.saved'))
    else if (next.kind === 'dropped') say(words('status.dropped', { count: next.count, reason: next.reason }), 'warning')
    else if (next.kind === 'locked') say(words('status.locked'), 'error')
    else say(words('status.failed', { reason: next.reason }), 'error')
    paint()
  }

  const queue = createBoardQueue(initial, (ops) => postOps(slug, ops), reread, { change: onChange, status: onStatus, outline: onOutline })
  const submit = queue.submit

  /** One-line text input over the canvas; `commit` gets the trimmed value, which it may refuse. */
  const ask = (at: { x: number; y: number; width: number }, label: string, value: string, max: number, commit: (text: string) => void) => {
    const input = el('input', 'g-input board-input')
    input.type = 'text'
    input.maxLength = max
    input.value = value
    input.setAttribute('aria-label', label)
    input.style.left = `${at.x}px`
    input.style.top = `${at.y}px`
    input.style.width = `${at.width}px`
    let done = false
    const finish = (save: boolean) => {
      if (done) return
      const text = input.value.trim()
      const changed = save && text !== value
      const problem = changed ? lineProblem(text, max) : undefined
      if (problem) {
        say(words(problem === 'empty' ? 'input.empty' : problem === 'too-long' ? 'input.tooLong' : 'input.oneLine', { max }), 'warning')
        input.focus()
        return
      }
      done = true
      input.remove()
      if (changed) commit(text)
      focusSelection()
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      // Enter during an IME composition confirms the conversion, not the text.
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Enter') { event.preventDefault(); finish(true) }
      if (event.key === 'Escape') { event.preventDefault(); finish(false) }
    })
    input.addEventListener('blur', () => finish(true))
    world.append(input)
    input.focus()
    input.select()
  }

  const addNote = (kind: BoardNoteKind, point: { x: number; y: number }) => {
    if (view.notes.length >= BOARD_MAX_NOTES) {
      say(words('status.full', { max: BOARD_MAX_NOTES }), 'warning')
      return
    }
    lastKind = kind
    const at = freeSpot(view, snapNote({ x: point.x - NOTE_SIZE.width / 2, y: point.y - NOTE_SIZE.height / 2 }))
    ask({ ...at, width: NOTE_SIZE.width }, words('input.note', { kind: kindWord(words, kind) }), '', NOTE_TEXT_MAX, (text) => {
      const id = newId(view, 'n')
      const section = sectionUnder(view, at)?.id
      if (submit([{ op: 'add', id, kind, text, at, ...(section ? { section } : {}) }])) select({ notes: new Set([id]) })
    })
  }

  const addSection = () => {
    const centre = viewportCentre()
    const at = { x: snap(centre.x - DEFAULT_SECTION_SIZE.width / 2), y: snap(centre.y - DEFAULT_SECTION_SIZE.height / 2) }
    ask({ ...at, width: 280 }, words('input.section'), '', SECTION_TITLE_MAX, (title) => {
      const id = newId(view, 's')
      if (submit([{ op: 'section', id, title, at: snapRect({ ...at, ...DEFAULT_SECTION_SIZE }) }])) select({ notes: new Set(), section: id })
    })
  }

  const editNote = (note: BoardNote) => {
    ask({ x: note.x, y: note.y + 28, width: NOTE_SIZE.width }, words('input.note', { kind: kindWord(words, note.kind) }), note.text, NOTE_TEXT_MAX, (text) => {
      submit([{ op: 'edit', id: note.id, text }])
    })
  }

  const renameSection = (section: BoardSection) => {
    ask({ x: section.x + 8, y: section.y + 4, width: Math.min(section.width - 16, 320) }, words('input.section'), section.title, SECTION_TITLE_MAX, (title) => {
      submit([{ op: 'section', id: section.id, title }])
    })
  }

  const select = (next: Selection) => {
    selection.notes = next.notes
    selection.section = next.section
    selection.arrow = next.arrow
    connecting = false
    paint()
  }

  const removeSelected = () => {
    const ops: BoardOp[] = []
    for (const id of selection.notes) ops.push({ op: 'remove', id })
    if (selection.section) ops.push({ op: 'unsection', id: selection.section })
    if (selection.arrow) ops.push({ op: 'disconnect', ...arrowEnds(selection.arrow) })
    submit(ops)
    select({ notes: new Set() })
    // The delete button hides itself, and a removed note took the focus with it.
    viewport.focus({ preventScroll: true })
  }

  const toggleAsync = () => {
    const arrow = view.arrows.find((candidate) => arrowKey(candidate) === selection.arrow)
    if (!arrow) return
    submit([{ op: 'connect', from: arrow.from, to: arrow.to, ...(arrow.kind === 'async' ? {} : { kind: 'async' as const }) }])
  }

  const undoLast = () => {
    if (!queue.undo()) {
      say(words('status.nothingToUndo'))
      return
    }
    select({ notes: new Set() })
  }

  /** Ends a connection at `target`; an arrow that exists is left as it is, async or not. */
  const finishConnect = (target: string) => {
    const [from] = [...selection.notes]
    if (from && from !== target && !view.arrows.some((arrow) => arrow.from === from && arrow.to === target)) submit([{ op: 'connect', from, to: target }])
    say('')
    select({ notes: new Set([target]) })
  }

  const startConnect = () => {
    if (selection.notes.size !== 1) return
    connecting = true
    say(words('status.connect'))
    paint()
  }

  const setZoom = (next: number, around = viewportCentre()) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
    const rect = viewport.getBoundingClientRect()
    const screen = { x: around.x * zoom + pan.x, y: around.y * zoom + pan.y }
    zoom = clamped
    pan = { x: screen.x - around.x * zoom, y: screen.y - around.y * zoom }
    if (rect.width === 0) return
    applyView()
  }

  const fit = () => {
    const boxes = [
      ...view.notes.map((note) => ({ x: note.x, y: note.y, w: NOTE_SIZE.width, h: NOTE_SIZE.height })),
      ...view.sections.map((section) => ({ x: section.x, y: section.y, w: section.width, h: section.height })),
    ]
    const rect = viewport.getBoundingClientRect()
    if (boxes.length === 0 || rect.width === 0) {
      zoom = 1
      pan = { x: 24, y: 24 }
      applyView()
      return
    }
    const left = Math.min(...boxes.map((box) => box.x))
    const top = Math.min(...boxes.map((box) => box.y))
    const right = Math.max(...boxes.map((box) => box.x + box.w))
    const bottom = Math.max(...boxes.map((box) => box.y + box.h))
    zoom = Math.min(1, Math.max(MIN_ZOOM, Math.min((rect.width - 48) / (right - left), (rect.height - 48) / (bottom - top))))
    pan = { x: 24 - left * zoom, y: 24 - top * zoom }
    applyView()
  }

  const button = (label: string, action: () => void, className = 'g-btn g-btn-secondary') => {
    const node = el('button', className, label)
    node.type = 'button'
    node.addEventListener('click', action)
    return node
  }

  const addMenu = el('div', 'board-menu')
  addMenu.setAttribute('role', 'menu')
  addMenu.hidden = true
  const closeAddMenu = (refocus = false) => {
    if (addMenu.hidden) return
    addMenu.hidden = true
    addButton.setAttribute('aria-expanded', 'false')
    if (refocus) addButton.focus()
  }
  const kindItems = BOARD_NOTE_KINDS.map((kind) => {
    const item = button(kindWord(words, kind), () => {
      closeAddMenu()
      addNote(kind, viewportCentre())
    }, 'board-menu-item')
    item.prepend(el('span', `board-swatch board-kind-${kind}`))
    item.setAttribute('role', 'menuitem')
    item.tabIndex = -1
    return item
  })
  addMenu.append(...kindItems)
  const addButton = button(words('tool.add'), () => {
    if (!addMenu.hidden) return closeAddMenu()
    addMenu.hidden = false
    addButton.setAttribute('aria-expanded', 'true')
    kindItems[0]?.focus()
  })
  addButton.append(el('span', 'board-caret', '▾'))
  addButton.lastElementChild!.setAttribute('aria-hidden', 'true')
  addButton.setAttribute('aria-haspopup', 'menu')
  addButton.setAttribute('aria-expanded', 'false')
  const addWrap = el('div', 'board-add')
  addWrap.append(addButton, addMenu)
  // Safari does not focus a clicked button, so a mouse press must not move focus out of the menu.
  addWrap.addEventListener('mousedown', (event) => event.preventDefault())
  addWrap.addEventListener('focusout', (event) => {
    if (!(event.relatedTarget instanceof Node && addWrap.contains(event.relatedTarget))) closeAddMenu()
  })
  addMenu.addEventListener('keydown', (event) => {
    const at = kindItems.indexOf(document.activeElement as HTMLButtonElement)
    const last = kindItems.length - 1
    const next = { ArrowDown: at < last ? at + 1 : 0, ArrowUp: at > 0 ? at - 1 : last, Home: 0, End: last }[event.key]
    if (next !== undefined) {
      event.preventDefault()
      kindItems[next]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeAddMenu(true)
    }
  })

  const sectionButton = button(words('tool.section'), addSection)
  const connectButton = button(words('tool.connect'), startConnect)
  const asyncButton = button(words('tool.async'), toggleAsync)
  const deleteButton = button(words('tool.delete'), removeSelected)
  const selectionTools = el('div', 'board-tool-context')
  selectionTools.append(connectButton, asyncButton, deleteButton)
  const undoButton = button(words('tool.undo'), undoLast, 'g-btn g-btn-secondary board-undo')
  tools.append(addWrap, sectionButton, selectionTools, undoButton)

  const zoomOut = button('−', () => setZoom(zoom / 1.25))
  zoomOut.setAttribute('aria-label', words('tool.zoomOut'))
  const zoomIn = button('+', () => setZoom(zoom * 1.25))
  zoomIn.setAttribute('aria-label', words('tool.zoomIn'))
  zoomBar.append(zoomOut, zoomIn, button(words('tool.fit'), fit))

  const noteNodes = new Map<string, HTMLElement>()
  const sectionNodes = new Map<string, HTMLElement>()
  const arrowNodes = new Map<string, SVGElement>()

  const render = () => {
    const active = document.activeElement
    const focusedId = active instanceof HTMLElement && noteLayer.contains(active) ? active.dataset.id : undefined
    const focusedSection = active instanceof HTMLElement && sectionLayer.contains(active) ? active.dataset.section : undefined
    const kinds = new Map(view.notes.map((note) => [note.id, note]))
    sectionNodes.clear()
    arrowNodes.clear()
    sectionLayer.replaceChildren(...view.sections.map(drawSection))
    noteNodes.clear()
    // Tab order follows reading order on the board, top to bottom, then left to right.
    const ordered = [...view.notes].sort((a, b) => a.y - b.y || a.x - b.x || compareIds(a.id, b.id))
    noteLayer.replaceChildren(...ordered.map(drawNote))
    const defs = svgEl('defs')
    const marker = svgEl('marker', { id: 'board-head', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })
    marker.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: 'board-head' }))
    defs.append(marker)
    const lines: SVGElement[] = [defs]
    for (const arrow of view.arrows) {
      const from = kinds.get(arrow.from)
      const to = kinds.get(arrow.to)
      if (from && to) lines.push(drawArrow(arrow, from, to))
    }
    for (const note of view.notes) {
      for (const target of note.about ?? []) {
        const other = kinds.get(target)
        if (other) lines.push(drawTether(note, other))
      }
    }
    arrows.replaceChildren(...lines)
    // The focused node was replaced; a note or section that is gone hands focus to the canvas, which keeps the keys working.
    if (focusedId || focusedSection) {
      const next = focusedId ? noteNodes.get(focusedId) : sectionNodes.get(focusedSection!)?.querySelector<HTMLElement>('.board-section-title')
      ;(next ?? viewport).focus({ preventScroll: true })
    }
    paint()
  }

  /** Back to what was being edited, so Tab and the arrow keys carry on from there. */
  const focusSelection = () => {
    const [only] = selection.notes.size === 1 ? selection.notes : []
    const next = selection.section !== undefined
      ? sectionNodes.get(selection.section)?.querySelector<HTMLElement>('.board-section-title')
      : only !== undefined ? noteNodes.get(only) : undefined
    ;(next ?? viewport).focus({ preventScroll: true })
  }

  const paint = () => {
    for (const [id, node] of noteNodes) {
      const on = selection.notes.has(id)
      node.classList.toggle('board-selected', on)
      node.classList.toggle('board-source', connecting && on)
      node.setAttribute('aria-pressed', String(on))
    }
    for (const [id, node] of sectionNodes) node.classList.toggle('board-selected', selection.section === id)
    for (const [key, node] of arrowNodes) node.classList.toggle('board-selected', selection.arrow === key)
    connectButton.hidden = selection.notes.size !== 1
    connectButton.classList.toggle('board-on', connecting)
    asyncButton.hidden = selection.arrow === undefined
    const selectedArrow = view.arrows.find((candidate) => arrowKey(candidate) === selection.arrow)
    asyncButton.textContent = selectedArrow?.kind === 'async' ? words('tool.sync') : words('tool.async')
    deleteButton.hidden = selection.notes.size === 0 && !selection.section && !selection.arrow
    selectionTools.hidden = deleteButton.hidden
    undoButton.disabled = !queue.canUndo()
    addButton.disabled = view.notes.length >= BOARD_MAX_NOTES
    if (addButton.disabled) closeAddMenu()
  }

  const box = (note: BoardNote) => ({ x: note.x, y: note.y, w: NOTE_SIZE.width, h: NOTE_SIZE.height })

  const drawArrow = (arrow: BoardArrow, from: BoardNote, to: BoardNote): SVGElement => {
    const [x1, y1] = borderPoint(box(from), box(to))
    const [x2, y2] = borderPoint(box(to), box(from))
    const group = svgEl('g', { class: `board-arrow${arrow.kind === 'async' ? ' board-async' : ''}` })
    arrowNodes.set(arrowKey(arrow), group)
    group.append(
      svgEl('line', { x1, y1, x2, y2, class: 'board-arrow-hit' }),
      svgEl('line', { x1, y1, x2, y2, class: 'board-arrow-line', 'marker-end': 'url(#board-head)' }),
    )
    group.addEventListener('pointerdown', (event) => {
      event.stopPropagation()
      select({ notes: new Set(), arrow: arrowKey(arrow) })
      viewport.focus()
    })
    return group
  }

  const drawTether = (question: BoardNote, target: BoardNote): SVGElement => {
    const [x1, y1] = borderPoint(box(question), box(target))
    const [x2, y2] = borderPoint(box(target), box(question))
    return svgEl('line', { x1, y1, x2, y2, class: 'board-tether' })
  }

  const drawSection = (section: BoardSection): HTMLElement => {
    const node = el('div', 'board-section')
    sectionNodes.set(section.id, node)
    Object.assign(node.style, { left: `${section.x}px`, top: `${section.y}px`, width: `${section.width}px`, height: `${section.height}px` })
    const title = el('div', 'board-section-title', section.title)
    title.tabIndex = 0
    title.setAttribute('role', 'button')
    title.dataset.section = section.id
    title.setAttribute('aria-label', words('aria.section', { title: section.title }))
    title.addEventListener('focus', () => {
      if (title.matches(':focus-visible') && selection.section !== section.id) select({ notes: new Set(), section: section.id })
    })
    const handle = el('div', 'board-section-resize')
    handle.setAttribute('aria-label', words('aria.resize', { title: section.title }))
    node.append(title, handle)
    title.addEventListener('dblclick', (event) => { event.stopPropagation(); renameSection(section) })
    dragRect(title, section, 'move')
    dragRect(handle, section, 'resize')
    return node
  }

  const drawNote = (note: BoardNote): HTMLElement => {
    const node = el('div', `board-note board-kind-${note.kind}`)
    node.tabIndex = 0
    node.setAttribute('role', 'button')
    node.setAttribute('aria-label', words('aria.note', { kind: kindWord(words, note.kind), text: note.text }))
    node.dataset.id = note.id
    Object.assign(node.style, { left: `${note.x}px`, top: `${note.y}px`, width: `${NOTE_SIZE.width}px`, height: `${NOTE_SIZE.height}px` })
    node.append(el('span', 'board-note-kind', kindWord(words, note.kind)), el('span', 'board-note-text', note.text))
    if (note.link) node.append(el('span', 'board-note-link mono', `${note.link.kind} ${note.link.name}`))
    node.addEventListener('pointerdown', (event) => pressNote(event, note))
    node.addEventListener('dblclick', (event) => { event.stopPropagation(); editNote(note) })
    // Only keyboard focus selects: a click has already set the selection, a shift-click included.
    node.addEventListener('focus', () => {
      if (node.matches(':focus-visible') && !selection.notes.has(note.id) && !connecting) select({ notes: new Set([note.id]) })
    })
    noteNodes.set(note.id, node)
    return node
  }

  /** One pointer drag on `grip`: `move` follows it past the threshold, and `drop` names what to send when it ends. */
  const track = (grip: HTMLElement, event: PointerEvent, handlers: { move(dx: number, dy: number): void; drop(dx: number, dy: number): BoardOp[] }) => {
    const start = { x: event.clientX, y: event.clientY }
    const delta = (next: PointerEvent): [number, number] => [(next.clientX - start.x) / zoom, (next.clientY - start.y) / zoom]
    let dragged = false
    grip.setPointerCapture(event.pointerId)
    gesturing = true
    // A second finger on the same element reaches these handlers too.
    const own = (next: PointerEvent) => next.pointerId === event.pointerId
    const move = (next: PointerEvent) => {
      if (!own(next)) return
      if (!dragged && Math.hypot(next.clientX - start.x, next.clientY - start.y) < DRAG_THRESHOLD) return
      dragged = true
      handlers.move(...delta(next))
    }
    const stop = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', cancel)
      gesturing = false
    }
    const cancel = (next: PointerEvent) => {
      if (!own(next)) return
      stop()
      stale = false
      render()
    }
    const up = (next: PointerEvent) => {
      if (!own(next)) return
      stop()
      const redraw = stale
      stale = false
      if (!dragged) {
        if (redraw) render()
        return
      }
      // Redraws even when nothing is sent: a drag that snapped back still has to lose its transforms.
      if (!queue.submit(handlers.drop(...delta(next)))) render()
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', cancel)
  }

  const pressNote = (event: PointerEvent, note: BoardNote) => {
    if (event.button !== 0) return
    event.stopPropagation()
    if (connecting) {
      finishConnect(note.id)
      return
    }
    if (event.shiftKey) {
      const next = new Set(selection.notes)
      if (next.has(note.id)) next.delete(note.id)
      else next.add(note.id)
      select({ notes: next })
      return
    }
    if (!selection.notes.has(note.id)) select({ notes: new Set([note.id]) })
    const moving = view.notes.filter((candidate) => selection.notes.has(candidate.id))
    track(event.currentTarget as HTMLElement, event, {
      move: (dx, dy) => {
        for (const each of moving) {
          const node = noteNodes.get(each.id)
          if (node) node.style.transform = `translate(${dx}px, ${dy}px)`
        }
      },
      drop: (dx, dy) => {
        const moves = moving.map((each) => ({ id: each.id, ...snapNote({ x: each.x + dx, y: each.y + dy }) }))
        // A question dropped on a note becomes about it, and settles beside it rather than over it.
        const onto = moving.length === 1 && moving[0]!.kind === 'question' ? noteUnder(view, moves[0]!) : undefined
        if (onto) moves[0] = { id: moves[0]!.id, ...snapNote(besideNote(onto)) }
        const ops = dragOps(view, moves)
        if (onto) ops.push(...aboutOps(view, moving[0]!.id, onto.id))
        return ops
      },
    })
  }

  const dragRect = (grip: HTMLElement, section: BoardSection, mode: 'move' | 'resize') => {
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.stopPropagation()
      // A text selection starting on the title would cancel the pointer stream mid-drag.
      event.preventDefault()
      select({ notes: new Set(), section: section.id })
      viewport.focus({ preventScroll: true })
      const node = grip.parentElement!
      const at = (dx: number, dy: number) => mode === 'move'
        ? { x: section.x + dx, y: section.y + dy, width: section.width, height: section.height }
        : { x: section.x, y: section.y, width: Math.max(NOTE_SIZE.width, section.width + dx), height: Math.max(NOTE_SIZE.height, section.height + dy) }
      track(grip, event, {
        move: (dx, dy) => {
          const r = at(dx, dy)
          Object.assign(node.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` })
          if (mode !== 'move') return
          for (const note of view.notes) {
            const each = note.section === section.id ? noteNodes.get(note.id) : undefined
            if (each) each.style.transform = `translate(${dx}px, ${dy}px)`
          }
        },
        drop: (dx, dy) => [{ op: 'section', id: section.id, title: section.title, at: snapRect(at(dx, dy)) }],
      })
    })
  }

  /** Empty canvas: the viewport, the world, or a section's own body (its notes, title and handle take their own gestures). */
  const isBackground = (target: EventTarget | null) =>
    target === viewport || target === world || (target instanceof HTMLElement && target.classList.contains('board-section'))

  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !isBackground(event.target)) return
    if (connecting) {
      connecting = false
      say('')
    }
    select({ notes: new Set() })
    viewport.focus()
    const start = { x: event.clientX, y: event.clientY, pan: { ...pan } }
    viewport.setPointerCapture(event.pointerId)
    viewport.classList.add('board-panning')
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return
      pan = { x: start.pan.x + next.clientX - start.x, y: start.pan.y + next.clientY - start.y }
      applyView()
    }
    const up = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return
      viewport.classList.remove('board-panning')
      viewport.removeEventListener('pointermove', move)
      viewport.removeEventListener('pointerup', up)
      viewport.removeEventListener('pointercancel', up)
    }
    viewport.addEventListener('pointermove', move)
    viewport.addEventListener('pointerup', up)
    viewport.addEventListener('pointercancel', up)
  })

  viewport.addEventListener('dblclick', (event) => {
    if (!isBackground(event.target)) return
    addNote(lastKind, toWorld(event.clientX, event.clientY))
  })

  viewport.addEventListener('wheel', (event) => {
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) {
      setZoom(zoom * Math.exp(-event.deltaY / 300), toWorld(event.clientX, event.clientY))
      return
    }
    pan = { x: pan.x - event.deltaX, y: pan.y - event.deltaY }
    applyView()
  }, { passive: false })

  viewport.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      undoLast()
      return
    }
    if (event.key === 'Escape') {
      say('')
      select({ notes: new Set() })
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      removeSelected()
      return
    }
    const focusedNote = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.id : undefined
    if (connecting && (event.key === 'Enter' || event.key === ' ') && focusedNote) {
      event.preventDefault()
      finishConnect(focusedNote)
      return
    }
    const one = selection.notes.size === 1 ? view.notes.find((note) => selection.notes.has(note.id)) : undefined
    const section = selection.notes.size === 0 && selection.section ? view.sections.find((candidate) => candidate.id === selection.section) : undefined
    if (event.key === 'Enter' && one) {
      event.preventDefault()
      editNote(one)
      return
    }
    if (event.key === 'Enter' && section) {
      event.preventDefault()
      renameSection(section)
      return
    }
    if (event.key.toLowerCase() === 'c' && one && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      startConnect()
      return
    }
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key] as [number, number] | undefined
    if (delta && section) {
      event.preventDefault()
      const at = snapRect({ x: section.x + delta[0], y: section.y + delta[1], width: section.width, height: section.height })
      submit([{ op: 'section', id: section.id, title: section.title, at }])
      return
    }
    if (delta && selection.notes.size > 0) {
      event.preventDefault()
      const moves = view.notes
        .filter((note) => selection.notes.has(note.id))
        .map((note) => ({ id: note.id, ...snapNote({ x: note.x + delta[0], y: note.y + delta[1] }) }))
      submit(dragOps(view, moves))
      const focused = one ? noteNodes.get(one.id) : undefined
      focused?.focus()
    }
  })

  render()
  applyView()
  requestAnimationFrame(fit)

  return {
    replace(board, stamp) {
      const taken = queue.replace(board, stamp)
      if (taken) say(words('status.reread'))
      return taken
    },
    busy: () => queue.busy(),
    stamp: () => queue.stamp(),
  }
}
