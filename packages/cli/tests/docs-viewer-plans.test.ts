import { describe, expect, it } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readPlanOverview, readViewerPlans } from '../src/docs-viewer-plans'
import { discoverPlanFiles } from '../src/plan-check'
import { planHash } from '../src/plan/identity'
import { renderedPlanHash, renderPlanHtml } from '../src/plan/render'
import { PlanDraftSchema, PlanSchema } from '../src/plan/schema'
import { PLAN_STATE_VERSION, planDigest, type PlanStepRecord } from '../src/plan/state'
import { derivePlanTasks, listPlanSteps } from '../src/plan/tasks'
import { hashFiles } from '../src/plan/verification'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'
import { approvePlanFile, loadApprovedCommentsPlan, loadCommentsPlan } from './plan-fixture'

function record(plan: Parameters<typeof planDigest>[0], files: Record<string, string>, outcome: PlanStepRecord['outcome'] = 'verified'): PlanStepRecord {
  return {
    outcome,
    planDigest: planDigest(plan),
    ranAt: '2026-09-27T10:00:00.000Z',
    durationMs: 1,
    commands: [],
    acceptance: [],
    incomplete: [],
    waived: [],
    fingerprint: { files, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'test' } },
  }
}

/** The plans as the viewer's payload reads them: discovery shared with the page lookup. */
async function readPlans(dir: string): ReturnType<typeof readViewerPlans> {
  return readViewerPlans(dir, (await discoverPlanFiles(dir)).files)
}

describe('readViewerPlans', () => {
  it('shows a draft with every step not run and the commands that approve it', async () => {
    const workspace = await createTempWorkspace('guren-cli-viewer-plans-draft-')
    try {
      await writeWorkspaceFiles(workspace.dir, { 'docs/plans/comments.plan.json': JSON.stringify(loadCommentsPlan()) })

      const { open, hashes } = await readPlans(workspace.dir)

      expect(open).toHaveLength(1)
      const [plan] = open
      expect(plan.standing).toBe('draft')
      expect(plan.entities).toEqual(['Post', 'Comment'])
      expect(plan.steps.length).toBeGreaterThan(0)
      expect(plan.steps.every((step) => step.state === 'not-run')).toBe(true)
      expect(plan.next).toEqual([
        'bunx guren plan:render docs/plans/comments.plan.json',
        'bunx guren plan:approve docs/plans/comments.plan.json',
      ])
      expect(plan.status).toBe('bunx guren plan:status docs/plans/comments.plan.json')
      expect(hashes.get('docs/plans/comments.plan.json')).toBeNull()
    } finally {
      await workspace.cleanup()
    }
  })

  it('reads each step from its record: verified, drifted with its files, and the marked step with its stall', async () => {
    const workspace = await createTempWorkspace('guren-cli-viewer-plans-approved-')
    try {
      const dir = workspace.dir
      const document = loadApprovedCommentsPlan()
      const path = join(dir, 'docs/plans/comments.plan.json')
      await writeWorkspaceFiles(dir, {
        'docs/plans/comments.plan.json': JSON.stringify(document),
        'app/Models/Comment.ts': 'export class Comment {}\n',
        'app/Models/Post.ts': 'export class Post {}\n',
      })
      await approvePlanFile(path)
      const plan = PlanSchema.parse(document)
      const [first, second, third, fourth, fifth] = listPlanSteps(derivePlanTasks(plan, { apiOnly: false })).map(({ step }) => step.id)
      const hashes = await hashFiles(dir, ['app/Models/Comment.ts'])
      await writeWorkspaceFiles(dir, {
        '.guren/plans/comments.state.json': JSON.stringify({
          stateVersion: PLAN_STATE_VERSION,
          steps: {
            [first]: record(plan, { 'app/Models/Comment.ts': hashes.get('app/Models/Comment.ts')! }),
            [second]: record(plan, { 'app/Models/Post.ts': 'not-the-hash' }),
            [fourth]: record(plan, {}, 'failed'),
            [fifth]: { ...record(plan, {}), planDigest: 'an-earlier-version' },
          },
          active: {
            plan: 'docs/plans/comments.plan.json',
            step: third,
            startedAt: '2026-09-27T10:00:00.000Z',
            continuations: 3,
            stalled: { at: '2026-09-27T10:30:00.000Z', reason: 'three continuations' },
          },
        }),
      })

      const [read] = (await readPlans(dir)).open

      expect(read.standing).toBe('approved')
      expect(read.approval?.by).toBe('Ada <ada@example.com>')
      const byId = new Map(read.steps.map((step) => [step.id, step]))
      expect(byId.get(first)?.state).toBe('verified')
      expect(byId.get(second)?.state).toBe('drifted')
      expect(byId.get(second)?.changed).toEqual(['app/Models/Post.ts'])
      expect(byId.get(third)).toMatchObject({ state: 'not-run', active: true, stall: { reason: 'three continuations' } })
      expect(byId.get(fourth)?.state).toBe('failed')
      expect(byId.get(fifth)?.state).toBe('outdated')
      expect(read.next).toEqual(['bunx guren plan:next docs/plans/comments.plan.json'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('leaves out a plan closed at its current hash, and keeps its hash for the page check', async () => {
    const workspace = await createTempWorkspace('guren-cli-viewer-plans-closed-')
    try {
      const dir = workspace.dir
      const document = loadApprovedCommentsPlan()
      const hash = planHash(PlanSchema.parse(document))
      await writeWorkspaceFiles(dir, {
        'docs/plans/comments/plan.json': JSON.stringify(document),
        'docs/plans/comments.md': `---\ntype: plan\nclosed: true\nplan_hash: ${hash}\n---\n\n# Comments\n`,
      })

      const { open, hashes } = await readPlans(dir)

      expect(open).toEqual([])
      expect(hashes.get('docs/plans/comments/plan.json')).toBe(hash)
    } finally {
      await workspace.cleanup()
    }
  })

  it('drops a stall the approval gate recorded once the plan is approved, as plan:next does', async () => {
    const workspace = await createTempWorkspace('guren-cli-viewer-plans-stall-')
    try {
      const dir = workspace.dir
      const document = loadApprovedCommentsPlan()
      await writeWorkspaceFiles(dir, { 'docs/plans/comments.plan.json': JSON.stringify(document) })
      await approvePlanFile(join(dir, 'docs/plans/comments.plan.json'))
      const [first] = listPlanSteps(derivePlanTasks(PlanSchema.parse(document), { apiOnly: false })).map(({ step }) => step.id)
      await writeWorkspaceFiles(dir, {
        '.guren/plans/comments.state.json': JSON.stringify({
          stateVersion: PLAN_STATE_VERSION,
          steps: {},
          active: {
            plan: 'docs/plans/comments.plan.json',
            step: first,
            startedAt: '2026-09-27T10:00:00.000Z',
            continuations: 0,
            stalled: { at: '2026-09-27T10:05:00.000Z', reason: 'not approved at this hash', cause: 'approval' },
          },
        }),
      })

      const [read] = (await readPlans(dir)).open

      const step = read.steps.find((entry) => entry.id === first)
      expect(step?.active).toBe(true)
      expect(step?.stall).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports a plan file it cannot read as unreadable, beside the plans it can', async () => {
    const workspace = await createTempWorkspace('guren-cli-viewer-plans-unreadable-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'docs/plans/broken.plan.json': '{ not json',
        'docs/plans/comments.plan.json': JSON.stringify(loadCommentsPlan()),
      })

      const { open } = await readPlans(workspace.dir)

      expect(open.map((plan) => [plan.file, plan.standing])).toEqual([
        ['docs/plans/broken.plan.json', 'unreadable'],
        ['docs/plans/comments.plan.json', 'draft'],
      ])
      expect(open[0].reason).toBeDefined()
      expect(open[0].next).toEqual([])
    } finally {
      await workspace.cleanup()
    }
  })

  it('asks for approval again once the plan changed since its approval', async () => {
    const workspace = await createTempWorkspace('guren-cli-viewer-plans-unapproved-')
    try {
      const dir = workspace.dir
      const path = join(dir, 'docs/plans/comments.plan.json')
      const document = loadApprovedCommentsPlan()
      await writeWorkspaceFiles(dir, { 'docs/plans/comments.plan.json': JSON.stringify(document) })
      await approvePlanFile(path)
      await writeFile(path, JSON.stringify({ ...document, title: 'Comments, revised' }))

      const [read] = (await readPlans(dir)).open

      expect(read.standing).toBe('unapproved')
      expect(read.next).toEqual(['bunx guren plan:approve docs/plans/comments.plan.json'])
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('renderedPlanHash', () => {
  it('reads back the hash renderPlanHtml embeds, so a template change cannot make every page read fresh', () => {
    const plan = PlanSchema.parse(loadApprovedCommentsPlan())
    expect(renderedPlanHash(renderPlanHtml({ plan }))).toBe(planHash(plan))
    expect(renderedPlanHash(renderPlanHtml({ plan: PlanDraftSchema.parse(loadCommentsPlan()) }))).toBeNull()
  })

  it('reads the hash a rendered page embeds, and nothing from a page without a payload', () => {
    const page = (payload: string): string => `<html><script type="application/json" id="plan-data">${payload}</script></html>`
    expect(renderedPlanHash(page(JSON.stringify({ planHash: 'abc' })))).toBe('abc')
    expect(renderedPlanHash(page(JSON.stringify({ planHash: null })))).toBeNull()
    expect(renderedPlanHash(page('not json'))).toBeUndefined()
    expect(renderedPlanHash('<html></html>')).toBeUndefined()
  })
})

describe('readPlanOverview', () => {
  it('lists each plan with the step plan:next marked, drafts included', async () => {
    const workspace = await createTempWorkspace('guren-cli-plan-overview-')
    try {
      const dir = workspace.dir
      await writeWorkspaceFiles(dir, { 'docs/plans/comments.plan.json': JSON.stringify(loadCommentsPlan()) })
      const marked = (await readPlans(dir)).open[0]!.steps[1]!.id
      await writeWorkspaceFiles(dir, {
        '.guren/plans/comments.state.json': JSON.stringify({
          stateVersion: PLAN_STATE_VERSION,
          steps: {},
          active: { plan: 'docs/plans/comments.plan.json', step: marked, startedAt: '2026-09-29T10:00:00.000Z', continuations: 0 },
        }),
      })

      const overview = await readPlanOverview(dir)

      expect(overview.schemaVersion).toBe(1)
      expect(overview.plans.map((plan) => [plan.file, plan.standing])).toEqual([['docs/plans/comments.plan.json', 'draft']])
      expect(overview.active).toEqual([{ plan: 'docs/plans/comments.plan.json', step: marked }])
      expect(overview.unreadable).toEqual([])
    } finally {
      await workspace.cleanup()
    }
  })

  it('returns no plans for an app without any', async () => {
    const workspace = await createTempWorkspace('guren-cli-plan-overview-none-')
    try {
      expect(await readPlanOverview(workspace.dir)).toEqual({ schemaVersion: 1, plans: [], active: [], unreadable: [] })
    } finally {
      await workspace.cleanup()
    }
  })
})
