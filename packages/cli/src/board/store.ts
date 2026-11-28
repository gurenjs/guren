/**
 * Reading and writing board files (RFC 0041 §2). Every write is one read, apply and atomic
 * rename under `.guren/boards/<slug>.lock`, which holds the writer's process id. A lock
 * whose process is alive is waited on and then reported, never broken: breaking a live
 * holder's lock loses one of two writes after both reported success.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CliError, formatSchemaIssues } from '../cli-error'
import { withFileLock } from '../file-lock'
import { writeFileAtomic } from '../plan/beside'
import { applyBoardOps, type AppliedBoardOps, type BoardOp } from './ops'
import { boardFile, boardSlug, BoardSchema, compareIds, emptyBoard, isBoardSlug, serializeBoard, type Board } from './schema'
import { renderBoardOutline } from './text'

const BOARDS_DIR = 'docs/boards'
const BOARD_SUFFIX = '.board.json'

/** Git-ignored through the `.gitignore` written beside the locks. */
export const BOARD_LOCK_DIR = '.guren/boards'
const LOCK_WAIT_MS = 5000

/** Why a board could not be read or written, for a caller that answers each with its own status. */
export class BoardError extends CliError {
  constructor(
    readonly code: 'missing' | 'unreadable' | 'locked' | 'invalid',
    message: string,
  ) {
    super(message)
    this.name = 'BoardError'
  }
}

export function boardPath(appRoot: string, slug: string): string {
  return join(appRoot, boardFile(slug))
}

type BoardReading = { board: Board } | { missing: true } | { unreadable: string }

async function loadBoard(appRoot: string, slug: string): Promise<BoardReading> {
  const file = boardFile(slug)
  let raw: string
  try {
    raw = await readFile(join(appRoot, file), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true }
    return { unreadable: `${file} could not be read: ${(error as Error).message}` }
  }
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch (error) {
    return { unreadable: `${file} is not valid JSON: ${(error as Error).message}` }
  }
  const parsed = BoardSchema.safeParse(document)
  if (!parsed.success) return { unreadable: `${file} does not match the board schema:\n${formatSchemaIssues(parsed.error)}` }
  return { board: parsed.data }
}

async function requireBoard(appRoot: string, slug: string): Promise<{ board: Board }> {
  const reading = await loadBoard(appRoot, slug)
  if ('missing' in reading) throw new BoardError('missing', `No board at ${boardFile(slug)}. Create it with: guren board:new "<title>" --slug ${slug}`)
  if ('unreadable' in reading) throw new BoardError('unreadable', reading.unreadable)
  return reading
}

export async function readBoard(appRoot: string, slug: string): Promise<Board> {
  return (await requireBoard(appRoot, slug)).board
}

export interface BoardOutline {
  slug: string
  file: string
  outline: string
}

/** One board as `board:show` prints it, for a reader that has no terminal. */
export async function readBoardOutline(appRoot: string, slug: string): Promise<BoardOutline> {
  return { slug, file: boardFile(slug), outline: renderBoardOutline(await readBoard(appRoot, slug), slug) }
}

export async function createBoard(appRoot: string, options: { slug: string; title: string; locale: string }): Promise<{ file: string }> {
  const file = boardFile(options.slug)
  const parsed = BoardSchema.safeParse(emptyBoard(options.title, options.locale))
  if (!parsed.success) throw new CliError(`The board cannot be created:\n${formatSchemaIssues(parsed.error)}`)
  await mkdir(join(appRoot, BOARDS_DIR), { recursive: true })
  try {
    await writeFile(join(appRoot, file), serializeBoard(parsed.data), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError(`${file} exists. Pick another --slug, or edit it with guren board:apply.`)
    throw error
  }
  return { file }
}

async function withBoardLock<T>(appRoot: string, slug: string, waitMs: number, run: () => Promise<T>): Promise<T> {
  const lock = `${BOARD_LOCK_DIR}/${slug}.lock`
  return withFileLock(join(appRoot, BOARD_LOCK_DIR), `${boardSlug(slug)}.lock`, waitMs, run, (who) =>
    new BoardError('locked', `${boardFile(slug)} is being written by ${who} (${lock}). Try again once it has finished; if nothing is writing the board, delete ${lock}.`))
}

export interface AppliedBoardOpsFile extends AppliedBoardOps {
  file: string
  /** False when the operations left the file's bytes as they were. */
  changed: boolean
}

export async function applyBoardOpsFile(
  appRoot: string,
  slug: string,
  ops: readonly BoardOp[],
  /** Test seam: how long a held lock is waited on. */
  options: { lockWaitMs?: number } = {},
): Promise<AppliedBoardOpsFile> {
  const file = boardFile(slug)
  // Before the lock, so a mistyped slug or app root leaves no lock directory behind.
  await requireBoard(appRoot, slug)
  return withBoardLock(appRoot, slug, options.lockWaitMs ?? LOCK_WAIT_MS, async () => {
    const { board } = await requireBoard(appRoot, slug)
    const result = applyBoardOps(board, ops)
    const checked = BoardSchema.safeParse(result.board)
    if (!checked.success) throw new BoardError('invalid', `The operations would leave ${file} invalid, so nothing was written:\n${formatSchemaIssues(checked.error)}`)
    const next = serializeBoard(checked.data)
    // Against the board as read, not its bytes: a list that changes nothing never reformats a hand-edited file.
    const changed = next !== serializeBoard(board)
    if (changed) await writeFileAtomic(join(appRoot, file), next)
    return { ...result, board: checked.data, file, changed }
  })
}

export interface BoardSummary {
  slug: string
  file: string
  title?: string
  locale?: string
  notes?: number
  questions?: number
  arrows?: number
  sections?: number
  /** Why the file is not a board; the counts are absent with it. */
  unreadable?: string
}

export interface BoardOverview {
  schemaVersion: 1
  boards: BoardSummary[]
}

export async function listBoards(appRoot: string): Promise<BoardOverview> {
  let names: string[]
  try {
    names = await readdir(join(appRoot, BOARDS_DIR))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, boards: [] }
    throw new CliError(`${BOARDS_DIR} could not be read: ${(error as Error).message}`)
  }
  const slugs = names
    .filter((name) => name.endsWith(BOARD_SUFFIX))
    .map((name) => name.slice(0, -BOARD_SUFFIX.length))
    .filter(isBoardSlug)
    .sort(compareIds)

  const boards = await Promise.all(
    slugs.map(async (slug): Promise<BoardSummary> => {
      const reading = await loadBoard(appRoot, slug)
      const file = boardFile(slug)
      if ('missing' in reading) return { slug, file, unreadable: `${file} disappeared while it was being read.` }
      if ('unreadable' in reading) return { slug, file, unreadable: reading.unreadable }
      const { board } = reading
      return {
        slug,
        file,
        title: board.title,
        locale: board.locale,
        notes: board.notes.length,
        questions: board.notes.filter((note) => note.kind === 'question').length,
        arrows: board.arrows.length,
        sections: board.sections.length,
      }
    }),
  )
  return { schemaVersion: 1, boards }
}
