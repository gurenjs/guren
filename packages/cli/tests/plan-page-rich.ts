import type { PlanCheckResult } from '../src/plan/render'
import { PlanSchema, type Plan } from '../src/plan/schema'
import { loadCommentsPlan, TEST_BASELINE } from './plan-fixture'

type Loose = Record<string, any>

/**
 * The comments plan with every sentence the page can write switched on: each response
 * kind, a bind key, an agent tool, both index kinds, renames and drops, a data
 * migration at both levels, and an acceptance case using every expectation.
 */
export function richPlan(locale = 'en'): Plan {
  const plan = loadCommentsPlan() as Loose
  plan.locale = locale
  plan.baseline = TEST_BASELINE
  plan.hints = ['Run the migration before deploying.']

  const [post, comment] = plan.models
  post.tableRenamedFrom = 'articles'
  post.module = 'blog'
  post.fillable = ['title', 'body']
  post.indexes = [{ columns: ['slug', 'authorId'], unique: true }, { columns: ['authorId', 'createdAt'], unique: false }]
  post.dataMigration = { kind: 'backfill', description: 'Copy every article row.' }
  post.columns.push(
    {
      id: 'column.post.slug',
      name: 'slug',
      change: { kind: 'rename', from: 'permalink' },
      type: 'string',
      nullable: true,
      unique: true,
      index: false,
      dataMigration: { kind: 'none', reason: 'The values carry over.' },
    },
    {
      id: 'column.post.legacy',
      name: 'legacy',
      change: { kind: 'drop', reason: 'Nothing reads it.' },
      type: 'boolean',
      nullable: false,
      unique: false,
      index: false,
    },
    { id: 'column.post.views', name: 'views', change: { kind: 'alter' }, type: 'integer', nullable: false, unique: false, index: false },
  )
  comment.change = { kind: 'rename', from: 'Reply' }

  const view = plan.views[0]
  view.props.push({ name: 'canComment', type: 'boolean' })

  const controller = plan.controllers[0]
  const response = (id: string, name: string, kind: Loose): Loose => ({
    id,
    change: { kind: 'add' },
    name,
    authorization: { middleware: [] },
    response: kind,
    rules: [],
  })
  controller.actions.push(
    response('action.comments.index', 'index', { kind: 'inertia', view: 'view.posts.show' }),
    response('action.comments.show', 'show', { kind: 'resource', resource: 'resource.comment' }),
    response('action.comments.count', 'count', { kind: 'json', description: 'the number of comments' }),
    response('action.comments.ping', 'ping', { kind: 'empty' }),
  )

  plan.routes[1].bind[0].key = 'uuid'
  plan.routes.push(
    {
      id: 'route.comments.index',
      change: { kind: 'alter' },
      method: 'GET',
      path: '/comments',
      name: 'comments.index',
      action: 'action.comments.index',
      middleware: [],
      bind: [],
      agent: { toolName: 'comments_index', readOnly: true },
    },
    {
      id: 'route.comments.legacy',
      change: { kind: 'drop', reason: 'Replaced by comments.index.' },
      method: 'GET',
      path: '/replies',
      name: 'replies.index',
      action: 'action.comments.index',
      middleware: [],
      bind: [],
    },
  )

  plan.validators[0].fields.push({ name: 'parentId', type: 'integer', required: false, rules: [] })

  plan.sideEffects = [
    {
      id: 'effect.comment.notify',
      change: { kind: 'add' },
      kind: 'notification',
      name: 'CommentPosted',
      trigger: 'A comment is stored.',
      description: 'Tells the post author.',
    },
  ]
  plan.commands = [{ id: 'command.migrate', command: 'bun run db:migrate', reason: 'The comments table is new.' }]

  const acceptance = plan.tasks[0].acceptance
  acceptance[0].expect.database.push({ table: 'comments', missing: [{ name: 'body', json: '"spam"' }] })
  acceptance.push({
    id: 'AC-comments-page',
    description: 'The post page lists its comments.',
    kind: 'success',
    actor: 'guest',
    route: 'route.comments.index',
    given: [],
    expect: { status: 200, inertia: 'view.posts.show' },
  })

  return PlanSchema.parse(plan)
}

export const RICH_CHECKS: PlanCheckResult[] = [
  { id: 'plan-ref:route.comments.store', title: 'Route action', status: 'fail', message: 'The action is not declared.', elementId: 'route.comments.store', suggestion: 'Declare it.' } as PlanCheckResult,
  { id: 'plan-doc', title: 'Plan document', status: 'warn', message: 'Two ids repeat.' } as PlanCheckResult,
  { id: 'plan-ok', title: 'Identity', status: 'pass', message: 'The hash matches.', elementId: 'model.post' } as PlanCheckResult,
]
