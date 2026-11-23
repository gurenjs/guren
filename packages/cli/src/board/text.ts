/**
 * A board as the outline an agent reads (RFC 0041 §2). Nothing here reads a coordinate:
 * the order is the layering `plan/flow.ts` places a flow by, then the id, and every arrow
 * is spelled on the note it leaves, so a branch or a loop reads without a picture.
 */

import { layerGraph } from '../plan/flow'
import { boardFile, compareIds, type Board, type BoardArrow, type BoardNote } from './schema'

const NO_SECTION = '(no section)'

function linkText(note: BoardNote): string {
  if (!note.link) return ''
  return `  = ${note.link.kind} ${note.link.name}${note.link.module === undefined ? '' : ` (${note.link.module})`}`
}

export function renderBoardOutline(board: Board, slug: string): string {
  // Notes nothing points at come first: the walk that finds a loop's closing arrow starts from
  // them, so in `a -> b -> c -> b` the arrow marked `(back)` is `c -> b`, whatever the ids are.
  const entered = new Set(board.arrows.map((arrow) => arrow.to))
  const sorted = board.notes.map((note) => note.id).sort(compareIds)
  const ids = [...sorted.filter((id) => !entered.has(id)), ...sorted.filter((id) => entered.has(id))]
  const { edges, column, back } = layerGraph(ids, [...board.arrows].sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to)))

  const leaving = new Map<string, BoardArrow[]>()
  for (const arrow of edges) leaving.set(arrow.from, [...(leaving.get(arrow.from) ?? []), arrow])
  const arrowsText = (note: BoardNote): string => {
    const out = (leaving.get(note.id) ?? []).map((arrow) => `${arrow.kind === 'async' ? '~>' : '->'} ${arrow.to}${back.has(arrow) ? ' (back)' : ''}`)
    return out.length === 0 ? '' : `  ${out.join(', ')}`
  }

  // A question is printed under the first note it is about. One about nothing stands by itself,
  // and so does one whose first note is a question printed under another: only a note with a
  // line of its own can carry questions, or a question about a question would never be printed.
  const firstAbout = (note: BoardNote): string | undefined => (note.kind === 'question' ? [...(note.about ?? [])].sort(compareIds)[0] : undefined)
  const byId = new Map(board.notes.map((note) => [note.id, note]))
  const questionsUnder = new Map<string, BoardNote[]>()
  const standing: BoardNote[] = []
  for (const note of board.notes) {
    const target = firstAbout(note)
    const carrier = target === undefined ? undefined : byId.get(target)
    if (!carrier || firstAbout(carrier) !== undefined) standing.push(note)
    else questionsUnder.set(carrier.id, [...(questionsUnder.get(carrier.id) ?? []), note])
  }
  standing.sort((a, b) => (column.get(a.id) as number) - (column.get(b.id) as number) || compareIds(a.id, b.id))

  const noteLines = (note: BoardNote): string[] => {
    const about = note.kind === 'question' && note.about?.length ? ` (about ${[...note.about].sort(compareIds).join(', ')})` : ''
    const own = note.kind === 'question' ? `  ? [${note.id}] ${note.text}${about}` : `  [${note.kind} ${note.id}] ${note.text}`
    const questions = (questionsUnder.get(note.id) ?? []).sort((a, b) => compareIds(a.id, b.id)).map((question) => {
      const others = (question.about ?? []).filter((id) => id !== note.id).sort(compareIds)
      return `      ? [${question.id}] ${question.text}${others.length === 0 ? '' : ` (also about ${others.join(', ')})`}${arrowsText(question)}`
    })
    return [`${own}${linkText(note)}${arrowsText(note)}`, ...questions]
  }

  const lines = [`Board: ${board.title}  (${boardFile(slug)})`, '']
  if (board.notes.length === 0 && board.sections.length === 0) lines.push('(no notes)')

  const sections = [...board.sections].sort((a, b) => compareIds(a.id, b.id))
  for (const section of sections) {
    const members = standing.filter((note) => note.section === section.id)
    lines.push(`${section.title} [${section.id}]`, ...(members.length === 0 ? ['  (empty)'] : members.flatMap(noteLines)))
  }
  const loose = standing.filter((note) => note.section === undefined)
  if (loose.length > 0) lines.push(NO_SECTION, ...loose.flatMap(noteLines))

  return `${lines.join('\n')}\n`
}
