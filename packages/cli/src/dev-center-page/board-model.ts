/**
 * What the board canvas sends, with no DOM (RFC 0041 §2): gestures turned into operations, and
 * the operations that undo them. Undo restores only what an edit touched, read from the board
 * before it, so an agent's edit in between is kept.
 */

import { BOARD_ID_PATTERN, NOTE_SIZE, sectionUnder } from '../board/geometry'
import type { BoardOp } from '../board/ops'
import type { Board, BoardNote, BoardSection } from '../board/schema'

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** `n_` or `s_` and eight random characters, made again until no note or section has it. */
export function newId(board: Pick<Board, 'notes' | 'sections'>, prefix: 'n' | 's', random: () => number = Math.random): string {
  const taken = new Set([...board.notes.map((note) => note.id), ...board.sections.map((section) => section.id)])
  for (;;) {
    let id = `${prefix}_`
    for (let i = 0; i < 8; i += 1) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length) % ID_ALPHABET.length]
    if (BOARD_ID_PATTERN.test(id) && !taken.has(id)) return id
  }
}

function findNote(board: Board, id: string): BoardNote | undefined {
  return board.notes.find((note) => note.id === id)
}

/**
 * Notes dragged to new places: a `move` for each, then an `edit` where the section the note now
 * lies in differs from the one it belongs to. The move comes first, or the edit would place the
 * note in its section itself.
 */
export function dragOps(board: Board, moves: ReadonlyArray<{ id: string; x: number; y: number }>): BoardOp[] {
  const ops: BoardOp[] = []
  const edits: BoardOp[] = []
  for (const move of moves) {
    const note = findNote(board, move.id)
    if (!note) continue
    ops.push({ op: 'move', id: note.id, x: move.x, y: move.y })
    const under = sectionUnder(board, move)?.id
    if (under !== note.section) edits.push({ op: 'edit', id: note.id, section: under ?? null })
  }
  return [...ops, ...edits]
}

/** The note a dragged note was dropped on: its centre inside the other's box. */
export function noteUnder(board: Board, dragged: { id: string; x: number; y: number }): BoardNote | undefined {
  const x = dragged.x + NOTE_SIZE.width / 2
  const y = dragged.y + NOTE_SIZE.height / 2
  return board.notes.find((note) => note.id !== dragged.id && x >= note.x && x <= note.x + NOTE_SIZE.width && y >= note.y && y <= note.y + NOTE_SIZE.height)
}

/** A question dropped on a note becomes about it as well (RFC 0041 §1); anything else changes nothing. */
export function aboutOps(board: Board, questionId: string, targetId: string): BoardOp[] {
  const question = findNote(board, questionId)
  if (!question || question.kind !== 'question' || question.about?.includes(targetId)) return []
  return [{ op: 'edit', id: question.id, about: [...(question.about ?? []), targetId] }]
}

function readd(note: BoardNote): BoardOp[] {
  const ops: BoardOp[] = [{ op: 'add', id: note.id, kind: note.kind, text: note.text, at: { x: note.x, y: note.y } }]
  // Naming the section may place the note in it, so its own position is set again after.
  if (note.section !== undefined) ops.push({ op: 'edit', id: note.id, section: note.section }, { op: 'move', id: note.id, x: note.x, y: note.y })
  if (note.link) ops.push({ op: 'link', id: note.id, link: note.link })
  return ops
}

function sameRect(a: BoardSection, b: BoardSection): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function sectionRect(section: BoardSection): { x: number; y: number; width: number; height: number } {
  return { x: section.x, y: section.y, width: section.width, height: section.height }
}

function touched(ops: readonly BoardOp[]): { notes: Set<string>; sections: Set<string>; arrows: Set<string> } {
  const notes = new Set<string>()
  const sections = new Set<string>()
  const arrows = new Set<string>()
  for (const op of ops) {
    if (op.op === 'connect' || op.op === 'disconnect') arrows.add(`${op.from}\u0000${op.to}`)
    else if (op.op === 'section' || op.op === 'unsection') sections.add(op.id)
    else notes.add(op.id)
  }
  return { notes, sections, arrows }
}

/**
 * Operations that put back what `ops` changed, read from `before`, the board the user saw when
 * they made the edit. A removed note comes back with its section, link, arrows and the
 * questions that were about it; a section's notes are put back where they were.
 */
export function inverseOps(before: Board, after: Board, ops: readonly BoardOp[]): BoardOp[] {
  const { notes, sections, arrows } = touched(ops)
  const removals: BoardOp[] = []
  const sectionsBack: BoardOp[] = []
  const notesBack: BoardOp[] = []
  const edits: BoardOp[] = []
  const links: BoardOp[] = []
  const unsections: BoardOp[] = []

  for (const id of sections) {
    const was = before.sections.find((section) => section.id === id)
    const is = after.sections.find((section) => section.id === id)
    if (was && !is) {
      sectionsBack.push({ op: 'section', id, title: was.title, at: sectionRect(was) })
      for (const note of before.notes) if (note.section === id && findNote(after, note.id)) edits.push({ op: 'edit', id: note.id, section: id })
    } else if (!was && is) {
      unsections.push({ op: 'unsection', id })
    } else if (was && is) {
      // A rename leaves the rectangle alone, so undoing it must not move a section another writer moved since.
      if (sameRect(was, is)) {
        if (was.title !== is.title) sectionsBack.push({ op: 'section', id, title: was.title })
        continue
      }
      sectionsBack.push({ op: 'section', id, title: was.title, at: sectionRect(was) })
      for (const note of before.notes) {
        const now = findNote(after, note.id)
        if (note.section === id && now && (now.x !== note.x || now.y !== note.y)) edits.push({ op: 'move', id: note.id, x: note.x, y: note.y })
      }
    }
  }

  for (const id of notes) {
    const was = findNote(before, id)
    const is = findNote(after, id)
    if (!was && is) {
      removals.push({ op: 'remove', id })
      continue
    }
    if (!was) continue
    if (!is) {
      notesBack.push(...readd(was))
      for (const arrow of before.arrows) {
        if (arrow.from === id || arrow.to === id) links.push({ op: 'connect', from: arrow.from, to: arrow.to, ...(arrow.kind ? { kind: arrow.kind } : {}) })
      }
      for (const other of before.notes) {
        if (other.id !== id && other.about?.includes(id) && findNote(after, other.id)) edits.push({ op: 'edit', id: other.id, about: other.about })
      }
      if (was.about?.length) edits.push({ op: 'edit', id, about: was.about })
      continue
    }
    const edit: BoardOp & { op: 'edit' } = { op: 'edit', id }
    if (is.text !== was.text) edit.text = was.text
    if (is.kind !== was.kind) edit.kind = was.kind
    if (is.section !== was.section) edit.section = was.section ?? null
    if (JSON.stringify(is.about ?? []) !== JSON.stringify(was.about ?? [])) edit.about = was.about ?? []
    if (Object.keys(edit).length > 2) edits.push(edit)
    // After the edit: naming a section may place the note, and this puts it back where it was.
    if (is.x !== was.x || is.y !== was.y || edit.section !== undefined) edits.push({ op: 'move', id, x: was.x, y: was.y })
    if (JSON.stringify(is.link) !== JSON.stringify(was.link)) links.push({ op: 'link', id, link: was.link ?? null })
  }

  for (const key of arrows) {
    const [from, to] = key.split('\u0000') as [string, string]
    const was = before.arrows.find((arrow) => arrow.from === from && arrow.to === to)
    const is = after.arrows.find((arrow) => arrow.from === from && arrow.to === to)
    if (was && (!is || is.kind !== was.kind)) links.push({ op: 'connect', from, to, ...(was.kind ? { kind: was.kind } : {}) })
    else if (!was && is) links.push({ op: 'disconnect', from, to })
  }

  return [...removals, ...sectionsBack, ...notesBack, ...edits, ...links, ...unsections]
}
