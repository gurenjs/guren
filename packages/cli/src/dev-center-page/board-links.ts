/**
 * What `board:status` reported, read for the canvas (RFC 0041 §3), with no DOM: per note, the state
 * of the link it carried when the report was made. A note whose link changed since is not drawn,
 * since the report judged another link.
 */

import type { BoardLink, BoardNote } from '../board/schema'
import type { BoardNoteState, BoardStatusReport } from '../board/status'

export type LinkState = Exclude<BoardNoteState, 'unlinked'>

export const LINK_STATES: readonly LinkState[] = ['present', 'planned', 'missing', 'unknown']

export interface NoteLinkState {
  state: LinkState
  link: string
  /** The plans adding the element (`planned`) or why no reading settled it (`unknown`). */
  plannedIn?: string[]
  reason?: string
}

export type LinkReading =
  | { kind: 'checking' }
  | { kind: 'ready'; report: BoardStatusReport }
  | { kind: 'unavailable'; message: string }

export function linkKey(link: BoardLink): string {
  return `${link.kind} ${link.module ?? ''} ${link.name}`
}

export function noteLinkStates(report: BoardStatusReport): Map<string, NoteLinkState> {
  const states = new Map<string, NoteLinkState>()
  for (const note of report.notes) {
    if (!note.link || note.state === 'unlinked') continue
    states.set(note.id, {
      state: note.state,
      link: linkKey(note.link),
      ...(note.plannedIn ? { plannedIn: note.plannedIn } : {}),
      ...(note.reason !== undefined ? { reason: note.reason } : {}),
    })
  }
  return states
}

/** The state to draw on `note`, only while it carries the link the report judged. */
export function linkStateOf(note: BoardNote, states: ReadonlyMap<string, NoteLinkState>): NoteLinkState | undefined {
  const judged = states.get(note.id)
  return note.link && judged?.link === linkKey(note.link) ? judged : undefined
}

export interface LinkCounts {
  present: number
  planned: number
  missing: number
  unknown: number
  leadNowhere: number
}

export function linkCounts(report: BoardStatusReport): LinkCounts {
  const counts: LinkCounts = { present: 0, planned: 0, missing: 0, unknown: 0, leadNowhere: report.leadsNowhere.length }
  for (const note of report.notes) if (note.state !== 'unlinked') counts[note.state] += 1
  return counts
}
