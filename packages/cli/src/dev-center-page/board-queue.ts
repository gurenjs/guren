/**
 * The canvas's saving, with no DOM (RFC 0041 §2). One request is in flight at a time; edits
 * made meanwhile wait, and the view is the server's board with the waiting edits applied by
 * the same `applyBoardOps()` the server runs. Undo holds only edits the server has, or may
 * yet have: a failed save empties it with the edits it threw away.
 */

import { applyBoardOps, type DroppedBoardOp } from '../board/apply'
import { serializeBoard } from '../board/canonical'
import type { BoardOp } from '../board/ops'
import type { Board } from '../board/schema'
import { inverseOps } from './board-model'

/** The ops route's own list limit (`BOARD_MAX_OPS` in `board/ops.ts`, which imports zod). */
export const QUEUE_BATCH = 1000

export type PostResult = { ok: true; board: Board; dropped: DroppedBoardOp[] } | { ok: false; locked: boolean; reason: string }

export type QueueStatus =
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'dropped'; count: number; reason: string }
  | { kind: 'locked' }
  | { kind: 'failed'; reason: string }

export interface BoardQueue {
  view(): Board
  /** False when the edit changes nothing on the board, which is then neither sent nor recorded. */
  submit(ops: BoardOp[], options?: { record?: boolean }): boolean
  /** False when there is nothing to undo. */
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

export function createBoardQueue(
  initial: Board,
  post: (ops: BoardOp[]) => Promise<PostResult>,
  reread: () => Promise<Board>,
  events: { change(view: Board): void; status(status: QueueStatus): void },
): BoardQueue {
  let server = initial
  let inflight: BoardOp[] | undefined
  let queued: BoardOp[] = []
  const undo: BoardOp[][] = []
  let saves = 0
  let current: Promise<void> = Promise.resolve()
  let view = server

  const recompute = () => {
    view = applyBoardOps(server, [...(inflight ?? []), ...queued]).board
    events.change(view)
  }

  const flush = async (): Promise<void> => {
    if (inflight || queued.length === 0) return
    inflight = queued.splice(0, QUEUE_BATCH)
    events.status({ kind: 'saving' })
    let result: PostResult
    try {
      result = await post(inflight)
    } catch (error) {
      result = { ok: false, locked: false, reason: error instanceof Error ? error.message : 'network' }
    }
    if (result.ok) {
      server = result.board
      inflight = undefined
      saves += 1
      if (result.dropped.length) events.status({ kind: 'dropped', count: result.dropped.length, reason: result.dropped[0]!.reason })
      else if (queued.length === 0) events.status({ kind: 'saved' })
      recompute()
      return flush()
    }
    inflight = undefined
    queued = []
    // The inverses of thrown-away edits would replay against a board that never had them.
    undo.length = 0
    try { server = await reread() } catch { /* the status below already says the board was not saved */ }
    saves += 1
    events.status(result.locked ? { kind: 'locked' } : { kind: 'failed', reason: result.reason })
    recompute()
  }

  const kick = () => {
    current = current.then(flush, flush)
  }

  return {
    view: () => view,
    submit(ops, { record = true } = {}) {
      if (ops.length === 0) return false
      const before = view
      const after = applyBoardOps(before, ops).board
      if (serializeBoard(after) === serializeBoard(before)) return false
      if (record) {
        const inverse = inverseOps(before, after, ops)
        if (inverse.length) undo.push(inverse)
      }
      queued.push(...ops)
      recompute()
      kick()
      return true
    },
    undo() {
      for (let ops = undo.pop(); ops; ops = undo.pop()) {
        if (this.submit(ops, { record: false })) return true
      }
      return false
    },
    canUndo: () => undo.length > 0,
    busy: () => inflight !== undefined || queued.length > 0,
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
