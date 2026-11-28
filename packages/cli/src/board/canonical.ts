/** The one serialization of a board (RFC 0041 §1), with no zod, so the canvas bundles it too. */

import type { Board, BoardNote } from './schema'

/** Code-unit order, so the file reads the same on every machine; `localeCompare` follows the host's locale. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function canonicalNote(note: BoardNote): BoardNote {
  return {
    id: note.id,
    kind: note.kind,
    text: note.text,
    x: note.x,
    y: note.y,
    ...(note.section === undefined ? {} : { section: note.section }),
    ...(note.about === undefined || note.about.length === 0 ? {} : { about: [...note.about].sort(compareIds) }),
    ...(note.link === undefined
      ? {}
      : { link: { kind: note.link.kind, name: note.link.name, ...(note.link.module === undefined ? {} : { module: note.link.module }) } }),
  }
}

/** Fixed key order, notes and sections by id, arrows by `from` then `to`: one board is one byte sequence. */
export function canonicalBoard(board: Board): Board {
  return {
    boardVersion: board.boardVersion,
    title: board.title,
    locale: board.locale,
    notes: board.notes.map(canonicalNote).sort((a, b) => compareIds(a.id, b.id)),
    arrows: board.arrows
      .map((arrow) => ({ from: arrow.from, to: arrow.to, ...(arrow.kind === undefined ? {} : { kind: arrow.kind }) }))
      .sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to)),
    sections: board.sections
      .map((section) => ({ id: section.id, title: section.title, x: section.x, y: section.y, width: section.width, height: section.height }))
      .sort((a, b) => compareIds(a.id, b.id)),
  }
}

export function serializeBoard(board: Board): string {
  return `${JSON.stringify(canonicalBoard(board), null, 2)}\n`
}
