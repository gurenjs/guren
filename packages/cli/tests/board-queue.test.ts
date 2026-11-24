import { describe, expect, test } from 'bun:test'

import { applyBoardOps, type BoardOp } from '../src/board/ops'
import { emptyBoard, type Board } from '../src/board/schema'
import { inverseOps } from '../src/dev-center-page/board-model'
import { createBoardQueue, QUEUE_BATCH, type PostResult, type QueueStatus } from '../src/dev-center-page/board-queue'

const NOTE = (id: string, x = 0): BoardOp => ({ op: 'add', id, kind: 'event', text: id.toUpperCase(), at: { x, y: 0 } })

/** A server that applies what it is sent, answering only when the test releases it. */
function fakeServer(initial: Board) {
  let board = initial
  const posts: BoardOp[][] = []
  const waiting: Array<() => void> = []
  let answer: (ops: BoardOp[]) => PostResult = (ops) => {
    const result = applyBoardOps(board, ops)
    board = result.board
    return { ok: true, board, dropped: result.dropped }
  }
  return {
    posts,
    board: () => board,
    setBoard: (next: Board) => { board = next },
    answerWith: (next: (ops: BoardOp[]) => PostResult) => { answer = next },
    release: () => waiting.shift()?.(),
    post: (ops: BoardOp[]) => {
      posts.push(ops)
      return new Promise<PostResult>((resolve) => waiting.push(() => resolve(answer(ops))))
    },
    reread: async () => board,
  }
}

function queueOn(server: ReturnType<typeof fakeServer>, initial: Board) {
  const statuses: QueueStatus['kind'][] = []
  const queue = createBoardQueue(initial, server.post, server.reread, { change: () => {}, status: (status) => statuses.push(status.kind) })
  return { queue, statuses }
}

/** Lets the queue's promise chain run up to the next request. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createBoardQueue', () => {
  test('should show an edit at once and send it as one request', async () => {
    const start = emptyBoard('Test', 'en')
    const server = fakeServer(start)
    const { queue } = queueOn(server, start)

    expect(queue.submit([NOTE('aa')])).toBe(true)
    expect(queue.view().notes.map((note) => note.id)).toEqual(['aa'])
    await tick()
    expect(server.posts).toEqual([[NOTE('aa')]])
    expect(queue.busy()).toBe(true)

    server.release()
    await queue.settled()
    expect(queue.busy()).toBe(false)
    expect(queue.view()).toEqual(server.board())
  })

  test('should hold edits made while a request is out and send them together next', async () => {
    const start = emptyBoard('Test', 'en')
    const server = fakeServer(start)
    const { queue } = queueOn(server, start)

    queue.submit([NOTE('aa')])
    await tick()
    queue.submit([NOTE('bb', 200)])
    queue.submit([NOTE('cc', 400)])
    expect(queue.view().notes.map((note) => note.id)).toEqual(['aa', 'bb', 'cc'])
    expect(server.posts).toHaveLength(1)

    server.release()
    await tick()
    expect(server.posts[1]).toEqual([NOTE('bb', 200), NOTE('cc', 400)])
    server.release()
    await queue.settled()
    expect(server.board().notes.map((note) => note.id)).toEqual(['aa', 'bb', 'cc'])
  })

  test('should neither send nor record an edit that changes nothing', async () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [NOTE('aa')]).board
    const server = fakeServer(start)
    const { queue } = queueOn(server, start)

    expect(queue.submit([{ op: 'move', id: 'aa', x: 0, y: 0 }])).toBe(false)
    expect(queue.submit([{ op: 'move', id: 'aa', x: 3, y: 2 }])).toBe(false)
    expect(queue.submit([])).toBe(false)
    await tick()

    expect(server.posts).toEqual([])
    expect(queue.canUndo()).toBe(false)
  })

  test('should undo the last edit by sending its inverse', async () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [NOTE('aa')]).board
    const server = fakeServer(start)
    const { queue } = queueOn(server, start)

    queue.submit([{ op: 'remove', id: 'aa' }])
    await tick()
    server.release()
    await queue.settled()
    expect(queue.undo()).toBe(true)
    await tick()
    server.release()
    await queue.settled()

    expect(server.board()).toEqual(start)
    expect(queue.undo()).toBe(false)
  })

  test('should empty the undo history, drop what it held and read the board again when a save fails', async () => {
    const start = emptyBoard('Test', 'en')
    const server = fakeServer(start)
    const { queue, statuses } = queueOn(server, start)

    queue.submit([NOTE('aa')])
    await tick()
    queue.submit([NOTE('bb', 200)])
    server.answerWith(() => ({ ok: false, locked: true, reason: 'locked' }))
    server.setBoard(applyBoardOps(start, [NOTE('agent_note', 800)]).board)
    server.release()
    await queue.settled()

    expect(statuses.at(-1)).toBe('locked')
    expect(queue.canUndo()).toBe(false)
    expect(queue.busy()).toBe(false)
    expect(queue.view().notes.map((note) => note.id)).toEqual(['agent_note'])
    expect(server.posts).toHaveLength(1)
  })

  test('should treat a thrown request as a failed save', async () => {
    const start = emptyBoard('Test', 'en')
    const statuses: QueueStatus[] = []
    const queue = createBoardQueue(start, async () => { throw new Error('offline') }, async () => start, { change: () => {}, status: (status) => statuses.push(status) })

    queue.submit([NOTE('aa')])
    await queue.settled()

    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'offline' })
    expect(queue.view().notes).toEqual([])
  })

  test('should refuse a board read before a save settled, and take one read after', async () => {
    const start = emptyBoard('Test', 'en')
    const server = fakeServer(start)
    const { queue } = queueOn(server, start)
    const before = queue.stamp()

    queue.submit([NOTE('aa')])
    await tick()
    server.release()
    await queue.settled()

    expect(queue.replace(start, before)).toBe(false)
    expect(queue.view().notes.map((note) => note.id)).toEqual(['aa'])
    const moved = applyBoardOps(server.board(), [{ op: 'move', id: 'aa', x: 800, y: 800 }]).board
    expect(queue.replace(moved, queue.stamp())).toBe(true)
    expect(queue.view().notes[0]).toMatchObject({ x: 800, y: 800 })
  })

  test('should send a long list in batches the ops route accepts', async () => {
    const start = emptyBoard('Test', 'en')
    const server = fakeServer(start)
    const { queue } = queueOn(server, start)
    const many: BoardOp[] = Array.from({ length: QUEUE_BATCH + 5 }, (_, n) => ({ op: 'section', id: `s${n}`, title: 'S', at: { x: 0, y: 0, width: 8, height: 8 } }))

    queue.submit(many)
    await tick()
    server.release()
    await tick()
    server.release()
    await queue.settled()

    expect(server.posts.map((ops) => ops.length)).toEqual([QUEUE_BATCH, 5])
  })
})

describe('inverseOps after another writer', () => {
  test('should not move a renamed section back when another writer moved it', () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [{ op: 'section', id: 'lane', title: 'Lane', at: { x: 0, y: 200, width: 400, height: 200 } }]).board
    const rename: BoardOp[] = [{ op: 'section', id: 'lane', title: 'Renamed' }]
    const renamed = applyBoardOps(start, rename).board
    const undo = inverseOps(start, renamed, rename)

    const moved = applyBoardOps(renamed, [{ op: 'section', id: 'lane', title: 'Renamed', at: { x: 0, y: 800, width: 400, height: 200 } }]).board
    const undone = applyBoardOps(moved, undo).board

    expect(undo).toEqual([{ op: 'section', id: 'lane', title: 'Lane' }])
    expect(undone.sections).toEqual([{ id: 'lane', title: 'Lane', x: 0, y: 800, width: 400, height: 200 }])
  })

  test('should put a note back where it was even when its section does not hold it', () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [
      { op: 'section', id: 'lane', title: 'Lane', at: { x: 0, y: 0, width: 400, height: 200 } },
      { op: 'add', id: 'aa', kind: 'event', text: 'A', at: { x: 32, y: 40 }, section: 'lane' },
      { op: 'move', id: 'aa', x: 2000, y: 2000 },
    ]).board
    const ops: BoardOp[] = [{ op: 'move', id: 'aa', x: 3000, y: 3000 }, { op: 'edit', id: 'aa', section: null }]
    const edited = applyBoardOps(start, ops).board
    const undone = applyBoardOps(edited, inverseOps(start, edited, ops)).board

    expect(undone.notes).toEqual(start.notes)
  })
})
