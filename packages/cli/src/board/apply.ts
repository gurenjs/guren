/**
 * The one function a board is edited by (RFC 0041 §2), with no zod: `board:apply` and the Dev
 * Center route call it on the server, and the canvas calls the same one to show an edit before
 * the server answers. An operation that cannot apply is dropped with its reason and the rest go
 * on, which is what lets two writers send lists made against different readings of the board.
 */

import { canonicalBoard } from './canonical'
import { BOARD_MAX_ARROWS, BOARD_MAX_NOTES, BOARD_MAX_SECTIONS, liesIn, placeSectionAt, snapNote, snapRect } from './geometry'
import type { BoardOp } from './ops'
import { placeInSection, placeNote, placeSection, UNSORTED_SECTION } from './place'
import type { Board, BoardArrow, BoardNote, BoardSection } from './schema'

export interface DroppedBoardOp {
  /** Position in the list that was sent. */
  index: number
  op: BoardOp['op']
  reason: string
}

export interface AppliedBoardOps {
  board: Board
  applied: number
  dropped: DroppedBoardOp[]
}


function findNote(board: Board, id: string): BoardNote | undefined {
  return board.notes.find((note) => note.id === id)
}

function findSection(board: Board, id: string): BoardSection | undefined {
  return board.sections.find((section) => section.id === id)
}

/** Why `about` cannot name these notes on `id`, or undefined when it can. */
function aboutProblem(board: Board, id: string, kind: BoardNote['kind'], about: readonly string[]): string | undefined {
  if (about.length > 0 && kind !== 'question') return 'only a question note is about other notes'
  if (new Set(about).size !== about.length) return 'about lists a note twice'
  if (about.includes(id)) return 'a question cannot be about itself'
  const missing = about.find((target) => !findNote(board, target))
  return missing === undefined ? undefined : `no note is named ${missing}`
}

function setAbout(note: BoardNote, about: readonly string[] | undefined): void {
  if (about === undefined || about.length === 0) delete note.about
  else note.about = [...about]
}

/** Applies one operation to `board` in place. Returns why it was dropped, having changed nothing, or undefined. */
function applyOne(board: Board, op: BoardOp): string | undefined {
  switch (op.op) {
    case 'add': {
      if (findNote(board, op.id)) return `a note named ${op.id} exists`
      if (board.notes.length >= BOARD_MAX_NOTES) return `a board holds at most ${BOARD_MAX_NOTES} notes`
      const section = op.section === undefined ? undefined : findSection(board, op.section)
      if (op.section !== undefined && !section) return `no section is named ${op.section}`
      const named = op.after === undefined ? undefined : findNote(board, op.after)
      if (op.after !== undefined && !named) return `no note is named ${op.after}`
      const problem = aboutProblem(board, op.id, op.kind, op.about ?? [])
      if (problem) return problem

      // A question with nowhere else to go sits beside the first note it is about.
      const beside = named ?? (op.about?.[0] === undefined ? undefined : findNote(board, op.about[0]))
      // `after` places the note only inside its own section; another section named beside it wins.
      const after = beside && (!section || beside.section === section.id) ? beside : undefined
      const placed = op.at ? { ...snapNote(op.at), section: section?.id } : placeNote(board, after ? { after } : { section })
      if (!placed && !after && !section && !findSection(board, UNSORTED_SECTION.id) && board.sections.length >= BOARD_MAX_SECTIONS) {
        return `a board holds at most ${BOARD_MAX_SECTIONS} sections, so the ${UNSORTED_SECTION.title} section cannot be made for the note`
      }
      if (!placed) return 'the board has no room left for the note'
      const note: BoardNote = { id: op.id, kind: op.kind, text: op.text, x: placed.x, y: placed.y }
      if (placed.section !== undefined) note.section = placed.section
      setAbout(note, op.about)
      board.notes.push(note)
      return undefined
    }
    case 'edit': {
      const note = findNote(board, op.id)
      if (!note) return `no note is named ${op.id}`
      const section = typeof op.section === 'string' ? findSection(board, op.section) : undefined
      if (typeof op.section === 'string' && !section) return `no section is named ${op.section}`
      const kind = op.kind ?? note.kind
      const about = op.about ?? (kind === 'question' ? note.about : undefined)
      const problem = aboutProblem(board, note.id, kind, about ?? [])
      if (problem) return problem
      // The canvas moves a note into a section before it says so; an agent only names the section,
      // and the note is then placed in it. Left outside, a later resize would stretch the section to it.
      const placed = section && !liesIn(note, section) ? placeInSection(board, section, note) : undefined
      if (section && !liesIn(note, section) && !placed) return 'the board has no room left for the note'

      if (op.text !== undefined) note.text = op.text
      note.kind = kind
      setAbout(note, about)
      if (op.section === null) delete note.section
      else if (section) note.section = section.id
      if (placed) Object.assign(note, { x: placed.x, y: placed.y })
      return undefined
    }
    case 'move': {
      const note = findNote(board, op.id)
      if (!note) return `no note is named ${op.id}`
      Object.assign(note, snapNote(op))
      return undefined
    }
    case 'remove': {
      if (!findNote(board, op.id)) return `no note is named ${op.id}`
      board.notes = board.notes.filter((note) => note.id !== op.id)
      board.arrows = board.arrows.filter((arrow) => arrow.from !== op.id && arrow.to !== op.id)
      for (const note of board.notes) {
        if (note.about) setAbout(note, note.about.filter((target) => target !== op.id))
      }
      return undefined
    }
    case 'connect': {
      if (op.from === op.to) return 'an arrow joins two different notes'
      for (const end of [op.from, op.to]) if (!findNote(board, end)) return `no note is named ${end}`
      const existing = board.arrows.find((arrow) => arrow.from === op.from && arrow.to === op.to)
      if (!existing && board.arrows.length >= BOARD_MAX_ARROWS) return `a board holds at most ${BOARD_MAX_ARROWS} arrows`
      const arrow: BoardArrow = existing ?? { from: op.from, to: op.to }
      if (op.kind === undefined) delete arrow.kind
      else arrow.kind = op.kind
      if (!existing) board.arrows.push(arrow)
      return undefined
    }
    case 'disconnect': {
      const before = board.arrows.length
      board.arrows = board.arrows.filter((arrow) => arrow.from !== op.from || arrow.to !== op.to)
      return board.arrows.length === before ? `no arrow joins ${op.from} to ${op.to}` : undefined
    }
    case 'link': {
      const note = findNote(board, op.id)
      if (!note) return `no note is named ${op.id}`
      if (op.link === null) delete note.link
      else note.link = op.link
      return undefined
    }
    case 'section': {
      const existing = findSection(board, op.id)
      if (!existing && board.sections.length >= BOARD_MAX_SECTIONS) return `a board holds at most ${BOARD_MAX_SECTIONS} sections`
      const rect = op.at ? snapRect(op.at) : existing ? undefined : placeSection(board)
      if (!existing) {
        if (!rect) return 'the board has no room left for the section'
        board.sections.push({ id: op.id, title: op.title, ...rect })
        return undefined
      }
      existing.title = op.title
      if (rect) placeSectionAt(board, existing, rect)
      return undefined
    }
    case 'unsection': {
      if (!findSection(board, op.id)) return `no section is named ${op.id}`
      board.sections = board.sections.filter((section) => section.id !== op.id)
      for (const note of board.notes) if (note.section === op.id) delete note.section
      return undefined
    }
  }
}

/** Pure: `board` is not changed. The result is in canonical order. */
export function applyBoardOps(board: Board, ops: readonly BoardOp[]): AppliedBoardOps {
  let draft = structuredClone(board)
  const dropped: DroppedBoardOp[] = []
  ops.forEach((op, index) => {
    // Placement grows sections before it can fail, so a placing operation runs on a copy.
    const places = ((op.op === 'add' || op.op === 'section') && op.at === undefined) || (op.op === 'edit' && typeof op.section === 'string')
    const target = places ? structuredClone(draft) : draft
    const reason = applyOne(target, op)
    if (reason === undefined) draft = target
    else dropped.push({ index, op: op.op, reason })
  })
  return { board: canonicalBoard(draft), applied: ops.length - dropped.length, dropped }
}
