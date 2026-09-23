import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { runCommand, type CommandDef } from 'citty'

import { builtinSubCommands } from '../src/commands'
import type { PlanApproveReport } from '../src/plan-approve'
import type { PlanCloseReport } from '../src/plan-close'
import type { PlanNextReport } from '../src/plan-next'
import type { PlanStatusReport } from '../src/plan-status'
import type { PlanVerifyReport } from '../src/plan-verify'
import { approvalReadings, baselineDigest, heldAlters, planApprovalsPath, readPlanApprovals, type PlanApprovals } from '../src/plan/approvals'
import { planHash } from '../src/plan/identity'
import { PlanSchema } from '../src/plan/schema'
import type { PlanPropertyReading } from '../src/plan/status'
import { createTempRoot, linkWorkspaceCore, writeWorkspaceFiles } from './helpers'
import { PLAN_VERIFY_APP_FILES } from './plan-fixture'

// Each application has a directory of its own: Bun keys an imported routes file on its path.
const ROOT_PREFIX = 'guren-plan-alter-readings-'
let ROOT: string
const WORKSPACE_DRIZZLE = resolve(import.meta.dir, '../../orm/node_modules/drizzle-orm')
const PLAN_FILE = 'pages.plan.json'

const page = (name: string, props: string): string => `interface Props {
${props}
}

export default function ${name}(_props: Props) {
  return null
}
`

const INDEX = 'resources/js/pages/posts/Index.tsx'
const SHOW = 'resources/js/pages/posts/Show.tsx'

/**
 * Two page alters: `posts/Show` restates the prop it already declares and changes nothing a
 * reader sees, `posts/Index` adds `total` beside the `posts` it already declares.
 */
const PLAN_DOCUMENT = {
  planVersion: 1,
  title: 'Post totals',
  summary: 'Show how many posts there are.',
  locale: 'en',
  scope: { goals: ['Show a total on the post list'], nonGoals: [] },
  views: [
    { id: 'view.posts.show', change: { kind: 'alter' }, page: 'posts/Show', purpose: 'Show a post.', props: [{ name: 'post', type: 'string' }], actions: [], states: {} },
    {
      id: 'view.posts.index',
      change: { kind: 'alter' },
      page: 'posts/Index',
      purpose: 'List posts with their total.',
      props: [
        { name: 'posts', type: 'string[]' },
        { name: 'total', type: 'number' },
      ],
      actions: [],
      states: {},
    },
  ],
}

/** `Post` altered to have many `Comment`s, which the application declares but `Post` does not relate to yet. */
const RELATIONSHIP_PLAN = {
  ...PLAN_DOCUMENT,
  title: 'Post comments',
  views: [],
  models: [
    { id: 'model.post', change: { kind: 'alter' }, name: 'Post', table: 'posts', columns: [], relationships: [{ name: 'comments', type: 'hasMany', target: 'model.comment' }], fillable: [] },
    { id: 'model.comment', change: { kind: 'existing' }, name: 'Comment', table: 'comments', columns: [], relationships: [], fillable: [] },
  ],
}

/** `posts/Show` restates its prop beside an unread state; `posts/Index` plans only an unread state. */
const UNREAD_PLAN = {
  ...PLAN_DOCUMENT,
  title: 'Post states',
  views: [
    { ...PLAN_DOCUMENT.views[0]!, states: { empty: 'No post.' } },
    { ...PLAN_DOCUMENT.views[1]!, props: [], states: { empty: 'No posts yet.' } },
  ],
}

const POST_WITH_COMMENTS = `import { defineModel, type HasManyRecord } from '@guren/core'
import { posts } from '@/db/schema'
import type { CommentRecord } from './Comment'

export class Post extends defineModel(posts) {
  static override relationTypes: { comments: HasManyRecord<CommentRecord> } = { comments: null }
}

Post.hasMany('comments', () => import('./Comment').then((module) => module.Comment), 'postId', 'id')
`

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'user.name=Approver', '-c', 'user.email=approver@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
}

/** A committed application with the plan beside it, before any of the plan is built. */
async function createApp(name: string, document: object = PLAN_DOCUMENT): Promise<{ dir: string; plan: string }> {
  const dir = join(ROOT, name)
  await writeWorkspaceFiles(dir, {
    ...PLAN_VERIFY_APP_FILES,
    '.gitignore': 'node_modules\n',
    'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'

export class PostController extends Controller {
  async index() {
    return this.inertia('posts/Index', { posts: [] })
  }
}
`,
    [INDEX]: page('Index', '  posts: string[]'),
    [SHOW]: page('Show', '  post: string'),
    [PLAN_FILE]: JSON.stringify(document),
  })
  await linkWorkspaceCore(dir)
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await symlink(WORKSPACE_DRIZZLE, join(dir, 'node_modules', 'drizzle-orm'), 'dir')
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return { dir, plan: join(dir, PLAN_FILE) }
}

async function buildTotal(dir: string): Promise<void> {
  await writeFile(join(dir, INDEX), page('Index', '  posts: string[]\n  total: number'), 'utf8')
  git(dir, 'commit', '-q', '-am', 'total')
}

describe('an alter judged against how it read at approval', () => {
  const log = spyOn(console, 'log')

  beforeAll(async () => {
    ROOT = await createTempRoot(ROOT_PREFIX)
  })

  afterEach(() => {
    log.mockClear()
    process.exitCode = 0
  })

  afterAll(() => {
    log.mockRestore()
  })

  async function run<T>(command: 'plan:approve' | 'plan:status' | 'plan:verify' | 'plan:next' | 'plan:close', app: { dir: string; plan: string }): Promise<T> {
    log.mockClear()
    log.mockImplementation(() => {})
    await runCommand(builtinSubCommands[command] as CommandDef, { rawArgs: [app.plan, '--app', app.dir, '--json'] })
    return JSON.parse(log.mock.calls.map((call) => String(call[0])).join('\n')) as T
  }

  async function runText(command: 'plan:approve', app: { dir: string; plan: string }): Promise<string> {
    log.mockClear()
    log.mockImplementation(() => {})
    await runCommand(builtinSubCommands[command] as CommandDef, { rawArgs: [app.plan, '--app', app.dir] })
    return log.mock.calls.map((call) => String(call[0])).join('\n')
  }

  const states = (report: { elements: Array<{ id: string; state: string }> }): Record<string, string> =>
    Object.fromEntries(report.elements.map((element) => [element.id, element.state]))

  test('should record at approval how each planned property of an alter read', async () => {
    const app = await createApp('record')

    const report = await run<PlanApproveReport>('plan:approve', app)

    expect(report.readingsRecorded).toEqual(['view.posts.show', 'view.posts.index'])
    expect((await readPlanApprovals(app.plan)).value!.approvals[0]!.readings!.properties).toEqual([
      { element: 'view.posts.show', label: 'posts/Show', property: 'prop post', planned: 'declared', verdict: 'match' },
      { element: 'view.posts.index', label: 'posts/Index', property: 'prop posts', planned: 'declared', verdict: 'match' },
      { element: 'view.posts.index', label: 'posts/Index', property: 'prop total', planned: 'declared', verdict: 'differ' },
    ])
  })

  test('should warn at approval on an alter whose readable properties all held, and not on one with a property still to change', async () => {
    const app = await createApp('held-warning')

    const report = await run<PlanApproveReport>('plan:approve', app)

    expect(report.alreadyApproved).toBe(false)
    expect(report.heldAlters).toEqual([
      {
        element: 'view.posts.show',
        label: 'posts/Show',
        held: ['prop post'],
        unread: [],
        message: expect.stringContaining('view.posts.show (posts/Show): every readable planned property already held at approval (prop post); none shows the change'),
      },
    ])
    expect(report.heldAlters![0]!.message).toContain('State the change in a property the application does not hold yet and approve the plan again')

    // Already approved: the entry is unchanged, and so is the warning.
    const again = await runText('plan:approve', app)
    expect(again).toContain('left alone')
    expect(again).toContain('Warning, advisory (the approval stands):')
    expect(again).toContain(`  ${report.heldAlters![0]!.message}`)
    expect(again).not.toContain('view.posts.index (')
    expect((await run<PlanApproveReport>('plan:approve', app)).heldAlters).toEqual(report.heldAlters)
  })

  test('should keep the warning on a revision approved after the work, and never raise it for the property the work changed', async () => {
    const app = await createApp('held-revision')
    await run('plan:approve', app)
    await buildTotal(app.dir)
    const document = JSON.parse(await readFile(app.plan, 'utf8')) as { scope: { goals: string[] } }
    document.scope.goals.push('Keep the list short')
    await writeFile(app.plan, JSON.stringify(document), 'utf8')

    const reapproved = await run<PlanApproveReport>('plan:approve', app)

    expect(reapproved.alreadyApproved).toBe(false)
    expect(reapproved.heldAlters?.map((alter) => alter.element)).toEqual(['view.posts.show'])
  })

  test('should name the unread properties that can still show the change, and not warn on an alter nothing of which was readable', async () => {
    const app = await createApp('held-unread', UNREAD_PLAN)

    const report = await run<PlanApproveReport>('plan:approve', app)

    expect(report.readingsRecorded).toEqual(['view.posts.show', 'view.posts.index'])
    expect(report.heldAlters).toEqual([
      {
        element: 'view.posts.show',
        label: 'posts/Show',
        held: ['prop post'],
        unread: ['states'],
        message: expect.stringContaining('states read unknown then, and only a match on it can still show the change'),
      },
    ])
  })

  test('should complete no alter on a property that already held, before or after its step verifies', async () => {
    const app = await createApp('held')
    await run('plan:approve', app)

    const before = await run<PlanStatusReport>('plan:status', app)
    expect(states(before)).toEqual({ 'view.posts.show': 'unjudged', 'view.posts.index': 'planned' })
    expect(before.elements[0]!.reason).toContain('already held when the plan was approved')

    await buildTotal(app.dir)
    const verified = await run<PlanVerifyReport>('plan:verify', app)
    expect(verified.steps.map((step) => step.record.outcome)).not.toContain('failed')
    expect(states(verified)).toEqual({ 'view.posts.show': 'unjudged', 'view.posts.index': 'verified' })
    expect(verified.elements[0]!.hold?.kind).toBe('unreached')

    // The same answer from every command that reads completion.
    expect(states(await run<PlanStatusReport>('plan:status', app))).toEqual(states(verified))
    const next = await run<PlanNextReport>('plan:next', app)
    expect(next.unverified?.map((element) => element.id)).toEqual(['view.posts.show'])
    await expect(run<PlanCloseReport>('plan:close', app)).rejects.toThrow(/view\.posts\.show/u)
  })

  test('should fail closed on an approval that recorded no reading, and record the missing ones on re-approval', async () => {
    const app = await createApp('backfill')
    await run('plan:approve', app)
    const hash = planHash(PlanSchema.parse(JSON.parse(await readFile(app.plan, 'utf8'))))
    // An approval written before readings were recorded carries none.
    await writeFile(planApprovalsPath(app.plan), JSON.stringify({ approvalsVersion: 1, approvals: [{ hash, approvedAt: '2026-09-22T09:00:00.000Z' }] }), 'utf8')
    git(app.dir, 'add', '-A')
    git(app.dir, 'commit', '-q', '-m', 'approve')

    const unrecorded = await run<PlanStatusReport>('plan:status', app)
    expect(states(unrecorded)).toEqual({ 'view.posts.show': 'unjudged', 'view.posts.index': 'planned' })
    // A re-approval would record the held match as held, and only the property still to change in time.
    expect(unrecorded.elements[0]!.reason).not.toContain('plan:approve')
    expect(unrecorded.elements[1]!.notes).toEqual([expect.stringContaining('no reading of prop total: run guren plan:approve on the plan before changing it')])

    // Built before the readings exist: a reading taken now can only miss the change, never credit it.
    await buildTotal(app.dir)
    const backfilled = await run<PlanApproveReport>('plan:approve', app)
    expect(backfilled).toMatchObject({ alreadyApproved: true, readingsRecorded: ['view.posts.show', 'view.posts.index'] })
    expect(states(await run<PlanStatusReport>('plan:status', app))).toEqual({ 'view.posts.show': 'unjudged', 'view.posts.index': 'unjudged' })
    expect((await run<PlanApproveReport>('plan:approve', app)).readingsRecorded).toBeUndefined()
  })

  test('should complete a model alter on a relationship written after approval, whose reading was taken before it existed', async () => {
    const app = await createApp('relationship', RELATIONSHIP_PLAN)
    await run('plan:approve', app)

    await writeFile(join(app.dir, 'app/Models/Post.ts'), POST_WITH_COMMENTS, 'utf8')
    git(app.dir, 'commit', '-q', '-am', 'comments')
    const post = (await run<PlanStatusReport>('plan:status', app)).elements.find((element) => element.id === 'model.post')!

    expect(post.state).toBe('present')
    expect(post.properties.map((property) => [property.property, property.verdict])).toEqual([
      ['relationship comments', 'match'],
      ['relationship comments target', 'match'],
    ])
  })

  test('should carry the first reading to a revision approved after the work, so the change still counts', async () => {
    const app = await createApp('revision')
    await run('plan:approve', app)
    await buildTotal(app.dir)
    const document = JSON.parse(await readFile(app.plan, 'utf8')) as { scope: { goals: string[] } }
    document.scope.goals.push('Keep the list short')
    await writeFile(app.plan, JSON.stringify(document), 'utf8')

    const reapproved = await run<PlanApproveReport>('plan:approve', app)

    expect(reapproved.alreadyApproved).toBe(false)
    const [first, second] = (await readPlanApprovals(app.plan)).value!.approvals
    expect(second!.readings).toEqual(first!.readings)
    expect(states(await run<PlanStatusReport>('plan:status', app))).toEqual({ 'view.posts.show': 'unjudged', 'view.posts.index': 'wired' })
  })
})

describe('heldAlters', () => {
  const plan = PlanSchema.parse({ ...PLAN_DOCUMENT, baseline: { rev: 'abc123', contextHash: {} } })
  const reading = (element: string, property: string, verdict: PlanPropertyReading['verdict']): PlanPropertyReading => ({
    element,
    label: element === 'view.posts.show' ? 'posts/Show' : 'posts/Index',
    property,
    planned: 'declared',
    verdict,
  })
  const post = reading('view.posts.show', 'prop post', 'match')

  test('should judge on the recorded verdict, not on how the property reads now', () => {
    const total = (verdict: PlanPropertyReading['verdict']) => reading('view.posts.index', 'prop total', verdict)
    const posts = reading('view.posts.index', 'prop posts', 'match')

    expect(heldAlters(plan, [posts, total('match')], [posts, total('differ')])).toEqual([])
    expect(heldAlters(plan, [posts, total('differ')], [posts, total('match')]).map((alter) => alter.element)).toEqual(['view.posts.index'])
  })

  test('should keep the warning when the section is unreadable at re-approval, from the readings recorded before', () => {
    expect(heldAlters(plan, [], [post])).toEqual([{ element: 'view.posts.show', label: 'posts/Show', held: ['prop post'], unread: [] }])
  })

  test('should not count an unknown reading as held', () => {
    const unread = reading('view.posts.show', 'states', 'unknown')

    expect(heldAlters(plan, [unread], [unread])).toEqual([])
    expect(heldAlters(plan, [post, unread], [post, unread])).toEqual([{ element: 'view.posts.show', label: 'posts/Show', held: ['prop post'], unread: ['states'] }])
  })
})

describe('approvalReadings', () => {
  const plan = PlanSchema.parse({ ...PLAN_DOCUMENT, baseline: { rev: 'abc123', contextHash: {} } })
  const total = (verdict: PlanPropertyReading['verdict']): PlanPropertyReading => ({ element: 'view.posts.index', label: 'posts/Index', property: 'prop total', planned: 'declared', verdict })
  const approvals = (baseline: string): PlanApprovals => ({
    approvalsVersion: 1,
    approvals: [{ hash: 'h0', approvedAt: '2026-09-21T00:00:00.000Z', readings: { baseline, properties: [total('differ')] } }],
  })

  test('should keep the earliest reading under the plan’s own baseline', () => {
    const baseline = baselineDigest(plan)

    expect(approvalReadings(approvals(baseline), plan, [total('match')]).properties).toEqual([total('differ')])
  })

  test('should keep a reading the application cannot give now, so a section unreadable at re-approval loses nothing', () => {
    const baseline = baselineDigest(plan)

    expect(approvalReadings(approvals(baseline), plan, []).properties).toEqual([total('differ')])
  })

  test('should take no reading from another baseline in the same file, which is another plan’s start', () => {
    expect(approvalReadings(approvals('another'), plan, [total('match')]).properties).toEqual([total('match')])
  })
})
