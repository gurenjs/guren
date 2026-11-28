import { describe, expect, test } from 'bun:test'

import { BOARD_EXTENT, BOARD_MAX_SECTIONS, NOTE_SIZE } from '../src/board/geometry'
import { applyBoardOps, type BoardOp } from '../src/board/ops'
import { emptyBoard, type Board } from '../src/board/schema'
import { besideNote, freeSpot, inverseOps } from '../src/dev-center-page/board-model'
import { createBoardQueue, QUEUE_BATCH, UNDO_LIMIT, type PostResult, type QueueStatus } from '../src/dev-center-page/board-queue'

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
  const outlines: string[] = []
  const queue = createBoardQueue(initial, server.post, server.reread, {
    change: () => {},
    status: (status) => statuses.push(status.kind),
    outline: (text) => outlines.push(text),
  })
  return { queue, statuses, outlines }
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
    const start = applyBoardOps(emptyBoard('Test', 'en'), [NOTE('aa')]).board
    const server = fakeServer(start)
    const { queue } = queueOn(server, start)
    const many: BoardOp[] = Array.from({ length: QUEUE_BATCH + 5 }, (_, n) => ({ op: 'move', id: 'aa', x: (n + 1) * 8, y: 0 }))

    queue.submit(many)
    await tick()
    server.release()
    await tick()
    server.release()
    await queue.settled()

    expect(server.posts.map((ops) => ops.length)).toEqual([QUEUE_BATCH, 5])
  })

  test('should keep only the most recent edits for undo', async () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [NOTE('aa')]).board
    const server = fakeServer(start)
    const { queue } = queueOn(server, start)

    for (let n = 1; n <= UNDO_LIMIT + 1; n += 1) queue.submit([{ op: 'move', id: 'aa', x: n * 8, y: 0 }])
    let undone = 0
    while (queue.undo()) undone += 1

    expect(undone).toBe(UNDO_LIMIT)
  })

  test('should forget the undo of an edit the server dropped, so it cannot bring back what another writer removed', async () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [NOTE('aa')]).board
    const server = fakeServer(start)
    server.setBoard(applyBoardOps(start, [{ op: 'remove', id: 'aa' }]).board)
    const { queue, statuses } = queueOn(server, start)

    queue.submit([{ op: 'remove', id: 'aa' }])
    await tick()
    server.release()
    await queue.settled()

    expect(statuses.at(-1)).toBe('dropped')
    expect(queue.canUndo()).toBe(false)
    expect(queue.undo()).toBe(false)
    expect(server.board().notes).toEqual([])
  })

  test('should wait for the answer before undoing an edit, and undo nothing when the server dropped it', async () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [NOTE('aa')]).board
    const server = fakeServer(start)
    server.setBoard(applyBoardOps(start, [{ op: 'remove', id: 'aa' }]).board)
    const { queue } = queueOn(server, start)

    queue.submit([{ op: 'remove', id: 'aa' }])
    await tick()
    expect(queue.undo()).toBe(true)
    server.release()
    await queue.settled()

    expect(server.posts).toHaveLength(1)
    expect(server.board().notes).toEqual([])
  })

  test('should undo an edit asked for before its answer once the server has it', async () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [NOTE('aa')]).board
    const server = fakeServer(start)
    const { queue } = queueOn(server, start)

    queue.submit([{ op: 'remove', id: 'aa' }])
    await tick()
    expect(queue.undo()).toBe(true)
    expect(queue.busy()).toBe(true)
    server.release()
    await tick()
    server.release()
    await queue.settled()

    expect(server.board()).toEqual(start)
  })

  test('should neither send nor record an operation the view cannot apply, and say so', async () => {
    const full = applyBoardOps(emptyBoard('Test', 'en'), Array.from({ length: BOARD_MAX_SECTIONS }, (_, n): BoardOp => ({ op: 'section', id: `s${n}`, title: 'S', at: { x: 0, y: n * 16, width: 8, height: 8 } }))).board
    const server = fakeServer(full)
    const statuses: QueueStatus[] = []
    const queue = createBoardQueue(full, server.post, server.reread, { change: () => {}, status: (status) => statuses.push(status) })

    expect(queue.submit([{ op: 'section', id: 'extra', title: 'X', at: { x: 800, y: 0, width: 8, height: 8 } }])).toBe(false)
    expect(statuses.at(-1)?.kind).toBe('dropped')
    expect(queue.submit([NOTE('aa'), { op: 'section', id: 'extra', title: 'X', at: { x: 800, y: 0, width: 8, height: 8 } }])).toBe(true)
    await tick()
    server.release()
    await queue.settled()

    expect(server.posts).toEqual([[NOTE('aa')]])
    expect(statuses.at(-1)?.kind).toBe('dropped')
    expect(queue.canUndo()).toBe(true)
  })

  test('should keep an edit made after an undo that was waiting for its answer', async () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [NOTE('aa')]).board
    const server = fakeServer(start)
    const { queue } = queueOn(server, start)

    queue.submit([{ op: 'edit', id: 'aa', text: 'B' }])
    await tick()
    expect(queue.undo()).toBe(true)
    queue.submit([{ op: 'edit', id: 'aa', text: 'C' }])
    server.release()
    await tick()
    server.release()
    await queue.settled()

    expect(server.board().notes[0]?.text).toBe('C')
    expect(queue.canUndo()).toBe(true)
  })

  test('should not repeat a local refusal once a save the server dropped part of has reported', async () => {
    const full = applyBoardOps(emptyBoard('Test', 'en'), [
      NOTE('aa'),
      ...Array.from({ length: BOARD_MAX_SECTIONS }, (_, n): BoardOp => ({ op: 'section', id: `s${n}`, title: 'S', at: { x: 0, y: 400 + n * 16, width: 8, height: 8 } })),
    ]).board
    const server = fakeServer(full)
    server.setBoard(applyBoardOps(full, [{ op: 'remove', id: 'aa' }]).board)
    const { queue, statuses } = queueOn(server, full)

    queue.submit([{ op: 'remove', id: 'aa' }, { op: 'section', id: 'extra', title: 'X', at: { x: 800, y: 0, width: 8, height: 8 } }])
    await tick()
    server.release()
    await queue.settled()
    expect(statuses.at(-1)).toBe('dropped')

    queue.submit([NOTE('bb', 200)])
    await tick()
    server.release()
    await queue.settled()
    expect(statuses.at(-1)).toBe('saved')
  })

  test('should pass on the outline a save answers with', async () => {
    const start = emptyBoard('Test', 'en')
    const server = fakeServer(start)
    server.answerWith((ops) => {
      const result = applyBoardOps(server.board(), ops)
      server.setBoard(result.board)
      return { ok: true, board: result.board, dropped: result.dropped, outline: `notes: ${result.board.notes.length}` }
    })
    const { queue, outlines } = queueOn(server, start)

    queue.submit([NOTE('aa')])
    await tick()
    server.release()
    await queue.settled()

    expect(outlines).toEqual(['notes: 1'])
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

  test('should keep a note another writer pointed a question at when undoing a removal', () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [
      NOTE('aa'), NOTE('bb', 200), NOTE('cc', 400),
      { op: 'add', id: 'qq', kind: 'question', text: 'Q', at: { x: 0, y: 400 } },
      { op: 'edit', id: 'qq', about: ['aa', 'bb'] },
    ]).board
    const ops: BoardOp[] = [{ op: 'remove', id: 'aa' }]
    const removed = applyBoardOps(start, ops).board
    const later = applyBoardOps(removed, [{ op: 'edit', id: 'qq', about: ['bb', 'cc'] }]).board
    const undone = applyBoardOps(later, inverseOps(start, removed, ops, later)).board

    expect(undone.notes.find((note) => note.id === 'qq')?.about).toEqual(['aa', 'bb', 'cc'])
  })

  test('should keep a title another writer gave a section when undoing its move', () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [{ op: 'section', id: 'lane', title: 'Lane', at: { x: 0, y: 0, width: 400, height: 200 } }]).board
    const ops: BoardOp[] = [{ op: 'section', id: 'lane', title: 'Lane', at: { x: 0, y: 800, width: 400, height: 200 } }]
    const moved = applyBoardOps(start, ops).board
    const renamed = applyBoardOps(moved, [{ op: 'section', id: 'lane', title: 'Agent' }]).board
    const undone = applyBoardOps(renamed, inverseOps(start, moved, ops, renamed)).board

    expect(undone.sections).toEqual([{ id: 'lane', title: 'Agent', x: 0, y: 0, width: 400, height: 200 }])
  })

  test('should keep a text written after the edit being undone', () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [NOTE('aa')]).board
    const ops: BoardOp[] = [{ op: 'edit', id: 'aa', text: 'B' }]
    const edited = applyBoardOps(start, ops).board
    const later = applyBoardOps(edited, [{ op: 'edit', id: 'aa', text: 'C' }]).board

    expect(inverseOps(start, edited, ops, later)).toEqual([])
  })

  test('should leave a note where another writer moved it when undoing the removal of its section', () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [
      { op: 'section', id: 'lane', title: 'Lane', at: { x: 0, y: 0, width: 400, height: 200 } },
      { op: 'add', id: 'aa', kind: 'event', text: 'A', at: { x: 32, y: 40 }, section: 'lane' },
      { op: 'move', id: 'aa', x: 0, y: 400 },
    ]).board
    const ops: BoardOp[] = [{ op: 'unsection', id: 'lane' }]
    const removed = applyBoardOps(start, ops).board
    const undone = applyBoardOps(removed, inverseOps(start, removed, ops)).board

    expect(undone).toEqual(start)
  })

  test('should leave a note another writer added to a section where it is when undoing the section\'s move', () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [
      { op: 'section', id: 'lane', title: 'Lane', at: { x: 0, y: 0, width: 400, height: 200 } },
      { op: 'add', id: 'aa', kind: 'event', text: 'A', at: { x: 32, y: 40 }, section: 'lane' },
    ]).board
    const ops: BoardOp[] = [{ op: 'section', id: 'lane', title: 'Lane', at: { x: 400, y: 0, width: 400, height: 200 } }]
    const moved = applyBoardOps(start, ops).board
    const later = applyBoardOps(moved, [{ op: 'add', id: 'bb', kind: 'event', text: 'B', at: { x: 480, y: 40 }, section: 'lane' }]).board
    const undone = applyBoardOps(later, inverseOps(start, moved, ops, later)).board

    expect(undone.sections[0]).toMatchObject({ x: 0, y: 0 })
    expect(undone.notes.map((note) => [note.id, note.x, note.y])).toEqual([['aa', 32, 40], ['bb', 480, 40]])
  })

  test('should not bring back a section another writer removed when undoing its rename', () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [{ op: 'section', id: 'lane', title: 'Lane', at: { x: 0, y: 0, width: 400, height: 200 } }]).board
    const ops: BoardOp[] = [{ op: 'section', id: 'lane', title: 'Renamed' }]
    const renamed = applyBoardOps(start, ops).board
    const later = applyBoardOps(renamed, [{ op: 'unsection', id: 'lane' }]).board

    expect(inverseOps(start, renamed, ops, later)).toEqual([])
  })

  test('should put a note dragged out of its section back without placing it again', () => {
    const start = applyBoardOps(emptyBoard('Test', 'en'), [
      { op: 'section', id: 'lane', title: 'Lane', at: { x: 0, y: 0, width: 192, height: 152 } },
      { op: 'add', id: 'bb', kind: 'event', text: 'B', at: { x: 16, y: 40 }, section: 'lane' },
      { op: 'add', id: 'aa', kind: 'event', text: 'A', at: { x: 24, y: 56 }, section: 'lane' },
      { op: 'section', id: 'below', title: 'Below', at: { x: 0, y: 160, width: 192, height: 152 } },
    ]).board
    const ops: BoardOp[] = [{ op: 'move', id: 'aa', x: 800, y: 800 }, { op: 'edit', id: 'aa', section: null }]
    const dragged = applyBoardOps(start, ops).board
    const undone = applyBoardOps(dragged, inverseOps(start, dragged, ops)).board

    expect(undone).toEqual(start)
  })
})

describe('freeSpot', () => {
  test('should step past notes that would cover the new one', () => {
    const board = applyBoardOps(emptyBoard('Test', 'en'), [NOTE('aa', 400)]).board
    const spot = freeSpot(board, { x: 400, y: 0 })

    expect(spot).not.toEqual({ x: 400, y: 0 })
    expect(Math.abs(spot.x - 400) >= NOTE_SIZE.width / 2 || Math.abs(spot.y) >= NOTE_SIZE.height / 2).toBe(true)
    expect(freeSpot(board, { x: 1200, y: 0 })).toEqual({ x: 1200, y: 0 })
  })
})

describe('besideNote', () => {
  test('should settle to the right, or to the left at the right edge of the board', () => {
    expect(besideNote({ x: 0, y: 0 })).toEqual({ x: NOTE_SIZE.width + 16, y: 0 })
    const edge = BOARD_EXTENT - NOTE_SIZE.width
    expect(besideNote({ x: edge, y: 0 })).toEqual({ x: edge - NOTE_SIZE.width - 16, y: 0 })
  })
})
