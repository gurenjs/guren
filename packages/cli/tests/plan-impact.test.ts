import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runCommand } from 'citty'

import { builtinSubCommands } from '../src/commands'
import type { ColumnConsumerScan } from '../src/column-consumers'
import { impactBreakingChanges, planImpact, type PlanImpactEntry, type PlanImpactSources } from '../src/plan/impact'
import { planBreakingChanges, renderPlanHtml } from '../src/plan/render'
import { PlanDraftSchema, type PlanChange, type PlanDraft } from '../src/plan/schema'
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from './helpers'
import { loadCommentsPlan, PLAN_APP_FILES, planPageData } from './plan-fixture'
import { openPlanPage, type Page, type PageNode } from './plan-page-dom'

/** The comments fixture, parsed and then edited, so every section is present to edit. */
function plan(edit: (draft: PlanDraft) => void = () => {}): PlanDraft {
  const draft = PlanDraftSchema.parse(loadCommentsPlan())
  edit(draft)
  return draft
}

const NO_READS: ColumnConsumerScan = { reads: [], opaque: [], resources: [], unreadable: [] }

function sources(overrides: Partial<PlanImpactSources> = {}): PlanImpactSources {
  return {
    routes: [
      { name: 'posts.show', method: 'GET', path: '/posts/:post', action: 'PostController.show', bindings: { post: 'Post' } },
      { name: 'posts.update', method: 'PATCH', path: '/posts/:id', action: 'PostController.update', bindings: {}, toolName: 'posts_update' },
      { method: 'GET', path: '/feed', action: 'FeedController.index', bindings: {} },
    ],
    models: [
      { className: 'Post', module: null, file: 'app/Models/Post.ts', relationships: [] },
      { className: 'User', module: null, file: 'app/Models/User.ts', relationships: [{ name: 'posts', type: 'hasMany', relatedModel: 'Post' }] },
    ],
    actions: [
      { key: 'PostController.show', module: null, file: 'app/Http/Controllers/PostController.ts', pages: ['posts/Show'], calls: [], abilities: [], identifiers: ['Post', 'PostResource'], validates: [] },
      { key: 'FeedController.index', module: null, file: 'app/Http/Controllers/FeedController.ts', pages: [], calls: [], abilities: [], identifiers: ['PostPayloadSchema'], validates: [] },
    ],
    resources: [{ className: 'PostResource', file: 'app/Http/Resources/PostResource.ts', models: ['Post'] }],
    policies: [{ className: 'PostPolicy', module: null, file: 'app/Policies/PostPolicy.ts' }],
    tests: ['tests/PostController.test.ts', 'tests/UserController.test.ts'],
    reads: {
      ...NO_READS,
      reads: [
        { model: 'Post', property: 'title', kind: 'resource', file: 'app/Http/Resources/PostResource.ts', line: 12, where: 'PostResource' },
        { model: 'Post', property: 'title', kind: 'page', file: 'resources/js/pages/posts/Show.tsx', line: 20, where: 'posts/Show', via: 'PostResource' },
        { model: 'Post', property: 'body', kind: 'controller', file: 'app/Http/Controllers/PostController.ts', line: 9, where: 'PostController.show' },
        { model: 'User', property: 'title', kind: 'controller', file: 'app/Http/Controllers/UserController.ts', line: 4, where: 'UserController.show' },
      ],
    },
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

  test('should hang the relationships, bound routes, resource, policy, mentioning actions and tests off an altered model', () => {
    const entry = entryFor(planImpact(plan(), sources()), 'model.post')

    expect(entry.consumers.map((consumer) => `${consumer.kind} ${consumer.name}`)).toEqual([
      'model User.posts',
      'route posts.show',
      'apiRoute posts.show',
      'resource PostResource',
      'policy PostPolicy',
      'action PostController.show',
      'test tests/PostController.test.ts',
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

    expect(entryFor(entries, 'route.comments.store').consumers.map((consumer) => consumer.kind)).toEqual(['route', 'apiRoute', 'agentTool'])
    expect(entryFor(entries, 'route.comments.destroy').consumers).toEqual([{ kind: 'route', name: 'GET /feed' }])
  })

  test('should note a reader that could not run instead of reporting nothing for it', () => {
    const renamed = plan((input) => {
      input.routes[0]!.change = { kind: 'rename', from: 'posts.update' }
    })

    const entry = entryFor(planImpact(renamed, sources({ routes: { unreadable: 'routes/web.ts threw' } })), 'route.comments.store')

    expect(entry).toMatchObject({ consumers: [], notes: [{ key: 'impact.unreadable', values: { reader: 'routes', reason: 'routes/web.ts threw' } }] })
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
