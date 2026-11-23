import type { BoardOverview, BoardSummary } from '../board/store'
import { boardJsonPath, boardPagePath, BOARDS_JSON_PATH } from '../dev-center-links'
import { commandRow, el } from '../docs-viewer-page/dom'
import { gurenCommandLine } from '../shell-quote'
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
  board: { title: string }
  outline: string
  error?: { message: string }
}

/** One board, as its outline until the canvas ships: the same text `guren board:show` prints. */
export async function loadBoard(slug: string, status: HTMLElement, title: HTMLElement, body: HTMLElement, button: HTMLButtonElement): Promise<void> {
  button.disabled = true
  status.textContent = 'Reading the board…'
  status.className = ''
  try {
    const response = await fetch(boardJsonPath(slug), { cache: 'no-store', redirect: 'error' })
    const payload = (await response.json()) as BoardPayload
    if (!response.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`)
    if (payload.schemaVersion !== 1 || typeof payload.outline !== 'string') throw new Error('Unsupported board payload')
    title.textContent = payload.board.title
    document.title = `${payload.board.title} · Guren Dev Center`
    status.textContent = payload.file
    body.replaceChildren(
      card('Outline', el('pre', 'g-code', payload.outline)),
      card('Commands', el('p', 'meta', 'An agent reads and edits this board with:'), commandRow(gurenCommandLine(['board:show', slug])), commandRow(gurenCommandLine(['board:apply', slug, '--ops', 'ops.json']))),
    )
  } catch (error) {
    title.textContent = slug
    body.replaceChildren()
    status.textContent = `Board unavailable: ${error instanceof Error ? error.message : 'Read failed'}. Refresh to retry.`
    status.className = 'error'
  } finally {
    button.disabled = false
  }
}
