import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runCommand } from 'citty'

import { builtinSubCommands } from '../src/commands'
import type { ColumnConsumerScan } from '../src/column-consumers'
import { loadPlanAppState } from '../src/plan/app-state'
import { impactBreakingChanges, planChangesExisting, planImpact, type PlanImpactEntry, type PlanImpactRoute, type PlanImpactSources } from '../src/plan/impact'
import { planBreakingChanges, renderPlanHtml } from '../src/plan/render'
import { PlanDraftSchema, type PlanChange, type PlanDraft } from '../src/plan/schema'
import { CAN_DENY_FILE_READS, createTempWorkspace, linkWorkspaceCore, writeWorkspaceFiles, type TempWorkspace } from './helpers'
import { loadCommentsPlan, PLAN_APP_FILES, PLAN_VERIFY_APP_FILES, planPageData } from './plan-fixture'
import { openPlanPage, type Page, type PageNode } from './plan-page-dom'

/** The comments fixture, parsed and then edited, so every section is present to edit. */
function plan(edit: (draft: PlanDraft) => void = () => {}): PlanDraft {
  const draft = PlanDraftSchema.parse(loadCommentsPlan())
  edit(draft)
  return draft
}

const NO_READS: ColumnConsumerScan = { reads: [], opaque: [], resources: [], unreadable: [] }

const POST = { className: 'Post', file: 'app/Models/Post.ts' }
const BLOG_POST = { className: 'Post', file: 'modules/blog/app/Models/Post.ts' }

function sources(overrides: Partial<PlanImpactSources> = {}): PlanImpactSources {
  return {
    routes: [
      { name: 'posts.show', method: 'GET', path: '/posts/:post', action: 'PostController.show', bindings: { post: 'Post' }, module: null },
      { name: 'posts.update', method: 'PATCH', path: '/posts/:id', action: 'PostController.update', bindings: {}, module: null, toolName: 'posts_update' },
      { method: 'GET', path: '/feed', action: 'FeedController.index', bindings: {}, module: null },
      { name: 'blog.posts.show', method: 'GET', path: '/blog/:post', action: 'BlogPostController.show', bindings: { post: 'Post' }, module: 'blog' },
    ],
    models: [
      { className: 'Post', module: null, file: POST.file, relationships: [] },
      { className: 'User', module: null, file: 'app/Models/User.ts', relationships: [{ name: 'posts', type: 'hasMany', relatedModel: 'Post' }] },
      { className: 'Post', module: 'blog', file: BLOG_POST.file, relationships: [] },
    ],
    actions: [
      { key: 'PostController.show', module: null, file: 'app/Http/Controllers/PostController.ts', pages: ['posts/Show'], calls: [], abilities: [], identifiers: ['Post', 'PostResource'], validates: [] },
      { key: 'FeedController.index', module: null, file: 'app/Http/Controllers/FeedController.ts', pages: [], calls: [], abilities: [], identifiers: ['PostPayloadSchema'], validates: [] },
      { key: 'BlogPostController.show', module: 'blog', file: 'modules/blog/app/Http/Controllers/BlogPostController.ts', pages: [], calls: [], abilities: [], identifiers: ['Post'], validates: [] },
    ],
    resources: [{ className: 'PostResource', file: 'app/Http/Resources/PostResource.ts', models: [POST] }],
    policies: [{ className: 'PostPolicy', module: null, file: 'app/Policies/PostPolicy.ts' }],
    tests: ['tests/PostController.test.ts', 'tests/UserController.test.ts', 'modules/blog/tests/PostController.test.ts'],
    testRequests: { unresolved: [], unparsed: [] },
    reads: {
      ...NO_READS,
      reads: [
        { model: POST, property: 'title', kind: 'resource', file: 'app/Http/Resources/PostResource.ts', line: 12, where: 'PostResource' },
        { model: POST, property: 'title', kind: 'page', file: 'resources/js/pages/posts/Show.tsx', line: 20, where: 'posts/Show', via: 'PostResource' },
        { model: POST, property: 'body', kind: 'controller', file: 'app/Http/Controllers/PostController.ts', line: 9, where: 'PostController.show' },
        { model: { className: 'User', file: 'app/Models/User.ts' }, property: 'title', kind: 'controller', file: 'app/Http/Controllers/UserController.ts', line: 4, where: 'UserController.show' },
        { model: BLOG_POST, property: 'title', kind: 'controller', file: 'modules/blog/app/Http/Controllers/BlogPostController.ts', line: 5, where: 'BlogPostController.show' },
      ],
    },
    unreadable: {},
    unparsedModels: [],
    missingPages: [],
    ...overrides,
  }
}

function withTitleColumn(change: PlanChange): PlanDraft {
  return plan((input) => {
    input.models[0]!.columns.push({ id: 'column.post.title', name: 'title', change, type: 'string', nullable: false, unique: false, index: false })
  })
}

function entryFor(entries: PlanImpactEntry[], id: string): PlanImpactEntry {
  const found = entries.find((entry) => entry.elementId === id)
  if (!found) throw new Error(`Impact has no entry for ${id}`)
  return found
}

describe('planImpact', () => {
  test('should give no entry to an element that adds something or leaves it as it is', () => {
    const ids = planImpact(plan(), sources()).map((entry) => entry.elementId)

    expect(ids).toEqual(['model.post', 'view.posts.show'])
  })

  test("should list the reads of a dropped column on its model's records, and no other model's", () => {
    const entry = entryFor(planImpact(withTitleColumn({ kind: 'drop', reason: 'unused' }), sources()), 'column.post.title')

    expect(entry.consumers).toEqual([
      { kind: 'read', name: 'PostResource', file: 'app/Http/Resources/PostResource.ts', line: 12 },
      { kind: 'read', name: 'posts/Show', file: 'resources/js/pages/posts/Show.tsx', line: 20, via: 'PostResource' },
    ])
  })

  test('should list a site that writes the column apart from one that reads it', () => {
    const writes = sources({ reads: { ...NO_READS, reads: [{ model: POST, property: 'title', write: true, kind: 'controller', file: 'app/Http/Controllers/PostController.ts', line: 3, where: 'PostController.store' }], opaque: [{ model: POST, write: true, kind: 'controller', file: 'app/Http/Controllers/PostController.ts', line: 4, where: 'PostController.store' }] } })
    const altered = withTitleColumn({ kind: 'alter' })
    const entry = entryFor(planImpact(altered, writes), 'column.post.title')

    expect(entry.consumers.map((consumer) => consumer.kind)).toEqual(['write', 'opaqueWrite'])
    expect(openPlanPage(renderPlanHtml({ plan: altered, impact: [entry] })).byId('el-column.post.title').withClass('impact')[0]!.withTag('li').map((item) => item.textContent)).toEqual([
      'PostController.store writes it (app/Http/Controllers/PostController.ts:3)',
      'PostController.store writes data no static scan can name the columns of (app/Http/Controllers/PostController.ts:4)',
    ])
  })

  test('should look a renamed column up by the name it has today', () => {
    const entry = entryFor(planImpact(withTitleColumn({ kind: 'rename', from: 'body' }), sources()), 'column.post.title')

    expect(entry.consumers.map((consumer) => consumer.name)).toEqual(['PostController.show'])
  })

  test('should return an empty list, not no entry, when a changed column has no reader found', () => {
    const entry = entryFor(planImpact(withTitleColumn({ kind: 'alter' }), sources({ reads: NO_READS })), 'column.post.title')

    expect(entry).toEqual({ elementId: 'column.post.title', section: 'columns', consumers: [], notes: [] })
  })

  test('should say which files the scan could not read beside a column it found nothing for', () => {
    const entry = entryFor(
      planImpact(withTitleColumn({ kind: 'alter' }), sources({ reads: { ...NO_READS, unreadable: ['app/Http/Controllers/Broken.ts'] } })),
      'column.post.title',
    )

    expect(entry.notes).toEqual([{ key: 'impact.unreadableFiles', values: { files: 'app/Http/Controllers/Broken.ts' } }])
  })

  test('should say the models could not be read beside a column, rather than show nothing found', () => {
    const entry = entryFor(planImpact(withTitleColumn({ kind: 'alter' }), sources({ models: [], unreadable: { models: 'app/Models would not open' } })), 'column.post.title')

    expect(entry).toMatchObject({ consumers: [], notes: [{ key: 'impact.unreadable.models', values: { reason: 'app/Models would not open' } }] })
  })

  test('should name a model file that did not parse beside a column of it', () => {
    const entry = entryFor(planImpact(withTitleColumn({ kind: 'alter' }), sources({ unparsedModels: ['app/Models/Broken.ts'] })), 'column.post.title')

    expect(entry.notes).toEqual([{ key: 'impact.unparsedModels', values: { files: 'app/Models/Broken.ts' } }])
  })

  test('should name a page with no component file beside a column', () => {
    const entry = entryFor(planImpact(withTitleColumn({ kind: 'alter' }), sources({ missingPages: ['posts/Gone'] })), 'column.post.title')

    expect(entry.notes).toEqual([{ key: 'impact.missingPages', values: { pages: 'posts/Gone' } }])
  })

  test('should say the controllers could not be read beside an element found through actions', () => {
    const entry = entryFor(planImpact(plan(), sources({ actions: [], unreadable: { controllers: 'app/Http/Controllers would not open' } })), 'view.posts.show')

    expect(entry.notes).toEqual([{ key: 'impact.unreadable.controllers', values: { reason: 'app/Http/Controllers would not open' } }])
  })

  test("should keep a module's same-named model out of the root model's Impact, and in its own", () => {
    const rootEntry = entryFor(planImpact(withTitleColumn({ kind: 'drop', reason: 'x' }), sources()), 'column.post.title')
    const blog = plan((draft) => {
      draft.models[0]!.module = 'blog'
      draft.models[0]!.columns.push({ id: 'column.post.title', name: 'title', change: { kind: 'alter' }, type: 'string', nullable: false, unique: false, index: false })
    })
    const blogModel = entryFor(planImpact(blog, sources()), 'model.post')

    expect(rootEntry.consumers.map((consumer) => consumer.name)).not.toContain('BlogPostController.show')
    expect(entryFor(planImpact(blog, sources()), 'column.post.title').consumers.map((consumer) => consumer.name)).toEqual(['BlogPostController.show'])
    expect(blogModel.consumers.map((consumer) => `${consumer.kind} ${consumer.name}`)).toEqual([
      'route blog.posts.show',
      'apiRoute blog.posts.show',
      'action BlogPostController.show',
      'test modules/blog/tests/PostController.test.ts',
    ])
  })

  test('should hang the relationships, bound routes, resource, policy, mentioning actions and tests off an altered model', () => {
    const entry = entryFor(planImpact(plan(), sources()), 'model.post')

    expect(entry.consumers.map((consumer) => `${consumer.kind} ${consumer.name}`)).toEqual([
      'model User.posts',
      'route posts.show',
      'apiRoute posts.show',
      'test tests/PostController.test.ts',
      'resource PostResource',
      'policy PostPolicy',
      'action PostController.show',
    ])
  })

  test('should add the pages reading a dropped model, which an alter does not reach', () => {
    const dropped = plan((input) => {
      input.models[0]!.change = { kind: 'drop', reason: 'gone' }
    })

    const kinds = entryFor(planImpact(dropped, sources()), 'model.post').consumers.map((consumer) => consumer.kind)

    expect(kinds).toContain('page')
    expect(entryFor(planImpact(plan(), sources()), 'model.post').consumers.map((consumer) => consumer.kind)).not.toContain('page')
  })

  test('should list the route, its ApiRoutes entry and its agent tool for an altered action', () => {
    const altered = plan((input) => {
      input.controllers.push({
        id: 'controller.posts',
        change: { kind: 'existing' },
        className: 'PostController',
        actions: [
          {
            id: 'action.posts.update',
            change: { kind: 'alter' },
            name: 'update',
            authorization: { middleware: [] },
            response: { kind: 'empty' },
            rules: [],
          },
        ],
      })
    })

    const entry = entryFor(planImpact(altered, sources()), 'action.posts.update')

    expect(entry.consumers).toEqual([
      { kind: 'route', name: 'posts.update' },
      { kind: 'apiRoute', name: 'posts.update' },
      { kind: 'agentTool', name: 'posts_update' },
      { kind: 'test', name: 'tests/PostController.test.ts', file: 'tests/PostController.test.ts' },
    ])
  })

  test('should find a renamed route by its old name, and an unnamed one by method and path', () => {
    const renamed = plan((input) => {
      input.routes[0]!.change = { kind: 'rename', from: 'posts.update' }
      input.routes[1]!.change = { kind: 'alter' }
      input.routes[1]!.method = 'GET'
      input.routes[1]!.path = '/feed'
    })

    const entries = planImpact(renamed, sources())

    expect(entryFor(entries, 'route.comments.store').consumers.map((consumer) => consumer.kind)).toEqual(['route', 'apiRoute', 'agentTool', 'test'])
    expect(entryFor(entries, 'route.comments.destroy').consumers).toEqual([{ kind: 'route', name: 'GET /feed' }])
  })

  test('should note a reader that could not run instead of reporting nothing for it', () => {
    const renamed = plan((input) => {
      input.routes[0]!.change = { kind: 'rename', from: 'posts.update' }
    })

    const entry = entryFor(planImpact(renamed, sources({ routes: [], unreadable: { routes: 'routes/web.ts threw' } })), 'route.comments.store')

    expect(entry).toMatchObject({ consumers: [], notes: [{ key: 'impact.unreadable.routes', values: { reason: 'routes/web.ts threw' } }] })
  })

  describe('test requests', () => {
    const REQUEST = { file: 'tests/posts.test.ts', line: 14, text: 'PATCH /posts/${…}' }
    const alteredUpdate = (change: PlanChange = { kind: 'alter' }): PlanDraft => plan((input) => {
      input.routes[0]!.change = change
      input.routes[0]!.name = 'posts.update'
    })
    const withTests = (overrides: Partial<PlanImpactSources> = {}): PlanImpactSources => {
      const base = sources(overrides)
      base.routes[1] = { ...base.routes[1]!, tests: [REQUEST, { ...REQUEST, line: 30 }] }
      return base
    }

    test('should list each test file whose TestApp request reaches a changed route, once, at its first request', () => {
      const entry = entryFor(planImpact(alteredUpdate(), withTests()), 'route.comments.store')

      expect(entry.consumers.filter((consumer) => consumer.kind === 'testRequest')).toEqual([
        { kind: 'testRequest', name: 'PATCH /posts/${…}', file: 'tests/posts.test.ts', line: 14, via: 'posts.update' },
      ])
      expect(entry.notes).toEqual([])
    })

    test('should say no TestApp request reaches an altered route beside a test named after its controller, which may reach the action directly', () => {
      const entry = entryFor(planImpact(alteredUpdate(), sources()), 'route.comments.store')

      expect(entry.consumers).toContainEqual({ kind: 'test', name: 'tests/PostController.test.ts', file: 'tests/PostController.test.ts' })
      expect(entry.notes).toEqual([{ key: 'impact.testRequests.noneReach', values: {} }])
    })

    test('should hold the note back while an unmatched request of the same method might reach the route, and only then', () => {
      const unresolved = (method: string) => ({ unresolved: [{ ...REQUEST, reason: 'dynamicPath' as const, method }], unparsed: [] })

      expect(entryFor(planImpact(alteredUpdate(), sources({ testRequests: unresolved('PATCH') })), 'route.comments.store').notes).toEqual([
        { key: 'impact.testRequests.unresolved', values: { count: '1', requests: 'tests/posts.test.ts:14' } },
      ])
      expect(entryFor(planImpact(alteredUpdate(), sources({ testRequests: unresolved('POST') })), 'route.comments.store').notes).toEqual([
        { key: 'impact.testRequests.noneReach', values: {} },
      ])
    })

    test("should hold it back for a request the route's own pattern could not be compared with", () => {
      const base = sources()
      base.routes[1] = { ...base.routes[1]!, uncertainTests: [{ ...REQUEST, reason: 'routePattern', method: 'PATCH' }] }
      const unresolved = { unresolved: [{ ...REQUEST, line: 40, reason: 'dynamicPath' as const, method: 'PATCH' }], unparsed: [] }

      expect(entryFor(planImpact(alteredUpdate(), base), 'route.comments.store').notes).toEqual([
        { key: 'impact.testRequests.uncertain', values: { count: '1', requests: 'tests/posts.test.ts:14' } },
      ])
      expect(entryFor(planImpact(alteredUpdate(), { ...base, testRequests: unresolved }), 'route.comments.store').notes).toEqual([
        { key: 'impact.testRequests.unresolved', values: { count: '1', requests: 'tests/posts.test.ts:40' } },
        { key: 'impact.testRequests.uncertain', values: { count: '1', requests: 'tests/posts.test.ts:14' } },
      ])
    })

    test('should give a request an earlier route may answer first a note of its own', () => {
      const base = sources()
      base.routes[1] = { ...base.routes[1]!, uncertainTests: [{ ...REQUEST, reason: 'routeOrder', method: 'PATCH' }] }

      expect(entryFor(planImpact(alteredUpdate(), base), 'route.comments.store').notes).toEqual([
        { key: 'impact.testRequests.order', values: { count: '1', requests: 'tests/posts.test.ts:14' } },
      ])
    })

    test('should keep both notes for a request uncertain on two routes of one entry for different reasons', () => {
      const base = sources()
      base.routes[0] = { ...base.routes[0]!, uncertainTests: [{ ...REQUEST, reason: 'routePattern', method: 'GET' }] }
      base.routes.push({ ...base.routes[0]!, name: 'posts.preview', path: '/posts/:post/preview', uncertainTests: [{ ...REQUEST, reason: 'routeOrder', method: 'GET' }] })
      const notes = entryFor(planImpact(plan(), base), 'model.post').notes.filter((note) => note.key.startsWith('impact.testRequests.'))

      expect(notes).toEqual([
        { key: 'impact.testRequests.uncertain', values: { count: '1', requests: 'tests/posts.test.ts:14' } },
        { key: 'impact.testRequests.order', values: { count: '1', requests: 'tests/posts.test.ts:14' } },
      ])
    })

    test('should not say it of a renamed route, whose paths the tests still reach', () => {
      const entry = entryFor(planImpact(alteredUpdate({ kind: 'rename', from: 'posts.update' }), sources()), 'route.comments.store')

      expect(entry.notes).toEqual([])
    })

    test('should reach a model through the routes that bind it', () => {
      const base = sources()
      base.routes[0] = { ...base.routes[0]!, tests: [REQUEST] }
      const entry = entryFor(planImpact(plan(), base), 'model.post')

      expect(entry.consumers).toContainEqual({ kind: 'testRequest', name: 'PATCH /posts/${…}', file: 'tests/posts.test.ts', line: 14, via: 'posts.show' })
    })
  })

  test('should reach an altered view and a validator through the actions that name them', () => {
    const altered = plan((input) => {
      input.validators.push({ id: 'validator.post', change: { kind: 'drop', reason: 'merged' }, name: 'PostPayloadSchema', fields: [] })
    })

    const entries = planImpact(altered, sources())

    expect(entryFor(entries, 'view.posts.show').consumers.map((consumer) => `${consumer.kind} ${consumer.name}`)).toEqual([
      'action PostController.show',
      'route posts.show',
      'apiRoute posts.show',
      'test tests/PostController.test.ts',
    ])
    expect(entryFor(entries, 'validator.post').consumers.map((consumer) => `${consumer.kind} ${consumer.name}`)).toEqual([
      'action FeedController.index',
      'route GET /feed',
    ])
  })
})

describe('the breaking rule beside Impact', () => {
  test('should flag a column type change even when Impact found no reader', () => {
    const altered = withTitleColumn({ kind: 'alter' })

    expect(planImpact(altered, sources({ reads: NO_READS })).find((entry) => entry.elementId === 'column.post.title')?.consumers).toEqual([])
    expect(planBreakingChanges(altered)).toContainEqual(expect.objectContaining({ elementId: 'column.post.title', reasonKey: 'breaking.columnAltered' }))
  })

  test("should flag an altered route whose application route publishes a tool the plan does not declare", () => {
    const altered = plan((input) => {
      input.routes[0]!.change = { kind: 'alter' }
      input.routes[0]!.name = 'posts.update'
    })
    const impact = planImpact(altered, sources())

    expect(impactBreakingChanges(altered, impact, planBreakingChanges(altered))).toEqual([
      {
        elementId: 'route.comments.store',
        section: 'routes',
        title: 'posts.update',
        reasonKey: 'breaking.agentToolChanges',
        reasonValues: { tool: 'posts_update' },
      },
    ])
  })

  test('should not flag it twice when the plan already declares the tool', () => {
    const altered = plan((input) => {
      input.routes[0]!.change = { kind: 'alter' }
      input.routes[0]!.name = 'posts.update'
      input.routes[0]!.agent = { toolName: 'posts_update', readOnly: false }
    })
    const already = planBreakingChanges(altered)

    expect(already.map((item) => item.elementId)).toEqual(['route.comments.store'])
    expect(impactBreakingChanges(altered, planImpact(altered, sources()), already)).toEqual([])
  })
})

describe('the plan page', () => {
  function impactOn(page: Page, id: string): PageNode | undefined {
    return page.byId(`el-${id}`).withClass('impact')[0]
  }

  test('should label what Impact found as a lower bound on the card it concerns', () => {
    const altered = withTitleColumn({ kind: 'drop', reason: 'unused' })
    const page = openPlanPage(renderPlanHtml({ plan: altered, impact: planImpact(altered, sources()) }))

    const note = impactOn(page, 'column.post.title')!
    expect(note.textContent).toContain('a lower bound')
    expect(note.withTag('li').map((item) => item.textContent)).toEqual([
      'PostResource reads it (app/Http/Resources/PostResource.ts:12)',
      'posts/Show reads it through PostResource (resources/js/pages/posts/Show.tsx:20)',
    ])
  })

  test('should say an empty list proves nothing, in either locale', () => {
    const altered = withTitleColumn({ kind: 'alter' })
    const impact = planImpact(altered, sources({ reads: NO_READS }))

    expect(impactOn(openPlanPage(renderPlanHtml({ plan: altered, impact })), 'column.post.title')!.textContent).toContain(
      'An empty list is not proof that nothing is affected.',
    )
    expect(impactOn(openPlanPage(renderPlanHtml({ plan: altered, impact, uiLocale: 'ja' })), 'column.post.title')!.textContent).toContain(
      '影響がないとは限りません',
    )
  })

  test('should name a test by the request that reaches the route, in either locale', () => {
    const altered = plan((input) => {
      input.routes[0]!.change = { kind: 'alter' }
      input.routes[0]!.name = 'posts.update'
    })
    const base = sources()
    base.routes[1] = { ...base.routes[1]!, tests: [{ file: 'tests/posts.test.ts', line: 14, text: 'PATCH /posts/1' }] }
    const impact = planImpact(altered, base)
    const items = (uiLocale?: 'ja') => impactOn(openPlanPage(renderPlanHtml({ plan: altered, impact, ...(uiLocale ? { uiLocale } : {}) })), 'route.comments.store')!
      .withTag('li').map((item) => item.textContent)

    expect(items()).toContain('Request PATCH /posts/1 reaches posts.update (tests/posts.test.ts:14)')
    expect(items('ja')).toContain('リクエスト PATCH /posts/1 が posts.update に届きます (tests/posts.test.ts:14)')
  })

  test('should draw no Impact at all when the page was rendered without an application', () => {
    const altered = withTitleColumn({ kind: 'alter' })
    const html = renderPlanHtml({ plan: altered })

    expect(planPageData(html).impact).toBeNull()
    expect(impactOn(openPlanPage(html), 'column.post.title')).toBeUndefined()
  })

  test('should pin a breaking change Impact found beside the ones the plan declares', () => {
    const altered = plan((input) => {
      input.routes[0]!.change = { kind: 'alter' }
      input.routes[0]!.name = 'posts.update'
    })
    const payload = planPageData(renderPlanHtml({ plan: altered, impact: planImpact(altered, sources()) }))

    expect(payload.breaking).toContainEqual(expect.objectContaining({ elementId: 'route.comments.store', reasonKey: 'breaking.agentToolChanges' }))
  })
})

describe('plan:render --app', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-plan-impact-cmd-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  test("should carry the column reads it scanned in the application's controllers", async () => {
    const document = plan()
    document.models[0]!.columns.push({ id: 'column.post.title', name: 'title', change: { kind: 'alter' }, type: 'text', nullable: false, unique: false, index: false })
    await writeWorkspaceFiles(join(workspace.dir, 'application'), {
      ...PLAN_APP_FILES,
      'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'
import { Post } from '../../Models/Post'

export class PostController extends Controller {
  async index() {}
  async show() {
    const post = await Post.findOrFail(1)
    return this.text(post.title)
  }
}
`,
    })
    await writeWorkspaceFiles(workspace.dir, { 'comments.plan.json': JSON.stringify(document) })

    await runCommand(builtinSubCommands['plan:render'], { rawArgs: ['comments.plan.json', '--app', 'application'] })

    const payload = planPageData(await readFile(join(workspace.dir, 'comments.plan.html'), 'utf8'))
    expect(payload.impact?.find((entry) => entry.elementId === 'column.post.title')?.consumers).toEqual([
      { kind: 'read', name: 'PostController.show', file: 'app/Http/Controllers/PostController.ts', line: 8 },
    ])
  })
})

describe('loadPlanAppState({ impact: true })', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-plan-impact-sources-')
  })

  afterEach(async () => {
    await chmod(join(workspace.dir, 'app/Http/Controllers'), 0o755).catch(() => {})
    await chmod(join(workspace.dir, 'app/Models'), 0o755).catch(() => {})
    await workspace.cleanup()
  })

  test('should name a model file that yields no model class', async () => {
    await writeWorkspaceFiles(workspace.dir, { ...PLAN_APP_FILES, 'app/Models/Broken.ts': 'export class Broken extends {' })

    const impact = (await loadPlanAppState(workspace.dir, { impact: true })).impact!

    expect(impact.unparsedModels).toEqual(['app/Models/Broken.ts'])
    expect(impact.models.map((model) => model.className).sort()).toEqual(['Post', 'User'])
  })

  for (const [section, path] of [
    ['controllers', 'app/Http/Controllers/nested'],
    ['models', 'app/Models/nested'],
    ['resources', 'app/Http/Resources/nested'],
    ['policies', 'app/Policies/nested'],
    ['tests', 'tests/nested'],
  ] as const) {
    test.skipIf(!CAN_DENY_FILE_READS)(`should report an unreadable nested ${section} directory`, async () => {
      await writeWorkspaceFiles(workspace.dir, { ...PLAN_APP_FILES, [`${path}/Hidden.ts`]: 'export class Hidden {}' })
      const directory = join(workspace.dir, path)
      await chmod(directory, 0o000)
      try {
        const impact = (await loadPlanAppState(workspace.dir, { impact: true })).impact!
        expect(impact.unreadable[section]).toContain(path)
      } finally {
        await chmod(directory, 0o755)
      }
    })
  }

  test.skipIf(!CAN_DENY_FILE_READS)('should retain an unreadable nested validator section while loading impact', async () => {
    const path = 'app/Http/Validators/nested'
    await writeWorkspaceFiles(workspace.dir, { ...PLAN_APP_FILES, [`${path}/Hidden.ts`]: 'export const hidden = {}' })
    const directory = join(workspace.dir, path)
    await chmod(directory, 0o000)
    try {
      const state = await loadPlanAppState(workspace.dir, { impact: true })
      expect(state.validators).toEqual({ unreadable: expect.stringContaining(path) })
      expect(state.impact).toBeDefined()
    } finally {
      await chmod(directory, 0o755)
    }
  })

  test.skipIf(!CAN_DENY_FILE_READS)('should say the controllers directory would not open, rather than scan nothing in silence', async () => {
    await writeWorkspaceFiles(workspace.dir, PLAN_APP_FILES)
    await chmod(join(workspace.dir, 'app/Http/Controllers'), 0o000)

    const impact = (await loadPlanAppState(workspace.dir, { impact: true })).impact!

    expect(impact.unreadable.controllers).toContain('app/Http/Controllers would not open')
  })

  test("should hang the TestApp requests of the application's tests off the routes they reach", async () => {
    await linkWorkspaceCore(workspace.dir)
    await writeWorkspaceFiles(workspace.dir, {
      ...PLAN_VERIFY_APP_FILES,
      // The fixture's acceptance tests request comments.store too; this case reads one file's requests.
      'tests/comments.test.ts': '',
      'tests/comments-http.test.ts': `import { TestApp } from '@guren/testing'
import app from '../src/app'

const http = await TestApp.fromApp(app)
const postId = 1
await http.post(\`/posts/\${postId}/comments\`, { body: 'x' })
await http.get(String(postId))
`,
    })

    const impact = (await loadPlanAppState(workspace.dir, { impact: true })).impact!

    expect(impact.routes.find((route) => route.name === 'comments.store')?.tests).toEqual([
      { file: 'tests/comments-http.test.ts', line: 6, text: 'POST /posts/${…}/comments' },
    ])
    expect(impact.routes.find((route) => route.name === 'posts.index')?.tests).toBeUndefined()
    expect(impact.testRequests.unresolved).toEqual([{ file: 'tests/comments-http.test.ts', line: 7, text: 'GET <runtime>', reason: 'dynamicPath', method: 'GET' }])
  })

  test('should hang a request off the route registered first of the two its path matches, never off both', async () => {
    await linkWorkspaceCore(workspace.dir)
    await writeWorkspaceFiles(workspace.dir, {
      ...PLAN_VERIFY_APP_FILES,
      'tests/comments.test.ts': '',
      'routes/web.ts': `import type { Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/meetups/create', [PostController, 'index']).name('meetups.create')
  router.get('/meetups/:id', [PostController, 'show']).name('meetups.show')
}
`,
      'tests/meetups-http.test.ts': `import { TestApp } from '@guren/testing'
import app from '../src/app'

const http = await TestApp.fromApp(app)
await http.get('/meetups/create')
await http.get('/meetups/1')
`,
    })

    const impact = (await loadPlanAppState(workspace.dir, { impact: true })).impact!
    const route = (name: string): PlanImpactRoute | undefined => impact.routes.find((candidate) => candidate.name === name)

    expect(route('meetups.create')?.tests).toEqual([{ file: 'tests/meetups-http.test.ts', line: 5, text: 'GET /meetups/create' }])
    expect(route('meetups.show')?.tests).toEqual([{ file: 'tests/meetups-http.test.ts', line: 6, text: 'GET /meetups/1' }])
    expect(route('meetups.show')?.uncertainTests).toBeUndefined()
  })

  test('should carry a request a constrained route could not be checked against from the routes file to its note', async () => {
    await linkWorkspaceCore(workspace.dir)
    await writeWorkspaceFiles(workspace.dir, {
      ...PLAN_VERIFY_APP_FILES,
      'routes/web.ts': `import type { Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/posts/:id{[0-9]+}', [PostController, 'show']).name('posts.show')
}
`,
      'tests/posts-http.test.ts': `import { TestApp } from '@guren/testing'
import app from '../src/app'

const http = await TestApp.fromApp(app)
const id = 1
await http.get(\`/posts/\${id}\`)
`,
    })
    const altered = plan((input) => {
      input.routes[0]!.change = { kind: 'alter' }
      input.routes[0]!.name = 'posts.show'
    })

    const sources = (await loadPlanAppState(workspace.dir, { impact: true })).impact!
    const entry = entryFor(planImpact(altered, sources), 'route.comments.store')

    expect(sources.routes[0]?.uncertainTests).toEqual([{ file: 'tests/posts-http.test.ts', line: 6, text: 'GET /posts/${…}', reason: 'routePattern', method: 'GET' }])
    expect(entry.notes).toEqual([{ key: 'impact.testRequests.uncertain', values: { count: '1', requests: 'tests/posts-http.test.ts:6' } }])
  })

  test.skipIf(!CAN_DENY_FILE_READS)('should carry the models verdict the checks reached', async () => {
    await writeWorkspaceFiles(workspace.dir, PLAN_APP_FILES)
    await chmod(join(workspace.dir, 'app/Models'), 0o000)

    const impact = (await loadPlanAppState(workspace.dir, { impact: true })).impact!

    expect(impact.unreadable.models).toContain('app/Models would not open')
  })
})

describe('planChangesExisting', () => {
  /** The comments fixture with nothing existing changed: its one altered model and view are set back to `existing`. */
  function additive(edit: (draft: PlanDraft) => void = () => {}): PlanDraft {
    return plan((draft) => {
      draft.models[0]!.change = { kind: 'existing' }
      draft.views[0]!.change = { kind: 'existing' }
      draft.controllers.push({ id: 'controller.posts', change: { kind: 'existing' }, className: 'PostController', actions: [
        { id: 'action.posts.show', change: { kind: 'existing' }, name: 'show', authorization: { middleware: [] }, response: { kind: 'empty' }, rules: [] },
      ] })
      draft.resources.push({ id: 'resource.post', change: { kind: 'existing' }, name: 'PostResource', model: 'model.post', fields: [] })
      draft.policies.push({ id: 'policy.post', change: { kind: 'existing' }, name: 'PostPolicy', model: 'model.post', abilities: [] })
      draft.validators.push({ id: 'validator.post', change: { kind: 'existing' }, name: 'PostSchema', fields: [] })
      draft.routes.push({ id: 'route.posts.show', change: { kind: 'existing' }, method: 'GET', path: '/posts/:id', name: 'posts.show', action: 'action.posts.show', middleware: [], bind: [] })
      edit(draft)
    })
  }

  const CHANGES: PlanChange[] = [{ kind: 'alter' }, { kind: 'rename', from: 'Old' }, { kind: 'drop', reason: 'gone' }]
  const EDITS: Array<[string, (draft: PlanDraft, change: PlanChange) => void]> = [
    ['a model', (draft, change) => { draft.models[0]!.change = change }],
    ['a column', (draft, change) => { draft.models[0]!.columns[0]!.change = change }],
    ['a validator', (draft, change) => { draft.validators.at(-1)!.change = change }],
    ['a controller', (draft, change) => { draft.controllers.at(-1)!.change = change }],
    ['an action', (draft, change) => { draft.controllers.at(-1)!.actions[0]!.change = change }],
    ['a route', (draft, change) => { draft.routes.at(-1)!.change = change }],
    ['a view', (draft, change) => { draft.views[0]!.change = change }],
    ['a resource', (draft, change) => { draft.resources.at(-1)!.change = change }],
    ['a policy', (draft, change) => { draft.policies.at(-1)!.change = change }],
  ]

  test('should find nothing existing changed in a plan that only adds and references', () => {
    expect(planChangesExisting(additive())).toBe(false)
  })

  test("should count a renamed table under an unchanged class", () => {
    expect(planChangesExisting(additive((draft) => { draft.models[0]!.tableRenamedFrom = 'articles' }))).toBe(true)
  })

  for (const [what, edit] of EDITS) {
    for (const change of CHANGES) {
      test(`should count ${what} whose change is ${change.kind}`, () => {
        expect(planChangesExisting(additive((draft) => edit(draft, change)))).toBe(true)
      })
    }
  }
})
