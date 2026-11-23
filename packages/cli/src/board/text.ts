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

  // A question is printed under the first note it is about; one about nothing stands in its own section.
  const questionsUnder = new Map<string, BoardNote[]>()
  const standing: BoardNote[] = []
  for (const note of board.notes) {
    const about = [...(note.about ?? [])].sort(compareIds)
    if (note.kind !== 'question' || about.length === 0) standing.push(note)
    else questionsUnder.set(about[0], [...(questionsUnder.get(about[0]) ?? []), note])
  }
  standing.sort((a, b) => (column.get(a.id) as number) - (column.get(b.id) as number) || compareIds(a.id, b.id))

  const noteLines = (note: BoardNote): string[] => {
    const own = note.kind === 'question' ? `  ? [${note.id}] ${note.text}` : `  [${note.kind} ${note.id}] ${note.text}`
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
