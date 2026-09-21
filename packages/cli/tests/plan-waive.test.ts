import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCommand } from 'citty'

import { builtinSubCommands } from '../src/commands'
import { planWaiveFile, type PlanWaiveFileOptions, type PlanWaiveReport } from '../src/plan-waive'
import { planDecisionsPath, readPlanDecisions, type PlanDecisions } from '../src/plan/decisions'
import { planHash } from '../src/plan/identity'
import type { CapturedExec } from '../src/subprocess'
import { loadCommentsPlan, loadParsedCommentsPlan, TEST_BASELINE } from './plan-fixture'

let ROOT: string
const HASH = planHash(loadParsedCommentsPlan())
const NOW = (): Date => new Date('2026-09-21T12:00:00.000Z')

/** `git config` answering nothing, so a waiver's authorship is not what a test turns on. */
const noAuthor: CapturedExec = async () => ({ exitCode: 1, stdout: '', stderr: '' })

const approved = (): Record<string, unknown> => ({ ...loadCommentsPlan(), baseline: TEST_BASELINE })

async function writePlan(name: string, document: unknown = approved()): Promise<string> {
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
  return planWaiveFile(planPath, { elementIds: ids, reason: 'the redesign lands in the next plan', now: NOW, exec: noAuthor, ...options })
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
    expect(report.decisionsFile).toBe(join(ROOT, 'write.decisions.json'))
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

    const report = await planWaiveFile(plan, { elementIds: ['model.comment', 'column.comment.id'], remove: true })

    expect(report.removed.map((waiver) => waiver.elementId)).toEqual(['model.comment'])
    expect((await decisionsOf(plan)).waivers.map((waiver) => waiver.elementId)).toEqual(['column.comment.body'])
  })

  test('should keep the decision log of the §9 layout beside the plan as decisions.json', async () => {
    const plan = await writePlan('docs/plans/comments/plan.json')

    const report = await waive(plan, ['model.comment'])

    expect(planDecisionsPath(plan)).toBe(join(ROOT, 'docs/plans/comments/decisions.json'))
    expect(report.decisionsFile).toBe(join(ROOT, 'docs/plans/comments/decisions.json'))
    expect((await decisionsOf(plan)).waivers).toHaveLength(1)
  })

  test('should refuse a plan with no reason, an element the plan does not declare, and one no plan:status section judges', async () => {
    const plan = await writePlan('refuse.plan.json')

    await expect(planWaiveFile(plan, { elementIds: ['model.comment'] })).rejects.toThrow('--reason is required')
    await expect(waive(plan, ['model.nope'])).rejects.toThrow('No element "model.nope" is declared by this plan')
    await expect(waive(plan, ['AC-comments-1'])).rejects.toThrow('which plan:status does not judge')
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
    await expect(planWaiveFile(plan, { elementIds: ['model.comment'], remove: true })).rejects.toThrow('will not replace it')
    expect(await readFile(logPath, 'utf8')).toBe('{ "decisionsVersion": 2 }\n')
  })

  test('should take every element id the command line names after the plan', async () => {
    const plan = await writePlan('command.plan.json')
    log.mockImplementation(() => {})

    await runCommand(builtinSubCommands['plan:waive'], { rawArgs: [plan, 'model.comment', 'column.comment.body', '--reason', 'the redesign lands in the next plan'] })
    const printed = log.mock.calls.map((call) => String(call[0])).join('\n')

    expect((await decisionsOf(plan)).waivers.map((waiver) => waiver.elementId)).toEqual(['column.comment.body', 'model.comment'])
    expect(printed).toContain('Waived model.comment: the redesign lands in the next plan')
    expect(printed).toContain(`Recorded in ${planDecisionsPath(plan)}`)
  })

  test('should print the report as JSON with --json, and remove through the command line', async () => {
    const plan = await writePlan('command-json.plan.json')
    log.mockImplementation(() => {})

    await runCommand(builtinSubCommands['plan:waive'], { rawArgs: [plan, 'model.comment', '--reason', 'later', '--json'] })
    const report = JSON.parse(log.mock.calls.map((call) => String(call[0])).join('\n')) as PlanWaiveReport
    await runCommand(builtinSubCommands['plan:waive'], { rawArgs: [plan, 'model.comment', '--remove'] })

    expect(report.waived.map((waiver) => waiver.elementId)).toEqual(['model.comment'])
    expect(report.plan.hash).toBe(HASH)
    expect((await decisionsOf(plan)).waivers).toEqual([])
  })
})
