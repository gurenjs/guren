/**
 * The operations a board is edited by (RFC 0041 §2), and the one function that applies
 * them: the canvas posts a list and `board:apply` reads one. An operation that cannot
 * apply is dropped with its reason and the rest go on. Dropping, not failing, is what lets
 * two writers send lists made against different readings of the board.
 */

import { z } from 'zod'

import { NOTE_SIZE, placeNote, placeSection, SECTION_INSET } from './place'
import {
  BOARD_EXTENT,
  BOARD_GRID,
  BOARD_MAX_ARROWS,
  BOARD_MAX_NOTES,
  BOARD_MAX_SECTIONS,
  BoardLinkSchema,
  BoardNoteSchema,
  BoardSectionSchema,
  canonicalBoard,
  type Board,
  type BoardArrow,
  type BoardNote,
  type BoardSection,
} from './schema'

const { id: IdSchema, kind: KindSchema, text: TextSchema } = BoardNoteSchema.shape

// Off-grid values are snapped on apply: a pointer position is rarely a multiple of the grid.
const UnitSchema = z.number().min(0).max(BOARD_EXTENT)
const PointSchema = z.strictObject({ x: UnitSchema, y: UnitSchema })
const RectSchema = PointSchema.extend({ width: UnitSchema, height: UnitSchema })

export const BoardOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('add'),
    id: IdSchema,
    kind: KindSchema,
    text: TextSchema,
    at: PointSchema.optional(),
    after: IdSchema.optional(),
    section: IdSchema.optional(),
    about: z.array(IdSchema).optional(),
  }),
  z.strictObject({
    op: z.literal('edit'),
    id: IdSchema,
    text: TextSchema.optional(),
    kind: KindSchema.optional(),
    section: IdSchema.nullable().optional(),
    about: z.array(IdSchema).optional(),
  }),
  z.strictObject({ op: z.literal('move'), id: IdSchema, x: UnitSchema, y: UnitSchema }),
  z.strictObject({ op: z.literal('remove'), id: IdSchema }),
  z.strictObject({ op: z.literal('connect'), from: IdSchema, to: IdSchema, kind: z.literal('async').optional() }),
  z.strictObject({ op: z.literal('disconnect'), from: IdSchema, to: IdSchema }),
  z.strictObject({ op: z.literal('link'), id: IdSchema, link: BoardLinkSchema.nullable() }),
  z.strictObject({ op: z.literal('section'), id: IdSchema, title: BoardSectionSchema.shape.title, at: RectSchema.optional() }),
  z.strictObject({ op: z.literal('unsection'), id: IdSchema }),
])

export type BoardOp = z.infer<typeof BoardOpSchema>

export const BOARD_MAX_OPS = 1000
const BoardOpListSchema = z.array(BoardOpSchema).max(BOARD_MAX_OPS)

/** What `board:apply` and the canvas send: the list, bare or under `ops`. */
export const BoardOpsDocumentSchema = z.union([BoardOpListSchema, z.strictObject({ ops: BoardOpListSchema })])

export function boardOpsOf(document: z.infer<typeof BoardOpsDocumentSchema>): BoardOp[] {
  return Array.isArray(document) ? document : document.ops
}

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

function snap(value: number, max = BOARD_EXTENT): number {
  return Math.min(max, Math.max(0, Math.round(value / BOARD_GRID) * BOARD_GRID))
}

function snapSize(value: number): number {
  return Math.max(BOARD_GRID, snap(value))
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

/** Stretches a section over the notes that belong to it: it is never smaller than they are (RFC 0041 §1). */
function holdMembers(board: Board, section: BoardSection): void {
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
      const placed = op.at
        ? { x: snap(op.at.x), y: snap(op.at.y), section: section?.id }
        : placeNote(board, after ? { after } : { section })
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
      if (typeof op.section === 'string' && !findSection(board, op.section)) return `no section is named ${op.section}`
      const kind = op.kind ?? note.kind
      const about = op.about ?? (kind === 'question' ? note.about : undefined)
      const problem = aboutProblem(board, note.id, kind, about ?? [])
      if (problem) return problem

      if (op.text !== undefined) note.text = op.text
      note.kind = kind
      setAbout(note, about)
      if (op.section === null) delete note.section
      else if (op.section !== undefined) note.section = op.section
      return undefined
    }
    case 'move': {
      const note = findNote(board, op.id)
      if (!note) return `no note is named ${op.id}`
      note.x = snap(op.x)
      note.y = snap(op.y)
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
      const rect = op.at
        ? { x: snap(op.at.x), y: snap(op.at.y), width: snapSize(op.at.width), height: snapSize(op.at.height) }
        : existing
          ? undefined
          : placeSection(board)
      if (!existing) {
        if (!rect) return 'the board has no room left for the section'
        board.sections.push({ id: op.id, title: op.title, ...rect })
        return undefined
      }
      existing.title = op.title
      if (!rect) return undefined
      // A section carries its notes with it when it moves.
      const dx = rect.x - existing.x
      const dy = rect.y - existing.y
      for (const note of board.notes) {
        if (note.section !== existing.id) continue
        note.x = snap(note.x + dx, BOARD_EXTENT - NOTE_SIZE.width)
        note.y = snap(note.y + dy, BOARD_EXTENT - NOTE_SIZE.height)
      }
      Object.assign(existing, rect)
      holdMembers(board, existing)
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
    const places = (op.op === 'add' || op.op === 'section') && op.at === undefined
    const target = places ? structuredClone(draft) : draft
    const reason = applyOne(target, op)
    if (reason === undefined) draft = target
    else dropped.push({ index, op: op.op, reason })
  })
  return { board: canonicalBoard(draft), applied: ops.length - dropped.length, dropped }
}
