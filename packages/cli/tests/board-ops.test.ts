import { describe, expect, test } from 'bun:test'

import { applyBoardOps, BoardOpsDocumentSchema, boardOpsOf, type BoardOp } from '../src/board/ops'
import { BoardSchema, emptyBoard, serializeBoard, type Board } from '../src/board/schema'
import { renderBoardOutline } from '../src/board/text'

const LANE: BoardOp[] = [
  { op: 'section', id: 'lane', title: 'Lane' },
  { op: 'add', id: 'aa', kind: 'event', text: 'A', section: 'lane' },
  { op: 'add', id: 'bb', kind: 'event', text: 'B', after: 'aa' },
]

function lane(): Board {
  return applyBoardOps(emptyBoard('Test', 'en'), LANE).board
}

function note(board: Board, id: string) {
  return board.notes.find((candidate) => candidate.id === id)
}

function section(board: Board, id: string) {
  return board.sections.find((candidate) => candidate.id === id)
}

describe('applyBoardOps', () => {
  test('should apply a list in order so a note can be connected in the list that adds it', () => {
    const result = applyBoardOps(lane(), [
      { op: 'add', id: 'cc', kind: 'reaction', text: 'C', after: 'bb' },
      { op: 'connect', from: 'bb', to: 'cc', kind: 'async' },
    ])

    expect(result.dropped).toEqual([])
    expect(result.applied).toBe(2)
    expect(result.board.arrows).toEqual([{ from: 'bb', to: 'cc', kind: 'async' }])
    expect(BoardSchema.safeParse(result.board).success).toBe(true)
  })

  test('should drop an operation that cannot apply, report why, and apply the rest', () => {
    const result = applyBoardOps(lane(), [
      { op: 'add', id: 'aa', kind: 'actor', text: 'Again' },
      { op: 'connect', from: 'aa', to: 'nobody' },
      { op: 'edit', id: 'bb', section: 'nope' },
      { op: 'edit', id: 'bb', about: ['aa'] },
      { op: 'edit', id: 'bb', text: 'B2' },
    ])

    expect(result.applied).toBe(1)
    expect(result.dropped).toEqual([
      { index: 0, op: 'add', reason: 'a note named aa exists' },
      { index: 1, op: 'connect', reason: 'no note is named nobody' },
      { index: 2, op: 'edit', reason: 'no section is named nope' },
      { index: 3, op: 'edit', reason: 'only a question note is about other notes' },
    ])
    expect(note(result.board, 'aa')?.text).toBe('A')
    expect(note(result.board, 'bb')?.text).toBe('B2')
  })

  test('should change nothing when the same list is applied a second time', () => {
    const ops: BoardOp[] = [
      ...LANE,
      { op: 'connect', from: 'aa', to: 'bb' },
      { op: 'move', id: 'bb', x: 400, y: 56 },
      { op: 'link', id: 'aa', link: { kind: 'event', name: 'PostCreated' } },
    ]
    const first = applyBoardOps(emptyBoard('Test', 'en'), ops)
    const second = applyBoardOps(first.board, ops)

    expect(serializeBoard(second.board)).toBe(serializeBoard(first.board))
  })

  test('should not change the board it is given', () => {
    const board = lane()
    const before = serializeBoard(board)

    applyBoardOps(board, [
      { op: 'remove', id: 'aa' },
      { op: 'add', id: 'cc', kind: 'event', text: 'C' },
      { op: 'unsection', id: 'lane' },
    ])

    expect(serializeBoard(board)).toBe(before)
  })

  test('should take the arrows and the about entries with a removed note', () => {
    const board = applyBoardOps(lane(), [
      { op: 'connect', from: 'aa', to: 'bb' },
      { op: 'add', id: 'qq', kind: 'question', text: 'Why?', about: ['aa'] },
    ]).board

    const result = applyBoardOps(board, [{ op: 'remove', id: 'aa' }])

    expect(result.board.arrows).toEqual([])
    expect(note(result.board, 'qq')).not.toHaveProperty('about')
    expect(note(result.board, 'qq')?.kind).toBe('question')
  })

  test('should leave the notes where they are when their section is removed', () => {
    const board = lane()
    const result = applyBoardOps(board, [{ op: 'unsection', id: 'lane' }])

    expect(result.board.sections).toEqual([])
    expect(note(result.board, 'aa')).toEqual({ id: 'aa', kind: 'event', text: 'A', x: 32, y: 56 })
  })

  test('should set and clear a section and an about list through edit', () => {
    const board = applyBoardOps(lane(), [{ op: 'add', id: 'qq', kind: 'question', text: 'Why?', at: { x: 800, y: 800 } }]).board

    const result = applyBoardOps(board, [
      { op: 'edit', id: 'aa', section: null },
      { op: 'edit', id: 'qq', section: 'lane', about: ['bb', 'aa'] },
    ])

    expect(result.dropped).toEqual([])
    expect(note(result.board, 'aa')).not.toHaveProperty('section')
    expect(note(result.board, 'qq')).toMatchObject({ section: 'lane', about: ['aa', 'bb'] })
  })

  test('should clear about when a question becomes another kind', () => {
    const board = applyBoardOps(lane(), [{ op: 'add', id: 'qq', kind: 'question', text: 'Why?', about: ['aa'] }]).board

    const result = applyBoardOps(board, [{ op: 'edit', id: 'qq', kind: 'event' }])

    expect(note(result.board, 'qq')).not.toHaveProperty('about')
  })

  test('should update the kind of an arrow that exists instead of adding a second one', () => {
    const result = applyBoardOps(lane(), [
      { op: 'connect', from: 'aa', to: 'bb', kind: 'async' },
      { op: 'connect', from: 'aa', to: 'bb' },
    ])

    expect(result.board.arrows).toEqual([{ from: 'aa', to: 'bb' }])
  })

  test('should snap coordinates to the grid', () => {
    const result = applyBoardOps(lane(), [{ op: 'move', id: 'aa', x: 13, y: 100.4 }])

    expect(note(result.board, 'aa')).toMatchObject({ x: 16, y: 104 })
  })

  test('should carry a section\'s notes with it and keep it around them', () => {
    const result = applyBoardOps(lane(), [{ op: 'section', id: 'lane', title: 'Lane 2', at: { x: 400, y: 200, width: 8, height: 8 } }])

    expect(note(result.board, 'aa')).toMatchObject({ x: 416, y: 240 })
    expect(note(result.board, 'bb')).toMatchObject({ x: 592, y: 240 })
    expect(section(result.board, 'lane')).toEqual({ id: 'lane', title: 'Lane 2', x: 400, y: 200, width: 368, height: 152 })
  })

  test('should read the list bare or under ops', () => {
    expect(boardOpsOf(BoardOpsDocumentSchema.parse([{ op: 'remove', id: 'aa' }]))).toEqual([{ op: 'remove', id: 'aa' }])
    expect(boardOpsOf(BoardOpsDocumentSchema.parse({ ops: [{ op: 'remove', id: 'aa' }] }))).toEqual([{ op: 'remove', id: 'aa' }])
    expect(BoardOpsDocumentSchema.safeParse([{ op: 'remove', id: 'aa', extra: true }]).success).toBe(false)
    expect(BoardOpsDocumentSchema.safeParse([{ op: 'add', id: 'Bad Id', kind: 'event', text: 'x' }]).success).toBe(false)
  })
})

describe('placement', () => {
  test('should put a note to the right of the one it follows, in that note\'s section', () => {
    const board = lane()

    expect(note(board, 'aa')).toMatchObject({ x: 32, y: 56, section: 'lane' })
    expect(note(board, 'bb')).toMatchObject({ x: 208, y: 56, section: 'lane' })
  })

  test('should move down a row when the cell to the right is taken', () => {
    const result = applyBoardOps(lane(), [{ op: 'add', id: 'cc', kind: 'event', text: 'C', after: 'aa' }])

    expect(note(result.board, 'cc')).toMatchObject({ x: 208, y: 168, section: 'lane' })
    expect(section(result.board, 'lane')?.height).toBe(264)
  })

  test('should grow a section and push the one below it down by the same amount', () => {
    const adds = [1, 2, 3, 4, 5, 6].map((n): BoardOp => ({ op: 'add', id: `a${n}`, kind: 'event', text: `A${n}`, section: 'upper' }))
    const result = applyBoardOps(emptyBoard('Test', 'en'), [
      { op: 'section', id: 'upper', title: 'Upper' },
      { op: 'section', id: 'lower', title: 'Lower' },
      { op: 'add', id: 'b1', kind: 'event', text: 'B1', section: 'lower' },
      ...adds,
    ])

    expect(result.dropped).toEqual([])
    expect(section(result.board, 'upper')).toMatchObject({ y: 16, height: 264 })
    expect(section(result.board, 'lower')).toMatchObject({ y: 312, height: 168 })
    expect(note(result.board, 'a6')).toMatchObject({ x: 32, y: 168 })
    expect(note(result.board, 'b1')).toMatchObject({ x: 32, y: 352 })
  })

  test('should put a note with no hint in the Unsorted section, made on first use', () => {
    const result = applyBoardOps(lane(), [{ op: 'add', id: 'cc', kind: 'event', text: 'C' }])

    expect(section(result.board, 'unsorted')).toMatchObject({ title: 'Unsorted' })
    expect(note(result.board, 'cc')?.section).toBe('unsorted')
  })

  test('should put a question beside the first note it is about', () => {
    const result = applyBoardOps(lane(), [{ op: 'add', id: 'qq', kind: 'question', text: 'Why?', about: ['aa'] }])

    expect(note(result.board, 'qq')).toMatchObject({ x: 208, y: 168, section: 'lane' })
  })

  test('should place a note after one that has no section without giving it one', () => {
    const result = applyBoardOps(emptyBoard('Test', 'en'), [
      { op: 'add', id: 'l1', kind: 'event', text: 'L1', at: { x: 2000, y: 2000 } },
      { op: 'add', id: 'l2', kind: 'event', text: 'L2', after: 'l1' },
    ])

    expect(note(result.board, 'l2')).toEqual({ id: 'l2', kind: 'event', text: 'L2', x: 2176, y: 2000 })
  })

  test('should wrap a long chain to the next row instead of running off the board', () => {
    const id = (n: number) => `n${String(n).padStart(3, '0')}`
    const chain: BoardOp[] = [
      { op: 'section', id: 'lane', title: 'Lane' },
      { op: 'add', id: id(1), kind: 'event', text: 'N', section: 'lane' },
    ]
    for (let n = 2; n <= 100; n += 1) chain.push({ op: 'add', id: id(n), kind: 'event', text: 'N', after: id(n - 1) })

    const result = applyBoardOps(emptyBoard('Test', 'en'), chain)

    expect(result.dropped).toEqual([])
    expect(BoardSchema.safeParse(result.board).success).toBe(true)
    expect(note(result.board, id(90))).toMatchObject({ x: 15696, y: 56 })
    expect(note(result.board, id(91))).toMatchObject({ x: 32, y: 168, section: 'lane' })
  })

  test('should keep a note on the board and let a section above one at the edge still grow', () => {
    const adds = [1, 2, 3, 4, 5, 6].map((n): BoardOp => ({ op: 'add', id: `a${n}`, kind: 'event', text: 'A', section: 'lane' }))
    const result = applyBoardOps(emptyBoard('Test', 'en'), [
      { op: 'section', id: 'lane', title: 'Lane' },
      { op: 'add', id: 'zz', kind: 'event', text: 'Z', at: { x: 16000, y: 16000 } },
      ...adds,
    ])

    expect(result.dropped).toEqual([])
    expect(note(result.board, 'zz')).toMatchObject({ x: 15840, y: 15904 })
    expect(note(result.board, 'a6')).toMatchObject({ x: 32, y: 168 })
  })

  test('should place a note in the section an edit names, unless it already sits there', () => {
    const board = applyBoardOps(lane(), [{ op: 'add', id: 'cc', kind: 'event', text: 'C' }]).board

    const named = applyBoardOps(board, [{ op: 'edit', id: 'cc', section: 'lane' }])
    const dropped = applyBoardOps(board, [
      { op: 'move', id: 'cc', x: 504, y: 64 },
      { op: 'edit', id: 'cc', section: 'lane' },
    ])

    expect(note(named.board, 'cc')).toMatchObject({ x: 384, y: 56, section: 'lane' })
    expect(note(dropped.board, 'cc')).toMatchObject({ x: 504, y: 64, section: 'lane' })
  })

  test('should drop an add that would need a section past the limit, not fail the list', () => {
    const sections = Array.from({ length: 100 }, (_, n): BoardOp => ({ op: 'section', id: `s${String(n).padStart(3, '0')}`, title: 'S', at: { x: 0, y: 0, width: 80, height: 80 } }))

    const result = applyBoardOps(emptyBoard('Test', 'en'), [...sections, { op: 'add', id: 'xx', kind: 'event', text: 'X' }, { op: 'add', id: 'yy', kind: 'event', text: 'Y', at: { x: 0, y: 0 } }])

    expect(result.dropped).toEqual([{ index: 100, op: 'add', reason: 'a board holds at most 100 sections, so the Unsorted section cannot be made for the note' }])
    expect(BoardSchema.safeParse(result.board).success).toBe(true)
    expect(result.board.notes.map((candidate) => candidate.id)).toEqual(['yy'])
  })

  test('should give two adds the same outline in either order, though not the same coordinates', () => {
    const cc: BoardOp = { op: 'add', id: 'cc', kind: 'event', text: 'C' }
    const dd: BoardOp = { op: 'add', id: 'dd', kind: 'event', text: 'D' }
    const one = applyBoardOps(lane(), [cc, dd]).board
    const two = applyBoardOps(lane(), [dd, cc]).board

    expect(renderBoardOutline(one, 'test')).toBe(renderBoardOutline(two, 'test'))
    expect(serializeBoard(one)).not.toBe(serializeBoard(two))
  })
})
