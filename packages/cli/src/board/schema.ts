/**
 * The board document (RFC 0041 §1): notes, arrows and sections in
 * `docs/boards/<slug>.board.json`. Coordinates only draw: every reader takes meaning from
 * ids, kinds, arrows, `section` and `about`. `serializeBoard()` is the one writer, so two
 * edits to different notes touch different lines.
 */

import { z } from 'zod'

import { CliError } from '../cli-error'
import { LocaleSchema } from '../plan/schema'

export const BOARD_VERSION = 1

export const BOARD_NOTE_KINDS = ['actor', 'view', 'command', 'aggregate', 'event', 'reaction', 'external', 'question'] as const
export type BoardNoteKind = (typeof BOARD_NOTE_KINDS)[number]

export const BOARD_LINK_KINDS = ['model', 'route', 'action', 'page', 'event', 'listener', 'job', 'mail', 'notification'] as const

export const BOARD_MAX_NOTES = 500
export const BOARD_MAX_SECTIONS = 100
export const BOARD_MAX_ARROWS = 2000

/** Board units. Every stored coordinate and size is a multiple of the grid inside the extent. */
export const BOARD_GRID = 8
export const BOARD_EXTENT = 16000

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isBoardSlug(value: string): boolean {
  return SLUG_PATTERN.test(value)
}

/** The one slug rule: a command and a route both call it before a path is built from the slug. */
export function boardSlug(value: string): string {
  if (!isBoardSlug(value)) {
    throw new CliError(`"${value}" is not a board slug: use lowercase letters, digits and dashes, starting with a letter or digit, at most 64 characters.`)
  }
  return value
}

/** A slug from an ASCII title, or undefined when the title leaves none (a Japanese title, say). */
export function deriveBoardSlug(title: string): string | undefined {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  return isBoardSlug(slug) ? slug : undefined
}

/** Relative to the app root, POSIX separators: what the commands print. */
export function boardFile(slug: string): string {
  return `docs/boards/${boardSlug(slug)}.board.json`
}

export const BOARD_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/

// `constructor` matches the pattern, and an object keyed by id would read the inherited function back.
const BoardIdSchema = z
  .string()
  .regex(BOARD_ID_PATTERN, { message: 'must be 2 to 32 characters: a lowercase letter, then lowercase letters, digits or _' })
  .refine((id) => !(id in Object.prototype), { message: 'is a name every object inherits' })

function lineOfText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    // U+2028 and U+2029 are no control characters, and a reader of the outline may break a line at them.
    .regex(/^[^\p{Cc}\u2028\u2029]*$/u, { message: 'must be one line with no control characters' })
    .refine((text) => text.trim() !== '', { message: 'must not be blank' })
}

const CoordinateSchema = z.number().int().min(0).max(BOARD_EXTENT).multipleOf(BOARD_GRID)
const SizeSchema = z.number().int().min(BOARD_GRID).max(BOARD_EXTENT).multipleOf(BOARD_GRID)

export const BoardLinkSchema = z
  .strictObject({
    kind: z.enum(BOARD_LINK_KINDS),
    name: lineOfText(200),
    module: lineOfText(64).optional(),
  })
  // A page's component path already carries its module (RFC 0041 §1).
  .refine((link) => link.kind !== 'page' || link.module === undefined, { message: 'a page link takes no module', path: ['module'] })

export const BoardNoteSchema = z.strictObject({
  id: BoardIdSchema,
  kind: z.enum(BOARD_NOTE_KINDS),
  text: lineOfText(280),
  x: CoordinateSchema,
  y: CoordinateSchema,
  section: BoardIdSchema.optional(),
  about: z.array(BoardIdSchema).optional(),
  link: BoardLinkSchema.optional(),
})

export const BoardArrowSchema = z.strictObject({
  from: BoardIdSchema,
  to: BoardIdSchema,
  kind: z.literal('async').optional(),
})

export const BoardSectionSchema = z.strictObject({
  id: BoardIdSchema,
  title: lineOfText(120),
  x: CoordinateSchema,
  y: CoordinateSchema,
  width: SizeSchema,
  height: SizeSchema,
})

export type BoardLink = z.infer<typeof BoardLinkSchema>
export type BoardNote = z.infer<typeof BoardNoteSchema>
export type BoardArrow = z.infer<typeof BoardArrowSchema>
export type BoardSection = z.infer<typeof BoardSectionSchema>

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const twice = new Set<string>()
  for (const value of values) (seen.has(value) ? twice : seen).add(value)
  return [...twice]
}

export const BoardSchema = z
  .strictObject({
    boardVersion: z.literal(BOARD_VERSION),
    title: lineOfText(120),
    locale: LocaleSchema,
    notes: z.array(BoardNoteSchema).max(BOARD_MAX_NOTES),
    arrows: z.array(BoardArrowSchema).max(BOARD_MAX_ARROWS),
    sections: z.array(BoardSectionSchema).max(BOARD_MAX_SECTIONS),
  })
  .superRefine((board, context) => {
    const issue = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message })
    const notes = new Map(board.notes.map((note) => [note.id, note]))
    const sections = new Set(board.sections.map((section) => section.id))

    for (const id of duplicates(board.notes.map((note) => note.id))) issue(['notes'], `two notes are named ${id}`)
    for (const id of duplicates(board.sections.map((section) => section.id))) issue(['sections'], `two sections are named ${id}`)
    for (const key of duplicates(board.arrows.map((arrow) => `${arrow.from} -> ${arrow.to}`))) issue(['arrows'], `the arrow ${key} is declared twice`)

    board.notes.forEach((note, index) => {
      if (note.section !== undefined && !sections.has(note.section)) issue(['notes', index, 'section'], `no section is named ${note.section}`)
      if (note.about === undefined) return
      if (note.kind !== 'question') issue(['notes', index, 'about'], 'only a question note is about other notes')
      for (const id of duplicates(note.about)) issue(['notes', index, 'about'], `${id} is listed twice`)
      for (const id of note.about) {
        if (id === note.id) issue(['notes', index, 'about'], 'a question cannot be about itself')
        else if (!notes.has(id)) issue(['notes', index, 'about'], `no note is named ${id}`)
      }
    })
    board.arrows.forEach((arrow, index) => {
      if (arrow.from === arrow.to) issue(['arrows', index], 'an arrow joins two different notes')
      for (const end of [arrow.from, arrow.to]) if (!notes.has(end)) issue(['arrows', index], `no note is named ${end}`)
    })
  })

export type Board = z.infer<typeof BoardSchema>

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
    boardVersion: BOARD_VERSION,
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

export function emptyBoard(title: string, locale: string): Board {
  return { boardVersion: BOARD_VERSION, title, locale, notes: [], arrows: [], sections: [] }
}
