import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCommand } from 'citty'

import { runCheck } from '../src/check'
import { gatingResults } from '../src/check-result'
import { builtinSubCommands } from '../src/commands'
import { loadDocsGraph } from '../src/docs-graph'
import { planCloseFile, type PlanCloseReport } from '../src/plan-close'
import { planStatusFile } from '../src/plan-status'
import { loadPlanAppState } from '../src/plan/app-state'
import { planApprovalsPath } from '../src/plan/approvals'
import { writePlanWaiver } from '../src/plan/decisions'
import { planHash } from '../src/plan/identity'
import { PlanSchema, listPlanElements } from '../src/plan/schema'
import { PLAN_STATE_VERSION, planDigest, planSlug, planStatePath, type PlanStepRecord } from '../src/plan/state'
import { PLAN_STATUS_SECTIONS } from '../src/plan/status'
import { derivePlanTasks } from '../src/plan/tasks'
import { hashFiles } from '../src/plan/verification'
import { writeWorkspaceFiles } from './helpers'
import { loadApprovedCommentsPlan, planAppState, writePlanVerifyApp } from './plan-fixture'

// `bun test` fires no exit handler, so the roots earlier runs left are removed at the start.
// Each application has a directory of its own: Bun keys an imported routes file on its path.
const ROOT_PREFIX = 'guren-plan-close-'
let ROOT: string

const PLAN_FILE = 'comments.plan.json'
const APPROVED_AT = '2026-09-22T09:00:00.000Z'
const WAIVED_AT = '2026-09-22T10:00:00.000Z'

type PlanDocument = Record<string, unknown>

/** The ids plan:close judges: every element outside `existing` in a section plan:status reads. */
const JUDGED_SECTIONS = new Set<string>(PLAN_STATUS_SECTIONS)

function judgedIds(document: PlanDocument): string[] {
  const plan = PlanSchema.parse(document)
  const existing = new Set(
    [...plan.models, ...plan.models.flatMap((model) => model.columns), ...plan.controllers, ...plan.controllers.flatMap((controller) => controller.actions), ...plan.routes, ...plan.views, ...plan.resources, ...plan.policies, ...plan.validators]
      .filter((element) => element.change.kind === 'existing')
      .map((element) => element.id),
  )
  return listPlanElements(plan)
    .filter((element) => JUDGED_SECTIONS.has(element.section) && !existing.has(element.id))
    .map((element) => element.id)
}

/**
 * An application with the comments plan approved at `document`'s hash and every judged
 * element waived except `open`, through the same records plan:approve and plan:waive write.
 */
async function createClosableApp(name: string, options: { document?: PlanDocument; open?: string[]; approve?: boolean } = {}): Promise<{ dir: string; plan: string }> {
  const dir = join(ROOT, name)
  await writePlanVerifyApp(dir)
  const document = options.document ?? loadApprovedCommentsPlan()
  const plan = join(dir, PLAN_FILE)
  await writeFile(plan, JSON.stringify(document), 'utf8')
  await approveAndWaive(plan, document, options)
  return { dir, plan }
}

async function approveAndWaive(plan: string, document: PlanDocument, options: { open?: string[]; approve?: boolean } = {}): Promise<void> {
  const hash = planHash(PlanSchema.parse(document))
  if (options.approve !== false) {
    await writeFile(planApprovalsPath(plan), JSON.stringify({ approvalsVersion: 1, approvals: [{ hash, approvedAt: APPROVED_AT, approvedBy: 'Ada <ada@example.com>' }] }), 'utf8')
  }
  const open = new Set(options.open ?? [])
  for (const id of judgedIds(document)) {
    if (!open.has(id)) await writePlanWaiver(plan, { elementId: id, planHash: hash, reason: 'accepted as built', at: WAIVED_AT })
  }
}

describe('plan:close', () => {
  const log = spyOn(console, 'log')

  beforeAll(async () => {
    const stale = (await readdir(tmpdir())).filter((entry) => entry.startsWith(ROOT_PREFIX))
    await Promise.all(stale.map((entry) => rm(join(tmpdir(), entry), { recursive: true, force: true })))
    ROOT = await mkdtemp(join(tmpdir(), ROOT_PREFIX))
  })

  afterEach(() => {
    log.mockReset()
    process.exitCode = 0
  })

  afterAll(() => {
    log.mockRestore()
  })

  async function run(command: 'plan:close' | 'check', rawArgs: string[]): Promise<string> {
    log.mockClear()
    log.mockImplementation(() => {})
    await (command === 'check' ? runCommand(builtinSubCommands.check, { rawArgs }) : runCommand(builtinSubCommands['plan:close'], { rawArgs }))
    return log.mock.calls.map((call) => String(call[0])).join('\n')
  }

  async function close(app: { dir: string; plan: string }, ...flags: string[]): Promise<PlanCloseReport> {
    return JSON.parse(await run('plan:close', [app.plan, '--app', app.dir, '--json', ...flags])) as PlanCloseReport
  }

  const read = (dir: string, path: string): Promise<string> => readFile(join(dir, path), 'utf8')

  test('should refuse a plan that was never approved at its current hash, and write nothing', async () => {
    const app = await createClosableApp('unapproved', { approve: false })

    await expect(close(app)).rejects.toThrow(/is not approved at its current hash/u)
    await expect(readdir(join(app.dir, 'docs'))).rejects.toThrow()
  })

  test('should refuse a draft, which has no hash anyone approved', async () => {
    const app = await createClosableApp('draft', { approve: false })
    const { baseline: _baseline, ...draft } = loadApprovedCommentsPlan()
    await writeFile(app.plan, JSON.stringify(draft), 'utf8')

    await expect(close(app)).rejects.toThrow(/is a draft/u)
  })

  test('should refuse while an element is neither verified nor waived, naming it, and write nothing', async () => {
    const app = await createClosableApp('open', { open: ['view.posts.show', 'policy.comment'] })

    const error = await close(app).then(
      () => new Error('plan:close did not refuse'),
      (caught: unknown) => caught as Error,
    )

    expect(error).toBeInstanceOf(Error)
    expect(error.message).not.toContain('did not refuse')
    expect(error.message).toContain('view.posts.show: ')
    expect(error.message).toContain('policy.comment: ')
    expect(error.message).not.toContain('model.comment:')
    await expect(readdir(join(app.dir, 'docs'))).rejects.toThrow()
  })

  test('should write the plan doc node and one entity document per touched model', async () => {
    const app = await createClosableApp('writes')

    const report = await close(app)

    expect(report.writes.map((write) => [write.path, write.action])).toEqual([
      ['docs/plans/comments.md', 'create'],
      ['docs/entities/Post.md', 'create'],
      ['docs/entities/Comment.md', 'create'],
    ])
    const planDoc = await read(app.dir, 'docs/plans/comments.md')
    expect(planDoc).toStartWith('---\ntype: plan\nentities: [Post, Comment]\nclosed: true\n')
    expect(planDoc).toContain(`plan_hash: ${report.plan.hash}`)
    expect(planDoc).toContain('  - by: "human:Ada <ada@example.com>"')
    expect(planDoc).toContain('[comments.plan.json](../../comments.plan.json)')
    expect(planDoc).toContain("- A user cannot delete someone else's comment. (AC-comments-4)")
    expect(planDoc).toContain('- Waived `view.posts.show`: accepted as built (2026-09-22T10:00:00.000Z)')

    const comment = await read(app.dir, 'docs/entities/Comment.md')
    expect(comment).toStartWith('---\ntype: entity\nentities: [Comment]\n')
    expect(comment).toContain(`<!-- guren:plan comments ${report.plan.hash} rules -->`)
    expect(comment).toContain("- The comment's author is the signed-in user. (AC-comments-1, AC-comments-2, AC-comments-3)")
    expect(comment).toContain('- The signed-in user wrote the comment. (AC-comments-4)')
    expect(comment).toContain('- [Comments on posts](../plans/comments.md): closed plan')
    expect(report.adrCommands).toContain("guren make:adr 'Comments on posts: model.comment waived'")
  })

  test('should write headings and labels in the plan locale, under the heading check --docs reads rules from', async () => {
    const app = await createClosableApp('ja', { document: { ...loadApprovedCommentsPlan(), locale: 'ja' } })

    await close(app)

    const planDoc = await read(app.dir, 'docs/plans/comments.md')
    expect(planDoc).toContain('## スコープ\n\n目標:')
    expect(planDoc).toContain('## 関連エンティティ')
    expect(planDoc).not.toContain('undefined')
    const comment = await read(app.dir, 'docs/entities/Comment.md')
    expect(comment).toContain('## ルール\n\n<!-- guren:plan comments ')
    expect(comment).toContain('- 免除 `model.comment`: accepted as built')
    expect(comment).toContain('): 完了したプラン `')
    expect(comment).not.toContain('undefined')
    const output = await run('check', ['--docs', '--json', '--app', app.dir])
    const checks = (JSON.parse(output) as { checks: Array<{ key: string; status: string }> }).checks
    expect(checks.filter((check) => check.status !== 'pass')).toEqual([])
  })

  test('should write nothing under --dry-run and print what it would write', async () => {
    const app = await createClosableApp('dry-run')

    const text = await run('plan:close', [app.plan, '--app', app.dir, '--dry-run'])

    expect(text).toContain('would create  docs/entities/Comment.md')
    expect(text).toContain('--- docs/plans/comments.md')
    expect(text).toContain('Nothing was written (--dry-run).')
    await expect(readdir(join(app.dir, 'docs'))).rejects.toThrow()
  })

  test('should leave every file byte for byte the same on a second run', async () => {
    const app = await createClosableApp('rerun')
    await close(app)
    const first = await Promise.all(['docs/plans/comments.md', 'docs/entities/Comment.md', 'docs/entities/Post.md'].map((path) => read(app.dir, path)))

    const again = await close(app)

    expect(again.writes.map((write) => write.action)).toEqual(['unchanged', 'unchanged', 'unchanged'])
    expect(await Promise.all(['docs/plans/comments.md', 'docs/entities/Comment.md', 'docs/entities/Post.md'].map((path) => read(app.dir, path)))).toEqual(first)
  })

  test('should keep what a person wrote outside the markers, and replace the blocks when a revision closes', async () => {
    const app = await createClosableApp('hand-written')
    const handWritten = [
      '---',
      'type: entity',
      'entities: [Comment]',
      'owner: team-social',
      '---',
      '',
      '# Comment',
      '',
      'Comments are the only user text shown to guests.',
      '',
      '## Rules',
      '',
      '- A comment is never edited in place. (AC-comments-1)',
      '',
      '## Glossary',
      '',
      'An author is the user who wrote the comment.',
      '',
    ].join('\n')
    await writeWorkspaceFiles(app.dir, { 'docs/entities/Comment.md': handWritten })

    await close(app)
    const revised = { ...loadApprovedCommentsPlan(), summary: 'Signed-in users comment on posts and delete their own.' }
    await writeFile(app.plan, JSON.stringify(revised), 'utf8')
    await approveAndWaive(app.plan, revised)
    const report = await close(app)

    const comment = await read(app.dir, 'docs/entities/Comment.md')
    const outside = comment.replace(/\n?<!-- guren:plan [\s\S]*?<!-- \/guren:plan \S+ \S+ -->\n?/gu, '')
    expect(outside).toContain(handWritten.slice(0, handWritten.indexOf('## Glossary')).trimEnd())
    expect(outside).toContain('## Glossary\n\nAn author is the user who wrote the comment.')
    expect(comment.match(/<!-- guren:plan comments \S+ rules -->/gu)).toEqual([`<!-- guren:plan comments ${report.plan.hash} rules -->`])
    // Inserted under the person's own Rules heading, not under a second one.
    expect(comment.match(/^## Rules$/gmu)).toHaveLength(1)
    expect(comment.indexOf('<!-- guren:plan comments')).toBeLessThan(comment.indexOf('## Glossary'))
    expect(report.notes).toEqual([])
  })

  test('should close with a verified element lifted by a plan:verify record, through the plan:status overlay', async () => {
    const plan = PlanSchema.parse(loadApprovedCommentsPlan())
    const probe = await createClosableApp('verified-probe')
    const before = await planStatusFile(probe.plan, { app: () => loadPlanAppState(probe.dir, { detail: true }) })
    // The one element the fixture app already completes, whatever the readers find of the rest.
    const element = before.elements.find((entry) => entry.change !== 'existing' && entry.state === entry.completesAt && entry.files.length > 0)!
    expect(element.id).toBe('column.comment.id')
    const app = await createClosableApp('verified', { open: [element.id] })
    const step = derivePlanTasks(plan, { apiOnly: false }).tasks.flatMap((task) => task.steps).find((entry) => entry.elementIds.includes(element.id))!
    const record: PlanStepRecord = {
      outcome: 'verified',
      planDigest: planDigest(plan),
      ranAt: '2026-09-22T11:00:00.000Z',
      durationMs: 1,
      commands: [],
      acceptance: [],
      incomplete: [],
      waived: [],
      fingerprint: {
        files: Object.fromEntries(await hashFiles(app.dir, element.files)),
        environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'test' },
      },
    }
    await writeWorkspaceFiles(app.dir, {
      '.guren/plans/comments.state.json': JSON.stringify({ stateVersion: PLAN_STATE_VERSION, steps: { [step.id]: record } }),
    })

    const report = await close(app)

    expect(await read(app.dir, 'docs/plans/comments.md')).toContain(`| \`${element.id}\` | add | verified |`)
    expect(report.waivers.map((waiver) => waiver.elementId)).not.toContain(element.id)
  })

  test('should leave output check --docs passes, with no warning either', async () => {
    const app = await createClosableApp('docs-check')
    await close(app)

    const output = await run('check', ['--docs', '--json', '--app', app.dir])
    const results = (JSON.parse(output) as { checks: Array<{ key: string; status: string; message: string }> }).checks

    expect(results.filter((result) => result.status !== 'pass')).toEqual([])
    expect(results.map((result) => result.key)).toContain('docs-cites:docs/entities/Comment.md:AC-comments-4')
  })

  test('should report an uncited rule without failing a gate: the citation warnings are advisory', async () => {
    const app = await createClosableApp('advisory')
    await close(app)
    const doc = await read(app.dir, 'docs/entities/Comment.md')
    await writeFile(join(app.dir, 'docs/entities/Comment.md'), doc.replace('## Rules\n', '## Rules\n\n- Nobody tests this.\n'), 'utf8')

    const report = await runCheck({ cwd: app.dir, docs: true })

    const uncited = report.checks.find((result) => result.key.startsWith('docs-rule-uncited:docs/entities/Comment.md'))
    expect(uncited).toMatchObject({ status: 'warn', advisory: true })
    expect(gatingResults(report)).toEqual([])
  })

  test('should draw each acceptance test as a node that verifies the documents citing it and its entity', async () => {
    const app = await createClosableApp('graph')
    await close(app)

    const { graph } = await loadDocsGraph(app.dir)

    expect(graph.nodes).toContainEqual({ id: 'test:AC-comments-4', kind: 'test', label: 'AC-comments-4' })
    const edges = graph.edges.filter((edge) => edge.from === 'test:AC-comments-4')
    expect(edges).toEqual([
      { from: 'test:AC-comments-4', to: 'docs/entities/Comment.md', relation: 'verifies', verdict: 'pass' },
      { from: 'test:AC-comments-4', to: 'docs/plans/comments.md', relation: 'verifies', verdict: 'pass' },
      { from: 'test:AC-comments-4', to: 'entity:Comment', relation: 'verifies', verdict: 'pass' },
    ])
    expect(graph.edges).toContainEqual({ from: 'docs/plans/comments.md', to: 'entity:Comment', relation: 'governs', verdict: 'pass' })
  })
  test('should refuse a drifted element, naming it', async () => {
    const plan = PlanSchema.parse(loadApprovedCommentsPlan())
    const app = await createClosableApp('drifted', { open: ['column.comment.id'] })
    const step = derivePlanTasks(plan, { apiOnly: false }).tasks.flatMap((task) => task.steps).find((entry) => entry.elementIds.includes('column.comment.id'))!
    const record: PlanStepRecord = {
      outcome: 'verified',
      planDigest: planDigest(plan),
      ranAt: '2026-09-22T11:00:00.000Z',
      durationMs: 1,
      commands: [],
      acceptance: [],
      incomplete: [],
      waived: [],
      fingerprint: { files: { 'app/Models/Comment.ts': 'not-the-hash' }, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'test' } },
    }
    await writeWorkspaceFiles(app.dir, { '.guren/plans/comments.state.json': JSON.stringify({ stateVersion: PLAN_STATE_VERSION, steps: { [step.id]: record } }) })

    await expect(close(app)).rejects.toThrow(/column\.comment\.id: drifted/u)
  })

  test('should refuse a blocked and an unjudged element, with the reason the reader gave', async () => {
    const app = await createClosableApp('blocked', { open: ['model.post', 'view.posts.show'] })

    // An application whose model section nobody could read, as a failed scan reports it.
    const error = await planCloseFile(app.plan, { app: planAppState(), appRoot: app.dir }).then(
      () => new Error('plan:close did not refuse'),
      (caught: unknown) => caught as Error,
    )

    expect(error.message).toMatch(/model\.post: blocked \(/u)
    expect(error.message).toMatch(/view\.posts\.show: unjudged \(/u)
  })

  test('should refuse when the state file or the decision log will not read', async () => {
    const state = await createClosableApp('state-unreadable')
    await writeWorkspaceFiles(state.dir, { '.guren/plans/comments.state.json': '{ not json' })
    await expect(close(state)).rejects.toThrow(/verification records: /u)

    const decisions = await createClosableApp('decisions-unreadable')
    await writeFile(join(decisions.dir, 'comments.decisions.json'), '{ not json', 'utf8')
    await expect(close(decisions)).rejects.toThrow(/decision log: /u)
  })

  test('should refuse, and write nothing, when a document carries markers it cannot rewrite safely', async () => {
    const cases: Record<string, string> = {
      unclosed: '# Comment\n\n## Rules\n\n<!-- guren:plan comments abc rules -->\n- A person\'s rule.\n\n## Glossary\n\nKept.\n',
      twice: '# Comment\n\n<!-- guren:plan comments abc rules -->\n- a\n<!-- /guren:plan comments rules -->\n\n<!-- guren:plan comments abc rules -->\n- b\n<!-- /guren:plan comments rules -->\n',
      fenced: '# Comment\n\n```md\n<!-- guren:plan comments abc rules -->\n```\n',
    }
    for (const [name, body] of Object.entries(cases)) {
      const app = await createClosableApp(`markers-${name}`)
      const document = `---\ntype: entity\nentities: [Comment]\n---\n\n${body}`
      await writeWorkspaceFiles(app.dir, { 'docs/entities/Comment.md': document })

      await expect(close(app)).rejects.toThrow(/docs\/entities\/Comment\.md, line \d+: /u)
      expect(await read(app.dir, 'docs/entities/Comment.md')).toBe(document)
      await expect(readdir(join(app.dir, 'docs/plans'))).rejects.toThrow()
    }
  })

  test('should keep a document\'s CRLF line endings', async () => {
    const app = await createClosableApp('crlf')
    const document = '---\r\ntype: entity\r\nentities: [Comment]\r\n---\r\n\r\n# Comment\r\n\r\n## Rules\r\n\r\n- Mine. (AC-comments-1)\r\n'
    await writeWorkspaceFiles(app.dir, { 'docs/entities/Comment.md': document })

    await close(app)

    const written = await read(app.dir, 'docs/entities/Comment.md')
    expect(written).toStartWith(document)
    expect(written.replaceAll('\r\n', '')).not.toContain('\n')
  })

  test('should refuse a model whose name or module would put its document outside the application', async () => {
    const document = loadApprovedCommentsPlan()
    const models = (document.models as Array<Record<string, unknown>>).map((model) => (model.id === 'model.comment' ? { ...model, module: '../../outside' } : model))
    const app = await createClosableApp('traversal', { document: { ...document, models } })

    await expect(close(app)).rejects.toThrow(/model\.comment: name "Comment", module "\.\.\/\.\.\/outside"/u)
    await expect(readdir(join(app.dir, 'docs'))).rejects.toThrow()
  })

  test('should give an entity the tasks that name it by table or by id, as the task derivation reads them', async () => {
    for (const entity of ['comments', 'model.comment']) {
      const document = loadApprovedCommentsPlan()
      const tasks = (document.tasks as Array<Record<string, unknown>>).map((task) => ({ ...task, entity }))
      const app = await createClosableApp(`entity-${entity.replace('.', '-')}`, { document: { ...document, tasks } })

      await close(app)

      expect(await read(app.dir, 'docs/entities/Comment.md')).toContain('## Purpose\n\n<!-- guren:plan comments ')
    }
  })

  test('should name a plan in the docs/plans/<slug>/plan.json layout by its directory, in its state and its documents', async () => {
    const dir = join(ROOT, 'layout')
    await writePlanVerifyApp(dir)
    const document = loadApprovedCommentsPlan()
    const plan = join(dir, 'docs/plans/comments/plan.json')
    await writeWorkspaceFiles(dir, { 'docs/plans/comments/plan.json': JSON.stringify(document) })
    await approveAndWaive(plan, document)

    const report = await close({ dir, plan })

    expect(report.writes.map((write) => write.path)).toContain('docs/plans/comments.md')
    expect(await read(dir, 'docs/plans/comments.md')).toContain('[plan.json](comments/plan.json)')
    expect(await read(dir, 'docs/entities/Comment.md')).toContain('<!-- guren:plan comments ')
    expect(planStatePath(dir, planSlug(plan))).toBe(join(dir, '.guren/plans/comments.state.json'))
  })
})
