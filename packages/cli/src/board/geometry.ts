/**
 * The board's sizes and the rules that read them (RFC 0041 §1), with no zod: the Dev Center's
 * canvas bundles this module, and so do the schema, the applier and placement, so the page and
 * the server judge "inside a section" and "on the board" alike.
 */

import type { Board, BoardNote, BoardSection } from './schema'

export const BOARD_NOTE_KINDS = ['actor', 'view', 'command', 'aggregate', 'event', 'reaction', 'external', 'question'] as const
export type BoardNoteKind = (typeof BOARD_NOTE_KINDS)[number]

export const BOARD_MAX_NOTES = 500
export const BOARD_MAX_SECTIONS = 100
export const BOARD_MAX_ARROWS = 2000
export const NOTE_TEXT_MAX = 280
export const SECTION_TITLE_MAX = 120

/** Board units. Every stored coordinate and size is a multiple of the grid inside the extent. */
export const BOARD_GRID = 8
export const BOARD_EXTENT = 16000

export const BOARD_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/

/** The space a note is given: the page draws it at this size, and placement keeps the rest as the gap. */
export const NOTE_SIZE = { width: 160, height: 96 }

/** The room a section keeps around its notes; the top holds its title. */
export const SECTION_INSET = { top: 40, side: 16, bottom: 16 }

// U+2028 and U+2029 are no control characters, and a reader of the outline may break a line at them.
const ONE_LINE = /^[^\p{Cc}\u2028\u2029]*$/u

/** Why `text` cannot be a note's text or a section's title, or undefined when it can. */
export function lineProblem(text: string, max: number): 'empty' | 'too-long' | 'not-one-line' | undefined {
  if (text.trim() === '') return 'empty'
  if (text.length > max) return 'too-long'
  return ONE_LINE.test(text) ? undefined : 'not-one-line'
}

export function snap(value: number, max = BOARD_EXTENT): number {
  return Math.min(max, Math.max(0, Math.round(value / BOARD_GRID) * BOARD_GRID))
}

export function snapSize(value: number): number {
  return Math.max(BOARD_GRID, snap(value))
}

/** A note's corner, kept far enough from the edge for the whole note to lie on the board. */
export function snapNote(point: { x: number; y: number }): { x: number; y: number } {
  return { x: snap(point.x, BOARD_EXTENT - NOTE_SIZE.width), y: snap(point.y, BOARD_EXTENT - NOTE_SIZE.height) }
}

/** By its centre, so a note a person dropped across a section's edge counts as inside. */
export function liesIn(note: Pick<BoardNote, 'x' | 'y'>, section: Pick<BoardSection, 'x' | 'y' | 'width' | 'height'>): boolean {
  const x = note.x + NOTE_SIZE.width / 2
  const y = note.y + NOTE_SIZE.height / 2
  return x >= section.x && x <= section.x + section.width && y >= section.y && y <= section.y + section.height
}

/** The section a note dropped at its position lies in: the smallest, since sections may overlap. */
export function sectionUnder(board: Pick<Board, 'sections'>, note: Pick<BoardNote, 'x' | 'y'>): BoardSection | undefined {
  let found: BoardSection | undefined
  for (const section of board.sections) {
    if (!liesIn(note, section)) continue
    if (!found || section.width * section.height < found.width * found.height) found = section
  }
  return found
}

/** Stretches a section over the notes that belong to it: it is never smaller than they are (RFC 0041 §1). */
export function holdMembers(board: Pick<Board, 'notes'>, section: BoardSection): void {
  let left = section.x
  let top = section.y
  let right = section.x + section.width
  let bottom = section.y + section.height
  for (const note of board.notes) {
    if (note.section !== section.id) continue
    left = Math.min(left, Math.max(0, note.x - SECTION_INSET.side))
    top = Math.min(top, Math.max(0, note.y - SECTION_INSET.top))
    right = Math.max(right, Math.min(BOARD_EXTENT, note.x + NOTE_SIZE.width + SECTION_INSET.side))
    bottom = Math.max(bottom, Math.min(BOARD_EXTENT, note.y + NOTE_SIZE.height + SECTION_INSET.bottom))
  }
  Object.assign(section, { x: left, y: top, width: right - left, height: bottom - top })
}

/** Moves and resizes `section` to `rect`, carrying its notes along, then keeps it around them. */
export function placeSectionAt(board: Pick<Board, 'notes'>, section: BoardSection, rect: { x: number; y: number; width: number; height: number }): void {
  const dx = rect.x - section.x
  const dy = rect.y - section.y
  for (const note of board.notes) {
    if (note.section !== section.id) continue
    note.x = snap(note.x + dx, BOARD_EXTENT - NOTE_SIZE.width)
    note.y = snap(note.y + dy, BOARD_EXTENT - NOTE_SIZE.height)
  }
  Object.assign(section, rect)
  holdMembers(board, section)
}

export function snapRect(rect: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
  return { x: snap(rect.x), y: snap(rect.y), width: snapSize(rect.width), height: snapSize(rect.height) }
}
