import type { Board } from '../board/schema'
import type { BoardOverview, BoardSummary } from '../board/store'
import { boardJsonPath, boardPagePath, BOARDS_JSON_PATH } from '../dev-center-links'
import { commandRow, el } from '../docs-viewer-page/dom'
import { gurenCommandLine } from '../shell-quote'
import { mountBoardCanvas, type BoardCanvas } from './board-canvas'
import { boardWords } from './board-words'
import { card } from './dom'

export type BoardsReading = { boards: BoardSummary[] } | { unmounted: true }

/** What a `boards.json` read means: the list, or a dev server that predates the routes. */
export async function readBoards(read: (path: string) => Promise<Response> = (path) => fetch(path, { cache: 'no-store', redirect: 'error' })): Promise<BoardsReading> {
  const response = await read(BOARDS_JSON_PATH)
  if (response.status === 404) return { unmounted: true }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const overview = (await response.json()) as BoardOverview
  if (overview.schemaVersion !== 1 || !Array.isArray(overview.boards)) throw new Error('Unsupported boards payload')
  return { boards: overview.boards }
}

export function describeBoard(board: BoardSummary): string {
  if (board.unreadable !== undefined) return board.unreadable
  const count = (n: number | undefined, one: string) => `${n ?? 0} ${n === 1 ? one : `${one}s`}`
  return [count(board.notes, 'note'), count(board.questions, 'question'), count(board.arrows, 'arrow'), count(board.sections, 'section')].join(' · ')
}

function empty(title: string, body: string): HTMLElement {
  const node = el('div', 'g-empty')
  node.append(el('h3', '', title), el('p', '', body))
  return node
}

export async function loadBoards(status: HTMLElement, list: HTMLElement, button: HTMLButtonElement): Promise<void> {
  button.disabled = true
  status.textContent = 'Reading boards…'
  status.className = ''
  list.replaceChildren()
  try {
    const reading = await readBoards()
    if ('unmounted' in reading) {
      // No version is named: the release that ships the routes is not known when this is written.
      status.textContent = 'This dev server does not serve boards: its @guren/server predates them. Upgrade both @guren packages together.'
      status.className = 'warning'
      list.append(commandRow(gurenCommandLine(['upgrade'])))
      return
    }
    const { boards } = reading
    status.textContent = `${boards.length} ${boards.length === 1 ? 'board' : 'boards'}`
    if (!boards.length) {
      list.append(empty('No boards', 'A board holds the events, commands and open questions found before a plan is written.'), commandRow(gurenCommandLine(['board:new', 'Title'])))
    }
    for (const board of boards) {
      const item = el('a', 'g-card plan-card')
      item.href = boardPagePath(board.slug)
      item.append(el('span', 'kind', board.locale ?? 'board'), el('h3', 'g-card-title', board.title ?? board.slug), el('div', 'meta mono', board.file))
      item.append(el('p', board.unreadable === undefined ? 'meta' : 'warning', describeBoard(board)))
      list.append(item)
    }
  } catch (error) {
    status.textContent = `Boards unavailable: ${error instanceof Error ? error.message : 'Read failed'}. Refresh to retry.`
    status.className = 'error'
  } finally {
    button.disabled = false
  }
}

interface BoardPayload {
  schemaVersion: number
  file: string
  board: Board
  outline: string
  error?: { message: string }
}

async function readBoardPayload(slug: string): Promise<BoardPayload> {
  const response = await fetch(boardJsonPath(slug), { cache: 'no-store', redirect: 'error' })
  const payload = (await response.json()) as BoardPayload
  if (!response.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`)
  if (payload.schemaVersion !== 1 || typeof payload.outline !== 'string' || !payload.board) throw new Error('Unsupported board payload')
  return payload
}

let canvas: BoardCanvas | undefined
let watching = false

/** One board on its canvas, with the outline `guren board:show` prints folded below it. */
export async function loadBoard(slug: string, status: HTMLElement, title: HTMLElement, body: HTMLElement, button: HTMLButtonElement): Promise<void> {
  button.disabled = true
  status.textContent = 'Reading the board…'
  status.className = ''
  try {
    // A save that settles while this read is out returns a newer board than the read will.
    const stamp = canvas?.stamp()
    const payload = await readBoardPayload(slug)
    title.textContent = payload.board.title
    document.title = `${payload.board.title} · Guren Dev Center`
    status.textContent = payload.file
    if (canvas) {
      canvas.replace(payload.board, stamp ?? canvas.stamp())
    } else {
      const surface = el('div', 'board-surface')
      const outline = el('details', 'board-outline')
      outline.append(el('summary', '', boardWords(payload.board.locale)('outline')), el('pre', 'g-code', payload.outline))
      body.replaceChildren(
        surface,
        outline,
        card('Commands', el('p', 'meta', 'An agent reads and edits this board with:'), commandRow(gurenCommandLine(['board:show', slug])), commandRow(gurenCommandLine(['board:apply', slug, '--ops', 'ops.json']))),
      )
      canvas = mountBoardCanvas(surface, slug, payload.board, async () => (await readBoardPayload(slug)).board)
    }
    // An agent may have edited the file while the window was elsewhere; waiting edits are never overwritten.
    if (!watching) {
      watching = true
      window.addEventListener('focus', () => {
        if (canvas && !canvas.busy()) void loadBoard(slug, status, title, body, button)
      })
    }
    const pre = body.querySelector('.board-outline pre')
    if (pre) pre.textContent = payload.outline
  } catch (error) {
    if (!canvas) {
      title.textContent = slug
      body.replaceChildren()
    }
    status.textContent = `Board unavailable: ${error instanceof Error ? error.message : 'Read failed'}. Refresh to retry.`
    status.className = 'error'
  } finally {
    button.disabled = false
  }
}
