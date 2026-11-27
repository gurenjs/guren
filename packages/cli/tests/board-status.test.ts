import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { boardStatus, formatBoardStatus, judgeBoardStatus, planAdds } from '../src/board/status'
import { applyBoardOpsFile, createBoard } from '../src/board/store'
import type { Board } from '../src/board/schema'
import type { PlanAppDetail } from '../src/plan/app-detail'
import { PlanDraftSchema, type PlanDraft } from '../src/plan/schema'
import { createTempRoot } from './helpers'
import { loadCommentsPlan, planAppState } from './plan-fixture'

function commentsPlan(): PlanDraft {
  const document = loadCommentsPlan()
  document.sideEffects = [
    { id: 'event.comment-posted', change: { kind: 'add' }, kind: 'event', name: 'CommentPosted', trigger: 'action.comments.store', description: 'A comment was posted.' },
  ]
  return PlanDraftSchema.parse(document)
}

function note(id: string, kind: Board['notes'][number]['kind'], link?: Board['notes'][number]['link']): Board['notes'][number] {
  return { id, kind, text: `${id} text`, x: 0, y: 0, ...(link ? { link } : {}) }
}

function board(notes: Board['notes']): Board {
  return { boardVersion: 1, title: 'Comments', locale: 'en', notes, arrows: [], sections: [] }
}

/** An application whose only side effect is the `PostPublished` event. */
function appWithEvents(): ReturnType<typeof planAppState> {
  const empty = { job: [], listener: [], mail: [], notification: [] }
  const detail = { sideEffects: { ...empty, event: [{ className: 'PostPublished', module: null, file: 'app/Events/PostPublished.ts', usedIn: [], unprovenIn: [], mentionedIn: [] }] } }
  return planAppState({ detail: detail as unknown as PlanAppDetail })
}

describe('planAdds', () => {
  test('should name added actions as Class.action and leave out what the plan only references', () => {
    const plan = commentsPlan()
    expect(planAdds(plan, 'action').map((entry) => entry.name)).toEqual(['CommentController.store', 'CommentController.destroy'])
    expect(planAdds(plan, 'model').map((entry) => entry.name)).toEqual(['Comment'])
    expect(planAdds(plan, 'page')).toEqual([])
    expect(planAdds(plan, 'event')).toEqual([{ name: 'CommentPosted', module: null }])
    expect(planAdds(plan, 'job')).toEqual([])
  })
})

describe('judgeBoardStatus', () => {
  const plans = [{ file: 'docs/plans/comments/plan.json', plan: commentsPlan(), source: 'given' as const }]

  test('should read a link present in the app, planned by a plan, or missing from both', () => {
    const report = judgeBoardStatus({
      slug: 'comments',
      board: board([
        note('post', 'aggregate', { kind: 'model', name: 'Post' }),
        note('comment', 'aggregate', { kind: 'model', name: 'Comment' }),
        note('store', 'command', { kind: 'action', name: 'CommentController.store' }),
        note('posted', 'event', { kind: 'event', name: 'CommentPosted' }),
        note('published', 'event', { kind: 'event', name: 'PostPublished' }),
        note('reply', 'command', { kind: 'route', name: 'comments.reply' }),
        note('author', 'actor'),
        note('spam', 'question'),
      ]),
      plans,
      unreadPlans: [],
      app: appWithEvents(),
    })

    expect(Object.fromEntries(report.notes.map((entry) => [entry.id, entry.state]))).toEqual({
      author: 'unlinked',
      comment: 'planned',
      post: 'present',
      posted: 'planned',
      published: 'present',
      reply: 'missing',
      spam: 'unlinked',
      store: 'planned',
    })
    expect(report.notes.find((entry) => entry.id === 'comment')?.plannedIn).toEqual(['docs/plans/comments/plan.json'])
    expect(report.leadsNowhere).toEqual(['author', 'reply'])
  })

  test('should match a model in its module and a route across modules', () => {
    const report = judgeBoardStatus({
      slug: 'comments',
      board: board([
        note('post', 'aggregate', { kind: 'model', name: 'Post', module: 'billing' }),
        note('index', 'command', { kind: 'route', name: 'posts.index', module: 'billing' }),
      ]),
      plans: [],
      unreadPlans: [],
      app: planAppState(),
    })

    expect(report.notes.map((entry) => [entry.id, entry.state])).toEqual([
      ['index', 'present'],
      ['post', 'missing'],
    ])
  })

  test('should read a link unknown, never missing, where its section would not read', () => {
    const report = judgeBoardStatus({
      slug: 'comments',
      board: board([note('job', 'reaction', { kind: 'job', name: 'SendDigest' }), note('comment', 'aggregate', { kind: 'model', name: 'Comment' })]),
      plans,
      unreadPlans: [],
      app: { unreadable: 'the application could not be read: boom' },
    })

    expect(report.notes).toEqual([
      { id: 'comment', kind: 'aggregate', text: 'comment text', link: { kind: 'model', name: 'Comment' }, state: 'planned', plannedIn: ['docs/plans/comments/plan.json'] },
      { id: 'job', kind: 'reaction', text: 'job text', link: { kind: 'job', name: 'SendDigest' }, state: 'unknown', reason: 'the application could not be read: boom' },
    ])
    expect(report.leadsNowhere).toEqual([])
  })

  test('should print each linked note with its state and the notes that lead nowhere', () => {
    const report = judgeBoardStatus({
      slug: 'comments',
      board: board([note('comment', 'aggregate', { kind: 'model', name: 'Comment' }), note('reply', 'command', { kind: 'route', name: 'comments.reply' }), note('author', 'actor')]),
      plans,
      unreadPlans: [{ file: 'docs/plans/old/plan.json', reason: 'not JSON' }],
      app: planAppState(),
    })

    expect(formatBoardStatus(report)).toBe(
      [
        'Board: Comments  (docs/boards/comments.board.json)',
        'Plans: docs/plans/comments/plan.json (given)',
        '  not read: docs/plans/old/plan.json: not JSON',
        '',
        'Linked notes:',
        '  planned   [aggregate comment] comment text  = model Comment  (docs/plans/comments/plan.json)',
        '  missing   [command reply] reply text  = route comments.reply',
        '',
        'Lead nowhere (2):',
        '  [actor author] author text  (no link)',
        '  [command reply] reply text  = route comments.reply (missing)',
      ].join('\n'),
    )
  })
})

describe('boardStatus', () => {
  let root: string
  let count = 0

  async function app(): Promise<string> {
    count += 1
    const dir = join(root, `app-${count}`)
    await createBoard(dir, { slug: 'comments', title: 'Comments', locale: 'en' })
    await applyBoardOpsFile(dir, 'comments', [{ op: 'add', id: 'comment', kind: 'aggregate', text: 'Comment' }, { op: 'link', id: 'comment', link: { kind: 'model', name: 'Comment' } }])
    await mkdir(join(dir, 'docs/plans/comments'), { recursive: true })
    await writeFile(join(dir, 'docs/plans/comments/plan.json'), JSON.stringify(loadCommentsPlan()))
    return dir
  }

  beforeAll(async () => {
    root = await createTempRoot('guren-board-status-')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('should count a draft only when it is given with --plan', async () => {
    const dir = await app()
    const application = async () => planAppState()

    const open = await boardStatus(dir, 'comments', { app: application })
    expect(open.plans).toEqual([])
    expect(open.notes.map((entry) => entry.state)).toEqual(['missing'])

    const given = await boardStatus(dir, 'comments', { plan: 'docs/plans/comments/plan.json', app: application })
    expect(given.plans).toEqual([{ file: 'docs/plans/comments/plan.json', source: 'given' }])
    expect(given.notes.map((entry) => entry.state)).toEqual(['planned'])
  })

  test('should report an application that throws as unread, not fail the run', async () => {
    const dir = await app()
    const report = await boardStatus(dir, 'comments', {
      app: async () => {
        throw new Error('routes file threw')
      },
    })
    expect(report.notes.map((entry) => [entry.state, entry.reason])).toEqual([['unknown', 'the application could not be read: routes file threw']])
  })
})
