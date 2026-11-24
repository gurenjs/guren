/**
 * The canvas's saving, with no DOM (RFC 0041 §2). One request is in flight at a time; edits
 * made meanwhile wait, and the view is the server's board with the waiting edits applied by
 * the same `applyBoardOps()` the server runs. Undo holds only edits the server has, or may
 * yet have: a failed save empties it, and an edit the server dropped any part of leaves it.
 */

import { applyBoardOps, type DroppedBoardOp } from '../board/apply'
import { serializeBoard } from '../board/canonical'
import type { BoardOp } from '../board/ops'
import type { Board } from '../board/schema'
import { inverseOps } from './board-model'

/** The ops route's own list limit (`BOARD_MAX_OPS` in `board/ops.ts`, which imports zod). */
export const QUEUE_BATCH = 1000

export type PostResult = { ok: true; board: Board; dropped: DroppedBoardOp[]; outline?: string } | { ok: false; locked: boolean; reason: string }

export type QueueStatus =
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'dropped'; count: number; reason: string }
  | { kind: 'locked' }
  | { kind: 'failed'; reason: string }

export interface BoardQueue {
  view(): Board
  /**
   * False when the edit changes nothing on the board, which is then neither sent nor recorded.
   * An operation the view cannot apply is not sent, and is reported as `dropped`.
   */
  submit(ops: BoardOp[], options?: { record?: boolean }): boolean
  /** False when there is nothing to undo. An edit the server has not answered for is undone once it does. */
  undo(): boolean
  canUndo(): boolean
  busy(): boolean
  /** Changes whenever a save settles; a read started before it must not replace what the save returned. */
  stamp(): number
  /** Takes a board read from the server, unless a save settled since `stamp` was taken. */
  replace(board: Board, stamp?: number): boolean
  /** Resolves once nothing is in flight or waiting. */
  settled(): Promise<void>
}

/** One recorded edit: its inverse is read at undo time, so a change another writer made since is kept. */
interface UndoEntry {
  before: Board
  after: Board
  ops: BoardOp[]
  /** Operations the server has not answered for yet. */
  pending: number
  dropped: boolean
}

type QueuedOp = { op: BoardOp; entry?: UndoEntry }

export function createBoardQueue(
  initial: Board,
  post: (ops: BoardOp[]) => Promise<PostResult>,
  reread: () => Promise<Board>,
  events: { change(view: Board): void; status(status: QueueStatus): void; outline?(text: string): void },
): BoardQueue {
  let server = initial
  let inflight: QueuedOp[] | undefined
  let queued: QueuedOp[] = []
  const undo: UndoEntry[] = []
  // Undos asked for while their edit was unanswered, most recent edit first.
  let deferred: UndoEntry[] = []
  // Operations the view could not apply in an edit that still changed something, told once it is saved.
  let refusedLocally: { count: number; reason: string } | undefined
  let saves = 0
  let current: Promise<void> = Promise.resolve()
  let view = server

  const recompute = () => {
    view = applyBoardOps(server, [...(inflight ?? []), ...queued].map((item) => item.op)).board
    events.change(view)
  }

  const sendInverse = (entry: UndoEntry): boolean => submit(inverseOps(entry.before, entry.after, entry.ops, view), { record: false })

  const runDeferred = () => {
    while (deferred.length && deferred[0]!.pending === 0) {
      const entry = deferred.shift()!
      // An inverse that changes nothing would swallow the keypress, so it goes on to the next edit.
      if (!entry.dropped && !sendInverse(entry)) undoNext()
    }
  }

  function undoNext(): boolean {
    for (let entry = undo.pop(); entry; entry = undo.pop()) {
      // Behind a deferred undo, even an answered edit waits, so undos land in the order asked.
      if (entry.pending > 0 || deferred.length) {
        deferred.push(entry)
        return true
      }
      if (sendInverse(entry)) return true
    }
    return false
  }

  const flush = async (): Promise<void> => {
    if (inflight || queued.length === 0) return
    const batch = queued.splice(0, QUEUE_BATCH)
    inflight = batch
    events.status({ kind: 'saving' })
    let result: PostResult
    try {
      result = await post(batch.map((item) => item.op))
    } catch (error) {
      result = { ok: false, locked: false, reason: error instanceof Error ? error.message : 'network' }
    }
    if (result.ok) {
      server = result.board
      inflight = undefined
      saves += 1
      for (const item of batch) if (item.entry) item.entry.pending -= 1
      // Undoing an edit the server refused part of would undo what another writer did instead.
      for (const drop of result.dropped) {
        const entry = batch[drop.index]?.entry
        if (entry) entry.dropped = true
      }
      for (let i = undo.length - 1; i >= 0; i -= 1) if (undo[i]!.dropped) undo.splice(i, 1)
      if (result.outline !== undefined) events.outline?.(result.outline)
      if (result.dropped.length) events.status({ kind: 'dropped', count: result.dropped.length, reason: result.dropped[0]!.reason })
      else if (queued.length === 0 && refusedLocally) events.status({ kind: 'dropped', ...refusedLocally })
      else if (queued.length === 0) events.status({ kind: 'saved' })
      if (queued.length === 0) refusedLocally = undefined
      recompute()
      runDeferred()
      return flush()
    }
    inflight = undefined
    queued = []
    // The inverses of thrown-away edits would replay against a board that never had them.
    undo.length = 0
    deferred = []
    refusedLocally = undefined
    try { server = await reread() } catch { /* the status below already says the board was not saved */ }
    saves += 1
    events.status(result.locked ? { kind: 'locked' } : { kind: 'failed', reason: result.reason })
    recompute()
  }

  const kick = () => {
    current = current.then(flush, flush)
  }

  function submit(ops: BoardOp[], { record = true }: { record?: boolean } = {}): boolean {
    if (ops.length === 0) return false
    const before = view
    const applied = applyBoardOps(before, ops)
    const refusal = applied.dropped.length ? { count: applied.dropped.length, reason: applied.dropped[0]!.reason } : undefined
    if (serializeBoard(applied.board) === serializeBoard(before)) {
      if (refusal) events.status({ kind: 'dropped', ...refusal })
      return false
    }
    if (refusal) refusedLocally = refusal
    // The server would drop these as well, and the edit's undo with them.
    const refused = new Set(applied.dropped.map((drop) => drop.index))
    const sent = ops.filter((_, index) => !refused.has(index))
    const entry: UndoEntry | undefined = record ? { before, after: applied.board, ops: sent, pending: sent.length, dropped: false } : undefined
    if (entry && inverseOps(before, applied.board, sent).length) undo.push(entry)
    queued.push(...sent.map((op) => ({ op, entry })))
    recompute()
    kick()
    return true
  }

  return {
    view: () => view,
    submit,
    undo: undoNext,
    canUndo: () => undo.length > 0,
    busy: () => inflight !== undefined || queued.length > 0 || deferred.length > 0,
    stamp: () => saves,
    replace(board, stamp) {
      if (stamp !== undefined && stamp !== saves) return false
      server = board
      recompute()
      return true
    },
    settled: async () => {
      for (;;) {
        const waiting = current
        await waiting
        if (waiting === current && !inflight && queued.length === 0) return
      }
    },
  }
}
