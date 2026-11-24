/**
 * The board canvas (RFC 0041 §2): notes, arrows and sections drawn from the board, and every edit
 * sent as operations to the board's ops route. One request is in flight at a time; edits made
 * meanwhile wait in a queue, and the canvas shows the server's board with the waiting edits
 * applied by the same `applyBoardOps()` the server runs. Every board string is written with
 * `textContent`, since an agent or a person wrote it.
 */

import { applyBoardOps } from '../board/apply'
import { BOARD_EXTENT, BOARD_MAX_NOTES, BOARD_NOTE_KINDS, lineProblem, NOTE_SIZE, NOTE_TEXT_MAX, SECTION_TITLE_MAX, sectionUnder, snap, type BoardNoteKind } from '../board/geometry'
import type { BoardOp, DroppedBoardOp } from '../board/ops'
import type { Board, BoardArrow, BoardNote, BoardSection } from '../board/schema'
import { boardOpsPath } from '../dev-center-links'
import { el } from '../docs-viewer-page/dom'
import { borderPoint, svgEl } from '../plan/page/svg'
import { aboutOps, dragOps, inverseOps, newId, noteUnder } from './board-model'
import { boardWords, kindWord, type BoardWords } from './board-words'

const DEFAULT_SECTION = { width: 912, height: 168 }
const MIN_ZOOM = 0.2
const MAX_ZOOM = 2
const DRAG_THRESHOLD = 3

interface Saved {
  board: Board
  dropped: DroppedBoardOp[]
}

type Selection = { notes: Set<string>; section?: string; arrow?: string }

const arrowKey = (arrow: Pick<BoardArrow, 'from' | 'to'>) => `${arrow.from}>${arrow.to}`

export interface BoardCanvas {
  /** Replaces the board, as read again from the server, keeping the view and the selection. */
  replace(board: Board): void
  /** Whether edits are waiting to be saved, which a read from outside must not overwrite. */
  busy(): boolean
}

export function mountBoardCanvas(root: HTMLElement, slug: string, initial: Board, reread: () => Promise<Board>): BoardCanvas {
  const words: BoardWords = boardWords(initial.locale)
  let server = initial
  let inflight: BoardOp[] | undefined
  let queued: BoardOp[] = []
  let view = server
  const undo: BoardOp[][] = []
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
  root.replaceChildren(tools, viewport, status, el('p', 'meta', words('help')))

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


  const recompute = () => {
    view = applyBoardOps(server, [...(inflight ?? []), ...queued]).board
    for (const id of selection.notes) if (!view.notes.some((note) => note.id === id)) selection.notes.delete(id)
    if (selection.section && !view.sections.some((section) => section.id === selection.section)) selection.section = undefined
    if (selection.arrow && !view.arrows.some((arrow) => arrowKey(arrow) === selection.arrow)) selection.arrow = undefined
    if (gesturing) stale = true
    else render()
  }

  const endGesture = () => {
    gesturing = false
    if (stale) {
      stale = false
      render()
    }
  }

  const fail = async (message: string) => {
    inflight = undefined
    queued = []
    try { server = await reread() } catch { /* the message below already says the board was not saved */ }
    say(message, 'error')
    recompute()
  }

  const flush = async (): Promise<void> => {
    if (inflight || queued.length === 0) return
    inflight = queued
    queued = []
    say(words('status.saving'))
    let response: Response
    try {
      response = await fetch(boardOpsPath(slug), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops: inflight }),
        cache: 'no-store',
        redirect: 'error',
      })
    } catch (error) {
      await fail(words('status.failed', { reason: error instanceof Error ? error.message : 'network' }))
      return
    }
    const payload = (await response.json().catch(() => ({}))) as Partial<Saved> & { error?: { code?: string; message?: string } }
    if (response.status === 409 && payload.error?.code === 'locked') {
      await fail(words('status.locked'))
      return
    }
    if (!response.ok || !payload.board) {
      await fail(words('status.failed', { reason: payload.error?.message ?? `HTTP ${response.status}` }))
      return
    }
    server = payload.board
    inflight = undefined
    const dropped = payload.dropped ?? []
    if (dropped.length) say(words('status.dropped', { count: dropped.length, reason: dropped[0]!.reason }), 'warning')
    else say(words('status.saved'))
    recompute()
    void flush()
  }

  /** Records `ops` as one user edit, undoable as one, and sends it. */
  const submit = (ops: BoardOp[], { record = true } = {}) => {
    if (ops.length === 0) return
    const before = view
    const after = applyBoardOps(before, ops).board
    if (record) undo.push(inverseOps(before, after, ops))
    queued.push(...ops)
    recompute()
    void flush()
  }


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
      if (save && text !== value) {
        const problem = lineProblem(text, max)
        if (problem) {
          say(words(problem === 'empty' ? 'input.empty' : problem === 'too-long' ? 'input.tooLong' : 'input.oneLine', { max }), 'warning')
          input.focus()
          return
        }
        done = true
        input.remove()
        commit(text)
      } else {
        done = true
        input.remove()
      }
      viewport.focus()
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
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
    const at = { x: snap(point.x - NOTE_SIZE.width / 2, BOARD_EXTENT - NOTE_SIZE.width), y: snap(point.y - NOTE_SIZE.height / 2, BOARD_EXTENT - NOTE_SIZE.height) }
    ask({ ...at, width: NOTE_SIZE.width }, words('input.note', { kind: kindWord(words, kind) }), '', NOTE_TEXT_MAX, (text) => {
      const id = newId(view, 'n')
      const section = sectionUnder(view, at)?.id
      submit([{ op: 'add', id, kind, text, at, ...(section ? { section } : {}) }])
      select({ notes: new Set([id]) })
    })
  }

  const addSection = () => {
    const centre = viewportCentre()
    const at = { x: snap(centre.x - DEFAULT_SECTION.width / 2), y: snap(centre.y - DEFAULT_SECTION.height / 2) }
    ask({ ...at, width: 280 }, words('input.section'), '', SECTION_TITLE_MAX, (title) => {
      const id = newId(view, 's')
      submit([{ op: 'section', id, title, at: { ...at, ...DEFAULT_SECTION } }])
      select({ notes: new Set(), section: id })
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
    if (selection.arrow) {
      const [from, to] = selection.arrow.split('>') as [string, string]
      ops.push({ op: 'disconnect', from, to })
    }
    submit(ops)
    select({ notes: new Set() })
  }

  const toggleAsync = () => {
    const arrow = view.arrows.find((candidate) => arrowKey(candidate) === selection.arrow)
    if (!arrow) return
    submit([{ op: 'connect', from: arrow.from, to: arrow.to, ...(arrow.kind === 'async' ? {} : { kind: 'async' as const }) }])
  }

  const undoLast = () => {
    const ops = undo.pop()
    if (!ops) {
      say(words('status.nothingToUndo'))
      return
    }
    submit(ops, { record: false })
    select({ notes: new Set() })
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

  const kindButtons = BOARD_NOTE_KINDS.map((kind) => {
    const node = button(kindWord(words, kind), () => addNote(kind, viewportCentre()), `g-btn board-kind board-kind-${kind}`)
    node.title = `${words('tool.add')}: ${kindWord(words, kind)}`
    return node
  })
  const sectionButton = button(words('tool.section'), addSection)
  const connectButton = button(words('tool.connect'), startConnect)
  const asyncButton = button(words('tool.async'), toggleAsync)
  const deleteButton = button(words('tool.delete'), removeSelected)
  const undoButton = button(words('tool.undo'), undoLast)
  const zoomOut = button('−', () => setZoom(zoom / 1.25))
  zoomOut.setAttribute('aria-label', words('tool.zoomOut'))
  const zoomIn = button('+', () => setZoom(zoom * 1.25))
  zoomIn.setAttribute('aria-label', words('tool.zoomIn'))
  const fitButton = button(words('tool.fit'), fit)
  tools.append(el('span', 'board-tool-group'), sectionButton, connectButton, asyncButton, deleteButton, undoButton, zoomOut, zoomIn, fitButton)
  tools.firstElementChild!.append(...kindButtons)


  const noteNodes = new Map<string, HTMLElement>()

  const sectionNodes = new Map<string, HTMLElement>()
  const arrowNodes = new Map<string, SVGElement>()

  const render = () => {
    const active = document.activeElement
    const focusedId = active instanceof HTMLElement && noteLayer.contains(active) ? active.dataset.id : undefined
    const kinds = new Map(view.notes.map((note) => [note.id, note]))
    sectionNodes.clear()
    arrowNodes.clear()
    sectionLayer.replaceChildren(...view.sections.map(drawSection))
    noteNodes.clear()
    // Tab order follows reading order on the board, top to bottom, then left to right.
    const ordered = [...view.notes].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1))
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
    if (focusedId) noteNodes.get(focusedId)?.focus({ preventScroll: true })
    paint()
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
    const one = selection.notes.size === 1
    connectButton.disabled = !one
    connectButton.classList.toggle('board-on', connecting)
    asyncButton.disabled = selection.arrow === undefined
    const selectedArrow = view.arrows.find((candidate) => arrowKey(candidate) === selection.arrow)
    asyncButton.textContent = selectedArrow?.kind === 'async' ? words('tool.sync') : words('tool.async')
    deleteButton.disabled = selection.notes.size === 0 && !selection.section && !selection.arrow
    undoButton.disabled = undo.length === 0
    for (const node of kindButtons) node.disabled = view.notes.length >= BOARD_MAX_NOTES
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
    title.setAttribute('aria-label', words('aria.section', { title: section.title }))
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
    node.addEventListener('focus', () => {
      if (!selection.notes.has(note.id) && !connecting) select({ notes: new Set([note.id]) })
    })
    noteNodes.set(note.id, node)
    return node
  }


  const pressNote = (event: PointerEvent, note: BoardNote) => {
    if (event.button !== 0) return
    event.stopPropagation()
    if (connecting) {
      const [from] = [...selection.notes]
      if (from && from !== note.id) submit([{ op: 'connect', from, to: note.id }])
      select({ notes: new Set([note.id]) })
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
    const start = { x: event.clientX, y: event.clientY }
    let dragged = false
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    gesturing = true
    const move = (next: PointerEvent) => {
      const dx = (next.clientX - start.x) / zoom
      const dy = (next.clientY - start.y) / zoom
      if (!dragged && Math.hypot(next.clientX - start.x, next.clientY - start.y) < DRAG_THRESHOLD) return
      dragged = true
      for (const each of moving) {
        const node = noteNodes.get(each.id)
        if (node) node.style.transform = `translate(${dx}px, ${dy}px)`
      }
    }
    const up = (next: PointerEvent) => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      if (!dragged) {
        endGesture()
        return
      }
      const dx = (next.clientX - start.x) / zoom
      const dy = (next.clientY - start.y) / zoom
      const moves = moving.map((each) => ({
        id: each.id,
        x: snap(each.x + dx, BOARD_EXTENT - NOTE_SIZE.width),
        y: snap(each.y + dy, BOARD_EXTENT - NOTE_SIZE.height),
      }))
      // A question dropped on a note becomes about it, and settles beside it rather than over it.
      const onto = moving.length === 1 && moving[0]!.kind === 'question' ? noteUnder(view, moves[0]!) : undefined
      if (onto) {
        moves[0] = { id: moves[0]!.id, x: snap(onto.x + NOTE_SIZE.width + 16, BOARD_EXTENT - NOTE_SIZE.width), y: snap(onto.y, BOARD_EXTENT - NOTE_SIZE.height) }
      }
      const ops = dragOps(view, moves)
      if (onto) ops.push(...aboutOps(view, moving[0]!.id, onto.id))
      gesturing = false
      stale = false
      submit(ops)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  const dragRect = (grip: HTMLElement, section: BoardSection, mode: 'move' | 'resize') => {
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.stopPropagation()
      // A text selection starting on the title would cancel the pointer stream mid-drag.
      event.preventDefault()
      select({ notes: new Set(), section: section.id })
      const node = grip.parentElement!
      const start = { x: event.clientX, y: event.clientY }
      let dragged = false
      grip.setPointerCapture(event.pointerId)
      gesturing = true
      const at = (next: PointerEvent) => {
        const dx = (next.clientX - start.x) / zoom
        const dy = (next.clientY - start.y) / zoom
        return mode === 'move'
          ? { x: section.x + dx, y: section.y + dy, width: section.width, height: section.height }
          : { x: section.x, y: section.y, width: Math.max(NOTE_SIZE.width, section.width + dx), height: Math.max(NOTE_SIZE.height, section.height + dy) }
      }
      const move = (next: PointerEvent) => {
        if (!dragged && Math.hypot(next.clientX - start.x, next.clientY - start.y) < DRAG_THRESHOLD) return
        dragged = true
        const r = at(next)
        Object.assign(node.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` })
        if (mode === 'move') {
          for (const note of view.notes) {
            const each = note.section === section.id ? noteNodes.get(note.id) : undefined
            if (each) each.style.transform = `translate(${r.x - section.x}px, ${r.y - section.y}px)`
          }
        }
      }
      const up = (next: PointerEvent) => {
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', up)
        grip.removeEventListener('pointercancel', up)
        if (!dragged) {
          endGesture()
          return
        }
        const r = at(next)
        gesturing = false
        stale = false
        submit([{ op: 'section', id: section.id, title: section.title, at: { x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.width, height: r.height } }])
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up)
      grip.addEventListener('pointercancel', up)
    })
  }

  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.target !== viewport && event.target !== world && !(event.target instanceof SVGSVGElement))) return
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
      pan = { x: start.pan.x + next.clientX - start.x, y: start.pan.y + next.clientY - start.y }
      applyView()
    }
    const up = () => {
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
    if (event.target !== viewport && event.target !== world && !(event.target instanceof SVGSVGElement)) return
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
    const one = selection.notes.size === 1 ? view.notes.find((note) => selection.notes.has(note.id)) : undefined
    if (event.key === 'Enter' && one) {
      event.preventDefault()
      editNote(one)
      return
    }
    if (event.key.toLowerCase() === 'c' && one && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      startConnect()
      return
    }
    const step = event.shiftKey ? 40 : 8
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key] as [number, number] | undefined
    if (delta && selection.notes.size > 0) {
      event.preventDefault()
      const moves = view.notes
        .filter((note) => selection.notes.has(note.id))
        .map((note) => ({ id: note.id, x: snap(note.x + delta[0], BOARD_EXTENT - NOTE_SIZE.width), y: snap(note.y + delta[1], BOARD_EXTENT - NOTE_SIZE.height) }))
      submit(dragOps(view, moves))
      const focused = one ? noteNodes.get(one.id) : undefined
      focused?.focus()
    }
  })

  render()
  applyView()
  requestAnimationFrame(fit)

  return {
    replace(board) {
      server = board
      recompute()
      say(words('status.reread'))
    },
    busy: () => inflight !== undefined || queued.length > 0,
  }
}
