import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCommand } from 'citty'

import { builtinSubCommands } from '../src/commands'
import { formatPlanWaive, planWaiveFile, type PlanWaiveFileOptions, type PlanWaiveReport } from '../src/plan-waive'
import { planDecisionsPath, readPlanDecisions, type PlanDecisions } from '../src/plan/decisions'
import { planHash } from '../src/plan/identity'
import {
  listPlanElements,
  PlanColumnSchema,
  PlanCommandSchema,
  PlanControllerSchema,
  PlanModelSchema,
  PlanPolicySchema,
  PlanResourceSchema,
  PlanRouteSchema,
  PlanSideEffectSchema,
  PlanValidatorSchema,
  PlanViewSchema,
  PlanActionSchema,
  PlanSchema,
  type PlanElementSection,
} from '../src/plan/schema'
import { PLAN_STATUS_SECTIONS } from '../src/plan/status'
import type { CapturedExec } from '../src/subprocess'
import { loadApprovedCommentsPlan, loadCommentsPlan, loadParsedCommentsPlan } from './plan-fixture'

let ROOT: string
const HASH = planHash(loadParsedCommentsPlan())
const NOW = (): Date => new Date('2026-09-21T12:00:00.000Z')

/** `git config` answering nothing, so a waiver's authorship is not what a test turns on. */
const noAuthor: CapturedExec = async () => ({ exitCode: 1, stdout: '', stderr: '' })

async function writePlan(name: string, document: unknown = loadApprovedCommentsPlan()): Promise<string> {
  const path = join(ROOT, name)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, typeof document === 'string' ? document : JSON.stringify(document), 'utf8')
  return path
}

async function decisionsOf(planPath: string): Promise<PlanDecisions> {
  const read = await readPlanDecisions(planPath)
  if (!read.decisions) throw new Error(read.unreadable ?? 'no decision log was written')
  return read.decisions
}

function waive(planPath: string, ids: string[], options: Partial<PlanWaiveFileOptions> = {}): Promise<PlanWaiveReport> {
  return planWaiveFile(planPath, { elementIds: ids, reason: 'the redesign lands in the next plan', now: NOW, exec: noAuthor, app: ROOT, ...options })
}

describe('plan:waive', () => {
  const log = spyOn(console, 'log')

  beforeAll(async () => {
    ROOT = await mkdtemp(join(tmpdir(), 'guren-plan-waive-'))
  })

  afterEach(() => {
    log.mockClear()
  })

  afterAll(async () => {
    log.mockRestore()
    await rm(ROOT, { recursive: true, force: true })
  })

  test('should write one waiver per element, naming the plan hash, sorted by element id', async () => {
    const plan = await writePlan('write.plan.json')

    const report = await waive(plan, ['model.comment', 'column.comment.body'])

    expect(report.plan.hash).toBe(HASH)
    expect(report.decisionsFile).toBe('write.decisions.json')
    expect(await decisionsOf(plan)).toEqual({
      decisionsVersion: 1,
      waivers: [
        { elementId: 'column.comment.body', planHash: HASH, reason: 'the redesign lands in the next plan', at: '2026-09-21T12:00:00.000Z' },
        { elementId: 'model.comment', planHash: HASH, reason: 'the redesign lands in the next plan', at: '2026-09-21T12:00:00.000Z' },
      ],
    })
    expect(report.replaced).toEqual([])
  })

  test('should name the waiver after whoever git config reports, and omit it where it reports nobody', async () => {
    const plan = await writePlan('author.plan.json')
    const exec: CapturedExec = async (command) => ({ exitCode: 0, stdout: command.includes('user.name') ? 'Urata Daiki\n' : 'someone@example.com\n', stderr: '' })

    await waive(plan, ['model.comment'], { exec })
    const named = await decisionsOf(plan)
    await waive(plan, ['model.comment'], { exec: noAuthor })

    expect(named.waivers[0]?.by).toBe('Urata Daiki <someone@example.com>')
    expect((await decisionsOf(plan)).waivers[0]).not.toHaveProperty('by')
  })

  test('should replace an element’s earlier waiver rather than keep both, and say which it replaced', async () => {
    const plan = await writePlan('replace.plan.json')
    await waive(plan, ['model.comment'], { reason: 'first' })

    const report = await waive(plan, ['model.comment'], { reason: 'second' })

    expect(report.replaced).toEqual([{ elementId: 'model.comment', planHash: HASH, reason: 'first', at: '2026-09-21T12:00:00.000Z' }])
    expect((await decisionsOf(plan)).waivers).toEqual([{ elementId: 'model.comment', planHash: HASH, reason: 'second', at: '2026-09-21T12:00:00.000Z' }])
  })

  test('should delete a waiver with --remove, and report an element that had none', async () => {
    const plan = await writePlan('remove.plan.json')
    await waive(plan, ['model.comment', 'column.comment.body'])

    const report = await planWaiveFile(plan, { elementIds: ['model.comment', 'column.comment.id'], remove: true, app: ROOT })

    expect(report.removed.map((waiver) => waiver.elementId)).toEqual(['model.comment'])
    expect((await decisionsOf(plan)).waivers.map((waiver) => waiver.elementId)).toEqual(['column.comment.body'])
  })

  test('should remove a waiver whatever the plan now says, since a revision is what withdraws one', async () => {
    const plan = await writePlan('revised.plan.json')
    await waive(plan, ['policy.comment'])
    // The revision drops the element and the baseline with it, which every check but removal refuses.
    const revised = loadCommentsPlan()
    revised.policies = []
    await writeFile(plan, JSON.stringify(revised), 'utf8')

    await expect(waive(plan, ['policy.comment'])).rejects.toThrow('has no baseline')
    const report = await planWaiveFile(plan, { elementIds: ['policy.comment'], remove: true, app: ROOT })

    expect(report.plan.hash).toBeNull()
    expect(report.removed.map((waiver) => waiver.elementId)).toEqual(['policy.comment'])
    expect((await decisionsOf(plan)).waivers).toEqual([])
  })

  test('should leave no log behind where a removal finds none', async () => {
    const plan = await writePlan('no-log.plan.json')

    const report = await planWaiveFile(plan, { elementIds: ['model.comment'], remove: true, app: ROOT })

    expect(report.written).toBe(false)
    expect(report.removed).toEqual([])
    expect(await readPlanDecisions(plan)).toEqual({ decisions: undefined })
    expect(formatPlanWaive(report)).toContain('There is no decision log at no-log.decisions.json, and nothing to record, so none was created.')
  })

  test('should refuse an existing element of every judged section whose schema carries a change', async () => {
    // Restated here on purpose: a judged section gaining a `change` must be added to both this
    // table and `existingIds()`, and a mismatch between the two is what fails.
    const SECTION_SCHEMAS: Record<(typeof PLAN_STATUS_SECTIONS)[number], { shape: Record<string, unknown> }> = {
      models: PlanModelSchema,
      columns: PlanColumnSchema,
      validators: PlanValidatorSchema,
      controllers: PlanControllerSchema,
      actions: PlanActionSchema,
      routes: PlanRouteSchema,
      views: PlanViewSchema,
      resources: PlanResourceSchema,
      policies: PlanPolicySchema,
      sideEffects: PlanSideEffectSchema,
      commands: PlanCommandSchema,
    }
    const document = loadApprovedCommentsPlan()
    document.sideEffects = [
      { id: 'side.comment.notify', change: { kind: 'add' }, kind: 'notification', name: 'CommentPosted', trigger: 'a comment is created', description: 'notifies the post author' },
    ]
    // Every `change` in the document, found by shape rather than by naming a section.
    const changed = new Set<string>()
    const markExisting = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) markExisting(item)
        return
      }
      if (value === null || typeof value !== 'object') return
      const entry = value as Record<string, unknown>
      if (typeof entry.id === 'string' && entry.change) {
        entry.change = { kind: 'existing' }
        changed.add(entry.id)
      }
      for (const member of Object.values(entry)) markExisting(member)
    }
    markExisting(document)
    const plan = await writePlan('existing-everywhere.plan.json', document)
    const judged = new Set<string>(PLAN_STATUS_SECTIONS)
    const sections = new Map(listPlanElements(PlanSchema.parse(document)).map((element) => [element.id, element.section]))

    const refused = new Set<PlanElementSection>()
    for (const id of changed) {
      const section = sections.get(id)
      if (section === undefined || !judged.has(section)) continue
      await expect(waive(plan, [id])).rejects.toThrow('is an existing element')
      refused.add(section)
    }

    const carryChange = PLAN_STATUS_SECTIONS.filter((section) => 'change' in SECTION_SCHEMAS[section].shape)
    expect([...refused].sort()).toEqual([...carryChange].sort())
    expect(carryChange).not.toContain('commands')
    expect(await readPlanDecisions(plan)).toEqual({ decisions: undefined })
  })

  test('should keep the decision log of the §9 layout beside the plan as decisions.json', async () => {
    const plan = await writePlan('docs/plans/comments/plan.json')

    const report = await waive(plan, ['model.comment'])

    expect(planDecisionsPath(plan)).toBe(join(ROOT, 'docs/plans/comments/decisions.json'))
    // Reported the way plan:status reports the state file: relative to the application root.
    expect(report.decisionsFile).toBe('docs/plans/comments/decisions.json')
    expect((await decisionsOf(plan)).waivers).toHaveLength(1)
  })

  test('should refuse a plan with no reason, an element the plan does not declare, and one no plan:status section judges', async () => {
    const plan = await writePlan('refuse.plan.json')

    await expect(planWaiveFile(plan, { elementIds: ['model.comment'] })).rejects.toThrow('--reason is required')
    await expect(waive(plan, ['model.nope'])).rejects.toThrow('No element "model.nope" is declared by this plan')
    await expect(waive(plan, ['AC-comments-1'])).rejects.toThrow('a behaviour the code will not satisfy is a revision, not a waiver')
    // A question covers no elements, so it is not told to waive the ones it covers.
    await expect(waive(plan, ['Q-delete'])).rejects.toThrow(/questions element, which plan:status does not judge, so it has no state a waiver could lift\.$/)
    await expect(waive(plan, ['column.post.id'])).rejects.toThrow('is an existing element')
    await expect(waive(plan, [])).rejects.toThrow('Name at least one element id')
    expect(await readPlanDecisions(plan)).toEqual({ decisions: undefined })
  })

  test('should refuse a draft, which has no hash a waiver could name', async () => {
    const draft = await writePlan('draft.plan.json', loadCommentsPlan())

    await expect(waive(draft, ['model.comment'])).rejects.toThrow('has no baseline')
    expect(await readPlanDecisions(draft)).toEqual({ decisions: undefined })
  })

  test('should refuse to replace a decision log it cannot read, and leave its bytes alone', async () => {
    const plan = await writePlan('unreadable.plan.json')
    const logPath = planDecisionsPath(plan)
    await writeFile(logPath, '{ "decisionsVersion": 2 }\n', 'utf8')

    await expect(waive(plan, ['model.comment'])).rejects.toThrow('will not replace it')
    await expect(planWaiveFile(plan, { elementIds: ['model.comment'], remove: true, app: ROOT })).rejects.toThrow('will not replace it')
    expect(await readFile(logPath, 'utf8')).toBe('{ "decisionsVersion": 2 }\n')
  })

  test('should take every element id the command line names after the plan', async () => {
    const plan = await writePlan('command.plan.json')
    log.mockImplementation(() => {})

    await runCommand(builtinSubCommands['plan:waive'], { rawArgs: [plan, 'model.comment', 'column.comment.body', '--reason', 'the redesign lands in the next plan', '--app', ROOT] })
    const printed = log.mock.calls.map((call) => String(call[0])).join('\n')

    expect((await decisionsOf(plan)).waivers.map((waiver) => waiver.elementId)).toEqual(['column.comment.body', 'model.comment'])
    expect(printed).toContain('Waived model.comment: the redesign lands in the next plan')
    expect(printed).toContain('Recorded in command.decisions.json')
  })

  test('should print the report as JSON with --json, and remove through the command line', async () => {
    const plan = await writePlan('command-json.plan.json')
    log.mockImplementation(() => {})

    await runCommand(builtinSubCommands['plan:waive'], { rawArgs: [plan, 'model.comment', '--reason', 'later', '--json', '--app', ROOT] })
    const report = JSON.parse(log.mock.calls.map((call) => String(call[0])).join('\n')) as PlanWaiveReport
    await runCommand(builtinSubCommands['plan:waive'], { rawArgs: [plan, 'model.comment', '--remove'] })

    expect(report.waived.map((waiver) => waiver.elementId)).toEqual(['model.comment'])
    expect(report.plan.hash).toBe(HASH)
    expect((await decisionsOf(plan)).waivers).toEqual([])
  })
})
