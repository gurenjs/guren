import { describe, expect, test } from 'bun:test'

import { CliError } from '../src/cli-error'
import { boardFile, BoardSchema, boardSlug, deriveBoardSlug, emptyBoard, isBoardSlug, serializeBoard, type Board } from '../src/board/schema'

function board(overrides: Partial<Board> = {}): Board {
  return {
    ...emptyBoard('Test', 'en'),
    notes: [
      { id: 'bb', kind: 'event', text: 'B', x: 208, y: 56 },
      { id: 'aa', kind: 'command', text: 'A', x: 32, y: 56 },
    ],
    ...overrides,
  }
}

function issues(candidate: unknown): string {
  const parsed = BoardSchema.safeParse(candidate)
  return parsed.success ? '' : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
}

describe('boardSlug', () => {
  test('should accept lowercase letters, digits and dashes', () => {
    expect(boardSlug('post-notifications-2')).toBe('post-notifications-2')
    expect(boardFile('post-notifications')).toBe('docs/boards/post-notifications.board.json')
  })

  test('should refuse anything a path could be built from', () => {
    for (const value of ['../x', 'a/b', 'A', '-a', '', 'a.b', 'a'.repeat(65)]) {
      expect(isBoardSlug(value), value).toBe(false)
      expect(() => boardFile(value), value).toThrow(CliError)
    }
  })

  test('should derive a slug from an ASCII title and none from a title without one', () => {
    expect(deriveBoardSlug('Post notifications!')).toBe('post-notifications')
    expect(deriveBoardSlug('投稿の公開通知')).toBeUndefined()
  })
})

describe('BoardSchema', () => {
  test('should accept a board whose references resolve', () => {
    const candidate = board({
      notes: [
        { id: 'aa', kind: 'command', text: 'A', x: 32, y: 56, section: 'lane' },
        { id: 'qq', kind: 'question', text: 'Why?', x: 32, y: 168, about: ['aa'] },
      ],
      arrows: [{ from: 'aa', to: 'qq', kind: 'async' }],
      sections: [{ id: 'lane', title: 'Lane', x: 16, y: 16, width: 912, height: 168 }],
    })

    expect(issues(candidate)).toBe('')
  })

  test('should refuse an arrow, a section or an about entry that names nothing', () => {
    expect(issues(board({ arrows: [{ from: 'aa', to: 'zz' }] }))).toContain('no note is named zz')
    expect(issues(board({ notes: [{ id: 'aa', kind: 'event', text: 'A', x: 0, y: 0, section: 'gone' }] }))).toContain('no section is named gone')
    expect(issues(board({ notes: [{ id: 'qq', kind: 'question', text: 'Q', x: 0, y: 0, about: ['zz'] }] }))).toContain('no note is named zz')
  })

  test('should refuse about on a note that is not a question', () => {
    const candidate = board({ notes: [{ id: 'aa', kind: 'event', text: 'A', x: 0, y: 0, about: ['aa'] }] })

    expect(issues(candidate)).toContain('only a question note is about other notes')
  })

  test('should refuse two notes of one id, an arrow declared twice and an arrow to itself', () => {
    const twice = { id: 'aa', kind: 'event', text: 'A', x: 0, y: 0 } as const

    expect(issues(board({ notes: [twice, twice] }))).toContain('two notes are named aa')
    expect(issues(board({ arrows: [{ from: 'aa', to: 'bb' }, { from: 'aa', to: 'bb', kind: 'async' }] }))).toContain('declared twice')
    expect(issues(board({ arrows: [{ from: 'aa', to: 'aa' }] }))).toContain('two different notes')
  })

  test('should refuse a coordinate off the grid, text over one line and an inherited name as an id', () => {
    expect(issues(board({ notes: [{ id: 'aa', kind: 'event', text: 'A', x: 13, y: 0 }] }))).not.toBe('')
    expect(issues(board({ notes: [{ id: 'aa', kind: 'event', text: 'A\nB', x: 0, y: 0 }] }))).toContain('one line')
    expect(issues(board({ notes: [{ id: 'constructor', kind: 'event', text: 'A', x: 0, y: 0 }] }))).toContain('inherits')
  })

  test('should refuse a module on a page link', () => {
    const link = { kind: 'page', name: 'posts/Index', module: 'billing' } as const

    expect(issues(board({ notes: [{ id: 'aa', kind: 'view', text: 'A', x: 0, y: 0, link }] }))).toContain('a page link takes no module')
  })
})

describe('serializeBoard', () => {
  test('should write one byte sequence whatever order the board was built in', () => {
    const one = board({ arrows: [{ from: 'bb', to: 'aa' }, { from: 'aa', to: 'bb' }] })
    const two = board({ notes: [...one.notes].reverse(), arrows: [...one.arrows].reverse() })

    expect(serializeBoard(one)).toBe(serializeBoard(two))
    expect(JSON.parse(serializeBoard(one)).notes.map((note: { id: string }) => note.id)).toEqual(['aa', 'bb'])
    expect(serializeBoard(one).endsWith('}\n')).toBe(true)
  })

  test('should leave out an empty about list and keep a fixed key order', () => {
    const candidate = board({ notes: [{ about: [], y: 8, x: 16, text: 'Q', kind: 'question', id: 'qq' }] })

    expect(Object.keys(JSON.parse(serializeBoard(candidate)).notes[0])).toEqual(['id', 'kind', 'text', 'x', 'y'])
  })
})
