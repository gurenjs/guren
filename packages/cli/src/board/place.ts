/**
 * Where a note or a section goes when an operation names no coordinates (RFC 0041 §2), so
 * an agent never computes one. Deterministic: the result depends on the board and the hint
 * alone. Each function works on the draft it is handed and may grow a section in it, which
 * pushes what lies below that section down by the same amount.
 */

import { BOARD_EXTENT, BOARD_MAX_SECTIONS, type Board, type BoardNote, type BoardSection } from './schema'

/** The space a note is given when placed: the page draws it smaller, with the rest as the gap. */
export const NOTE_SIZE = { width: 160, height: 96 }
const CELL = { width: 176, height: 112 }

/** The room a section keeps around its notes; the top holds its title. */
export const SECTION_INSET = { top: 40, side: 16, bottom: 16 }
const SECTION_COLUMNS = 5
const SECTION_GAP = 32
const BOARD_MARGIN = 16

export const UNSORTED_SECTION = { id: 'unsorted', title: 'Unsorted' }

export interface Placement {
  x: number
  y: number
  section?: string
}

function overlaps(note: BoardNote, x: number, y: number): boolean {
  return note.x < x + NOTE_SIZE.width && x < note.x + NOTE_SIZE.width && note.y < y + NOTE_SIZE.height && y < note.y + NOTE_SIZE.height
}

/** By its centre, so a note a person dropped across a section's edge counts as inside. */
export function liesIn(note: BoardNote, section: BoardSection): boolean {
  const x = note.x + NOTE_SIZE.width / 2
  const y = note.y + NOTE_SIZE.height / 2
  return x >= section.x && x <= section.x + section.width && y >= section.y && y <= section.y + section.height
}

/** What can take a cell of `section`: its notes, and any other note drawn inside it. What lies below is pushed down as it grows. */
function blockersIn(draft: Board, section: BoardSection, except?: BoardNote): BoardNote[] {
  return draft.notes.filter((note) => note !== except && (note.section === section.id || liesIn(note, section)))
}

function fits(x: number, y: number): boolean {
  return x + NOTE_SIZE.width <= BOARD_EXTENT && y + NOTE_SIZE.height <= BOARD_EXTENT
}

/** Grows `section` to reach `right` and `bottom`. False, with nothing changed, when the board has no room. */
function growSection(draft: Board, section: BoardSection, right: number, bottom: number): boolean {
  const oldBottom = section.y + section.height
  const down = Math.max(0, bottom - oldBottom)
  // At the board's edge the section ends there, with less room beside its last note.
  const width = Math.max(section.width, Math.min(right, BOARD_EXTENT) - section.x)

  const pushedSections = draft.sections.filter((other) => other !== section && other.y >= oldBottom)
  const pushedIds = new Set(pushedSections.map((other) => other.id))
  const pushedNotes = draft.notes.filter((note) => (note.section === undefined ? note.y >= oldBottom : pushedIds.has(note.section)))
  if (down > 0) {
    if (oldBottom + down > BOARD_EXTENT) return false
    if (pushedSections.some((other) => other.y + other.height + down > BOARD_EXTENT)) return false
    for (const other of pushedSections) other.y += down
    // A note already at the bottom edge stays there: it must not stop a section above it from growing.
    for (const note of pushedNotes) note.y = Math.max(note.y, Math.min(note.y + down, BOARD_EXTENT - NOTE_SIZE.height))
    section.height += down
  }
  section.width = width
  return true
}

/** The right and bottom edges a section needs to hold a note placed at `x`, `y`. */
function reach(x: number, y: number): [right: number, bottom: number] {
  return [x + NOTE_SIZE.width + SECTION_INSET.side, y + NOTE_SIZE.height + SECTION_INSET.bottom]
}

/** `except` is a note being moved into the section, which does not block a cell of it. */
export function placeInSection(draft: Board, section: BoardSection, except?: BoardNote): Placement | undefined {
  const members = blockersIn(draft, section, except)
  const columns = Math.max(1, Math.floor((section.width - 2 * SECTION_INSET.side) / CELL.width))
  // A note spans at most two rows of cells, so some row in this range is empty.
  for (let row = 0; row <= members.length * 2; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = section.x + SECTION_INSET.side + column * CELL.width
      const y = section.y + SECTION_INSET.top + row * CELL.height
      if (members.some((note) => overlaps(note, x, y))) continue
      if (!fits(x, y) || !growSection(draft, section, ...reach(x, y))) return undefined
      return { x, y, section: section.id }
    }
  }
  return undefined
}

function placeAfter(draft: Board, after: BoardNote): Placement | undefined {
  const section = after.section === undefined ? undefined : draft.sections.find((candidate) => candidate.id === after.section)
  const blockers = section ? blockersIn(draft, section) : draft.notes
  let x = after.x + CELL.width
  let y = after.y
  // Past the right edge a section wraps to its first free cell, and a loose note starts a row below.
  if (!fits(x, y)) {
    if (section) return placeInSection(draft, section)
    x = after.x
    y = after.y + CELL.height
  }
  while (blockers.some((note) => overlaps(note, x, y))) y += CELL.height
  if (!fits(x, y)) return undefined
  if (!section) return { x, y }
  return growSection(draft, section, ...reach(x, y)) ? { x, y, section: section.id } : undefined
}

/** A new section's rectangle: below everything on the board, wide enough for a row of notes. */
export function placeSection(draft: Board): Pick<BoardSection, 'x' | 'y' | 'width' | 'height'> | undefined {
  let bottom = 0
  for (const section of draft.sections) bottom = Math.max(bottom, section.y + section.height)
  for (const note of draft.notes) bottom = Math.max(bottom, note.y + NOTE_SIZE.height)
  const rect = {
    x: BOARD_MARGIN,
    y: bottom === 0 ? BOARD_MARGIN : bottom + SECTION_GAP,
    width: 2 * SECTION_INSET.side + SECTION_COLUMNS * CELL.width,
    height: SECTION_INSET.top + CELL.height + SECTION_INSET.bottom,
  }
  return rect.y + rect.height <= BOARD_EXTENT ? rect : undefined
}

/**
 * To the right of `after`, in its section; else the first free cell of `section`; with neither,
 * the `Unsorted` section, made on first use. Undefined when the board has no room left.
 */
export function placeNote(draft: Board, hint: { after?: BoardNote; section?: BoardSection }): Placement | undefined {
  if (hint.after) return placeAfter(draft, hint.after)
  if (hint.section) return placeInSection(draft, hint.section)

  let unsorted = draft.sections.find((section) => section.id === UNSORTED_SECTION.id)
  if (!unsorted) {
    const rect = draft.sections.length < BOARD_MAX_SECTIONS ? placeSection(draft) : undefined
    if (!rect) return undefined
    unsorted = { ...UNSORTED_SECTION, ...rect }
    draft.sections.push(unsorted)
  }
  return placeInSection(draft, unsorted)
}
