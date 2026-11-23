import { describe, expect, test } from 'bun:test'

import { applyBoardOps, type BoardOp } from '../src/board/ops'
import { emptyBoard } from '../src/board/schema'
import { renderBoardOutline } from '../src/board/text'

const PUBLISHING: BoardOp[] = [
  { op: 'section', id: 'publishing', title: 'Publishing' },
  { op: 'add', id: 'author', kind: 'actor', text: 'Author', section: 'publishing' },
  { op: 'add', id: 'publish_post', kind: 'command', text: 'Publish a post', after: 'author' },
  { op: 'add', id: 'post', kind: 'aggregate', text: 'Post', after: 'publish_post' },
  { op: 'add', id: 'post_published', kind: 'event', text: 'Post was published', after: 'post' },
  { op: 'add', id: 'tell_subscribers', kind: 'reaction', text: 'When published, tell subscribers', after: 'post_published' },
  { op: 'add', id: 'audit', kind: 'reaction', text: 'Record it', after: 'post_published' },
  { op: 'add', id: 'draft_too', kind: 'question', text: 'Notify for a saved draft too?', about: ['post_published'] },
  { op: 'add', id: 'post_updated', kind: 'event', text: 'Post was updated' },
  { op: 'connect', from: 'author', to: 'publish_post' },
  { op: 'connect', from: 'publish_post', to: 'post' },
  { op: 'connect', from: 'post', to: 'post_published' },
  { op: 'connect', from: 'post_published', to: 'tell_subscribers' },
  { op: 'connect', from: 'post_published', to: 'audit', kind: 'async' },
  { op: 'connect', from: 'audit', to: 'publish_post' },
  { op: 'link', id: 'post', link: { kind: 'model', name: 'Post' } },
]

describe('renderBoardOutline', () => {
  test('should print each section in flow order with every arrow on the note it leaves', () => {
    const { board } = applyBoardOps(emptyBoard('Post notifications', 'en'), PUBLISHING)

    expect(renderBoardOutline(board, 'post-notifications')).toBe(
      [
        'Board: Post notifications  (docs/boards/post-notifications.board.json)',
        '',
        'Publishing [publishing]',
        '  [actor author] Author  -> publish_post',
        '  [command publish_post] Publish a post  -> post',
        '  [aggregate post] Post  = model Post  -> post_published',
        '  [event post_published] Post was published  ~> audit, -> tell_subscribers',
        '      ? [draft_too] Notify for a saved draft too?',
        '  [reaction audit] Record it  -> publish_post (back)',
        '  [reaction tell_subscribers] When published, tell subscribers',
        'Unsorted [unsorted]',
        '  [event post_updated] Post was updated',
        '',
      ].join('\n'),
    )
  })

  test('should not depend on where the notes sit', () => {
    const { board } = applyBoardOps(emptyBoard('Post notifications', 'en'), PUBLISHING)
    const moved = applyBoardOps(board, [
      { op: 'move', id: 'author', x: 8000, y: 8000 },
      { op: 'move', id: 'post_published', x: 0, y: 0 },
    ]).board

    expect(renderBoardOutline(moved, 'post-notifications')).toBe(renderBoardOutline(board, 'post-notifications'))
  })

  test('should mark one arrow of a loop that nothing enters from outside', () => {
    const { board } = applyBoardOps(emptyBoard('Loop', 'en'), [
      { op: 'add', id: 'xx', kind: 'event', text: 'X', at: { x: 0, y: 0 } },
      { op: 'add', id: 'yy', kind: 'event', text: 'Y', at: { x: 0, y: 0 } },
      { op: 'connect', from: 'xx', to: 'yy' },
      { op: 'connect', from: 'yy', to: 'xx' },
    ])

    expect(renderBoardOutline(board, 'loop')).toBe(
      ['Board: Loop  (docs/boards/loop.board.json)', '', '(no section)', '  [event xx] X  -> yy', '  [event yy] Y  -> xx (back)', ''].join('\n'),
    )
  })

  test('should name the other notes a question is about, and list a question about nothing by itself', () => {
    const { board } = applyBoardOps(emptyBoard('Questions', 'en'), [
      { op: 'add', id: 'aa', kind: 'event', text: 'A', at: { x: 0, y: 0 } },
      { op: 'add', id: 'bb', kind: 'event', text: 'B', at: { x: 0, y: 0 } },
      { op: 'add', id: 'both', kind: 'question', text: 'Which first?', at: { x: 0, y: 0 }, about: ['bb', 'aa'] },
      { op: 'add', id: 'open', kind: 'question', text: 'Who owns this?', at: { x: 0, y: 0 } },
    ])

    expect(renderBoardOutline(board, 'questions')).toBe(
      [
        'Board: Questions  (docs/boards/questions.board.json)',
        '',
        '(no section)',
        '  [event aa] A',
        '      ? [both] Which first? (also about bb)',
        '  [event bb] B',
        '  ? [open] Who owns this?',
        '',
      ].join('\n'),
    )
  })

  test('should say so when the board is empty', () => {
    expect(renderBoardOutline(emptyBoard('Empty', 'en'), 'empty')).toBe('Board: Empty  (docs/boards/empty.board.json)\n\n(no notes)\n')
  })
})
