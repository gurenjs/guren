/**
 * What the board canvas sends, with no DOM (RFC 0041 §2): gestures turned into operations, and
 * the operations that undo them. Undo restores only what an edit touched, read from the board
 * before it, so an agent's edit in between is kept.
 */

import { findNote, findSection } from '../board/apply'
import { BOARD_EXTENT, BOARD_ID_PATTERN, liesIn, NOTE_SIZE, sectionUnder, type BoardRect } from '../board/geometry'
import type { BoardOp } from '../board/ops'
import type { Board, BoardArrow, BoardNote, BoardSection } from '../board/schema'

/** An arrow's identity; `>` is in no id, so the key splits back into its ends. */
export function arrowKey(arrow: Pick<BoardArrow, 'from' | 'to'>): string {
  return `${arrow.from}>${arrow.to}`
}

export function arrowEnds(key: string): { from: string; to: string } {
  const [from, to] = key.split('>') as [string, string]
  return { from, to }
}

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
  return board.notes.find((note) => note.id !== dragged.id && liesIn(dragged, { x: note.x, y: note.y, ...NOTE_SIZE }))
}

const SPOT_STEP = 24

/**
 * `at`, or the first place down and to the right of it that no note covers half of, so notes
 * added at one point (the toolbar adds at the view's centre) do not hide each other.
 */
export function freeSpot(board: Pick<Board, 'notes'>, at: { x: number; y: number }): { x: number; y: number } {
  const covered = (x: number, y: number) => board.notes.some((note) => Math.abs(note.x - x) < NOTE_SIZE.width / 2 && Math.abs(note.y - y) < NOTE_SIZE.height / 2)
  let { x, y } = at
  for (let step = 0; step < 64 && covered(x, y); step += 1) {
    x = Math.min(BOARD_EXTENT - NOTE_SIZE.width, x + SPOT_STEP)
    y = Math.min(BOARD_EXTENT - NOTE_SIZE.height, y + SPOT_STEP)
  }
  return { x, y }
}

/** Where a question dropped on `target` settles: to its right, or to its left at the board's right edge. */
export function besideNote(target: Pick<BoardNote, 'x' | 'y'>): { x: number; y: number } {
  const right = target.x + NOTE_SIZE.width + 16
  const x = right <= BOARD_EXTENT - NOTE_SIZE.width ? right : Math.max(0, target.x - NOTE_SIZE.width - 16)
  return { x, y: Math.min(target.y, BOARD_EXTENT - NOTE_SIZE.height) }
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

function sectionRect(section: BoardSection): BoardRect {
  return { x: section.x, y: section.y, width: section.width, height: section.height }
}

function touched(ops: readonly BoardOp[]): { notes: Set<string>; sections: Set<string>; arrows: Set<string> } {
  const notes = new Set<string>()
  const sections = new Set<string>()
  const arrows = new Set<string>()
  for (const op of ops) {
    if (op.op === 'connect' || op.op === 'disconnect') arrows.add(arrowKey(op))
    else if (op.op === 'section' || op.op === 'unsection') sections.add(op.id)
    else notes.add(op.id)
  }
  return { notes, sections, arrows }
}

/** `current` with what the edit took out of `was → is` put back and what it added taken out. */
function revertList(was: readonly string[], is: readonly string[], current: readonly string[]): string[] {
  const added = new Set(is.filter((id) => !was.includes(id)))
  const back = current.filter((id) => !added.has(id))
  for (const id of was) if (!is.includes(id) && !back.includes(id)) back.splice(Math.min(was.indexOf(id), back.length), 0, id)
  return back
}

/**
 * Operations that put back what `ops` changed, read from `before`, the board the user saw when
 * they made the edit, and from `now`, the board when it is undone: what the edit did not touch
 * (another writer's rename, a question's other notes) is taken from `now`. A removed note comes
 * back with its section, link, arrows and the questions that were about it; a section's notes are
 * put back where they were.
 */
export function inverseOps(before: Board, after: Board, ops: readonly BoardOp[], now: Board = after): BoardOp[] {
  const { notes, sections, arrows } = touched(ops)
  const removals: BoardOp[] = []
  const sectionsBack: BoardOp[] = []
  const notesBack: BoardOp[] = []
  const edits: BoardOp[] = []
  const links: BoardOp[] = []
  const unsections: BoardOp[] = []
  const notesOf = (board: Board) => new Map(board.notes.map((note) => [note.id, note]))
  const beforeNotes = notesOf(before)
  const afterNotes = notesOf(after)
  const nowNotes = now === after ? afterNotes : notesOf(now)
  const restored = new Set([...notes].filter((id) => beforeNotes.has(id) && !afterNotes.has(id)))
  // A question about several removed notes gets one edit, or the last would undo the others.
  const aboutBack = new Map<string, string[]>()

  for (const id of sections) {
    const was = findSection(before, id)
    const is = findSection(after, id)
    if (was && !is) {
      sectionsBack.push({ op: 'section', id, title: was.title, at: sectionRect(was) })
      for (const note of before.notes) if (note.section === id && afterNotes.has(note.id)) edits.push({ op: 'edit', id: note.id, section: id })
    } else if (!was && is) {
      unsections.push({ op: 'unsection', id })
    } else if (was && is) {
      // Each field is put back only if this edit changed it, so another writer's move or rename since stays.
      const renamed = was.title !== is.title
      const at = sameRect(was, is) ? undefined : sectionRect(was)
      if (!renamed && !at) continue
      const title = renamed ? was.title : (findSection(now, id)?.title ?? was.title)
      sectionsBack.push({ op: 'section', id, title, ...(at ? { at } : {}) })
      if (!at) continue
      for (const note of before.notes) {
        const moved = afterNotes.get(note.id)
        if (note.section === id && moved && (moved.x !== note.x || moved.y !== note.y)) edits.push({ op: 'move', id: note.id, x: note.x, y: note.y })
      }
    }
  }

  for (const id of notes) {
    const was = beforeNotes.get(id)
    const is = afterNotes.get(id)
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
        if (other.id === id || restored.has(other.id) || !other.about?.includes(id)) continue
        const current = nowNotes.get(other.id)
        if (!current) continue
        const about = aboutBack.get(other.id) ?? [...(current.about ?? [])]
        if (!about.includes(id)) about.splice(Math.min(other.about.indexOf(id), about.length), 0, id)
        aboutBack.set(other.id, about)
      }
      const about = was.about?.filter((target) => restored.has(target) || nowNotes.has(target))
      if (about?.length) edits.push({ op: 'edit', id, about })
      continue
    }
    const edit: BoardOp & { op: 'edit' } = { op: 'edit', id }
    if (is.text !== was.text) edit.text = was.text
    if (is.kind !== was.kind) edit.kind = was.kind
    if (is.section !== was.section) edit.section = was.section ?? null
    if (JSON.stringify(is.about ?? []) !== JSON.stringify(was.about ?? [])) {
      edit.about = revertList(was.about ?? [], is.about ?? [], nowNotes.get(id)?.about ?? is.about ?? []).filter((target) => nowNotes.has(target))
    }
    const moved = is.x !== was.x || is.y !== was.y
    // The move goes first, so a note whose old place lies in its old section is not placed again.
    if (moved || edit.section !== undefined) edits.push({ op: 'move', id, x: was.x, y: was.y })
    if (Object.keys(edit).length > 2) edits.push(edit)
    // Its old place outside that section: the edit placed it, and this puts it back.
    const home = typeof edit.section === 'string' ? findSection(now, edit.section) : undefined
    if (home && !liesIn(was, home)) edits.push({ op: 'move', id, x: was.x, y: was.y })
    if (JSON.stringify(is.link) !== JSON.stringify(was.link)) links.push({ op: 'link', id, link: was.link ?? null })
  }

  for (const [id, about] of aboutBack) edits.push({ op: 'edit', id, about })

  for (const key of arrows) {
    const { from, to } = arrowEnds(key)
    const was = before.arrows.find((arrow) => arrow.from === from && arrow.to === to)
    const is = after.arrows.find((arrow) => arrow.from === from && arrow.to === to)
    if (was && (!is || is.kind !== was.kind)) links.push({ op: 'connect', from, to, ...(was.kind ? { kind: was.kind } : {}) })
    else if (!was && is) links.push({ op: 'disconnect', from, to })
  }

  return [...removals, ...sectionsBack, ...notesBack, ...edits, ...links, ...unsections]
}
