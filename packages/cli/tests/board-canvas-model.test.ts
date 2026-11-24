import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { applyBoardOps, type BoardOp } from '../src/board/ops'
import { emptyBoard, serializeBoard, type Board } from '../src/board/schema'
import { aboutOps, dragOps, inverseOps, newId, noteUnder } from '../src/dev-center-page/board-model'
import { BOARD_WORDS, boardWords } from '../src/dev-center-page/board-words'

function board(ops: BoardOp[]): Board {
  return applyBoardOps(emptyBoard('Test', 'en'), ops).board
}

const LANE: BoardOp[] = [
  { op: 'section', id: 'lane', title: 'Lane', at: { x: 0, y: 0, width: 912, height: 168 } },
  { op: 'add', id: 'aa', kind: 'event', text: 'A', at: { x: 32, y: 40 }, section: 'lane' },
  { op: 'add', id: 'bb', kind: 'reaction', text: 'B', at: { x: 208, y: 40 }, section: 'lane' },
  { op: 'add', id: 'qq', kind: 'question', text: 'Why?', at: { x: 400, y: 400 }, about: ['aa'] },
  { op: 'connect', from: 'aa', to: 'bb', kind: 'async' },
  { op: 'link', id: 'aa', link: { kind: 'event', name: 'PostCreated' } },
]

/** Applies `ops` as the canvas would, then their inverse, and returns the board before and after the round trip. */
function roundTrip(start: Board, ops: BoardOp[]): { before: string; after: string } {
  const edited = applyBoardOps(start, ops).board
  const undone = applyBoardOps(edited, inverseOps(start, edited, ops)).board
  return { before: serializeBoard(start), after: serializeBoard(undone) }
}

describe('newId', () => {
  test('should make an id the schema accepts that no note or section has', () => {
    const values = [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
    let at = 0
    const taken = board([{ op: 'add', id: 'n_aaaaaaaa', kind: 'event', text: 'A', at: { x: 0, y: 0 } }])

    const id = newId(taken, 'n', () => values[at++ % values.length]!)

    expect(id).toBe('n_ssssssss')
    expect(newId(taken, 's')).toMatch(/^s_[a-z0-9]{8}$/)
  })
})

describe('dragOps', () => {
  test('should move each note, then name the section it now lies in, the move first', () => {
    const start = board(LANE)

    const ops = dragOps(start, [
      { id: 'aa', x: 600, y: 600 },
      { id: 'qq', x: 600, y: 40 },
    ])

    expect(ops).toEqual([
      { op: 'move', id: 'aa', x: 600, y: 600 },
      { op: 'move', id: 'qq', x: 600, y: 40 },
      { op: 'edit', id: 'aa', section: null },
      { op: 'edit', id: 'qq', section: 'lane' },
    ])
    const after = applyBoardOps(start, ops).board
    expect(after.notes.find((note) => note.id === 'qq')).toMatchObject({ x: 600, y: 40, section: 'lane' })
  })

  test('should send no edit for a note that stays in its section', () => {
    expect(dragOps(board(LANE), [{ id: 'bb', x: 400, y: 48 }])).toEqual([{ op: 'move', id: 'bb', x: 400, y: 48 }])
  })
})

describe('aboutOps', () => {
  test('should add the note a question is dropped on to what it is about, once', () => {
    const start = board(LANE)

    expect(noteUnder(start, { id: 'qq', x: 220, y: 60 })?.id).toBe('bb')
    expect(aboutOps(start, 'qq', 'bb')).toEqual([{ op: 'edit', id: 'qq', about: ['aa', 'bb'] }])
    expect(aboutOps(start, 'qq', 'aa')).toEqual([])
    expect(aboutOps(start, 'bb', 'aa')).toEqual([])
  })
})

describe('inverseOps', () => {
  test('should bring a removed note back with its section, link, arrows and the questions about it', () => {
    const { before, after } = roundTrip(board(LANE), [{ op: 'remove', id: 'aa' }])

    expect(after).toBe(before)
  })

  test('should take back an added note, a move, a text edit, a kind change and an arrow', () => {
    const start = board(LANE)

    for (const ops of [
      [{ op: 'add', id: 'cc', kind: 'event', text: 'C', at: { x: 600, y: 40 }, section: 'lane' }],
      dragOps(start, [{ id: 'aa', x: 600, y: 600 }]),
      [{ op: 'edit', id: 'bb', text: 'B2', kind: 'external' }],
      [{ op: 'connect', from: 'bb', to: 'aa' }],
      [{ op: 'connect', from: 'aa', to: 'bb' }],
      [{ op: 'disconnect', from: 'aa', to: 'bb' }],
      [{ op: 'edit', id: 'qq', about: ['aa', 'bb'] }],
      [{ op: 'link', id: 'aa', link: null }],
    ] as BoardOp[][]) {
      const { before, after } = roundTrip(start, ops)
      expect(after, JSON.stringify(ops)).toBe(before)
    }
  })

  test('should put a moved or removed section back with its notes where they were', () => {
    const start = board(LANE)

    for (const ops of [
      [{ op: 'section', id: 'lane', title: 'Moved', at: { x: 400, y: 800, width: 912, height: 168 } }],
      [{ op: 'unsection', id: 'lane' }],
      [{ op: 'section', id: 'fresh', title: 'Fresh', at: { x: 0, y: 1200, width: 400, height: 200 } }],
    ] as BoardOp[][]) {
      const { before, after } = roundTrip(start, ops)
      expect(after, JSON.stringify(ops)).toBe(before)
    }
  })

  test('should leave an edit another writer made in between', () => {
    const start = board(LANE)
    const mine: BoardOp[] = [{ op: 'remove', id: 'bb' }]
    const edited = applyBoardOps(start, mine).board
    const undo = inverseOps(start, edited, mine)

    const theirs = applyBoardOps(edited, [{ op: 'add', id: 'agent_note', kind: 'event', text: 'From an agent', at: { x: 800, y: 800 } }]).board
    const undone = applyBoardOps(theirs, undo).board

    expect(undone.notes.map((note) => note.id)).toEqual(['aa', 'agent_note', 'bb', 'qq'])
    expect(undone.arrows).toEqual([{ from: 'aa', to: 'bb', kind: 'async' }])
  })
})

describe('board words', () => {
  test('should hold the same keys and placeholders in both tables', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

    expect(Object.keys(BOARD_WORDS.ja).sort()).toEqual(Object.keys(BOARD_WORDS.en).sort())
    for (const key of Object.keys(BOARD_WORDS.en) as Array<keyof typeof BOARD_WORDS.en>) {
      expect(placeholders(BOARD_WORDS.ja[key]), key).toEqual(placeholders(BOARD_WORDS.en[key]))
    }
  })

  test('should read Japanese for a ja board and English for any other, filling the placeholders', () => {
    expect(boardWords('ja-JP')('status.full', { max: 500 })).toBe('ボードに置ける付箋は 500 枚までです。')
    expect(boardWords('fr')('status.full', { max: 500 })).toBe('A board holds at most 500 notes.')
    expect(boardWords(undefined)('kind.reaction')).toBe('Reaction')
  })
})

describe('the canvas bundle', () => {
  test('should carry the applier without zod, which the schema modules import', async () => {
    const output = await Bun.build({ entrypoints: [join(import.meta.dir, '../src/dev-center-page/board-canvas.ts')], target: 'browser' })
    const text = await output.outputs[0]!.text()

    expect(output.success).toBe(true)
    expect(text).toContain('placeInSection')
    expect(text).not.toMatch(/ZodObject|\$ZodType/)
  })
})
