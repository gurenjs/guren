import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runCommand } from 'citty'

import { builtinSubCommands } from '../src/commands'
import type { PlanCheckResult } from '../src/plan/validate'
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from './helpers'
import { loadCommentsPlan, PLAN_APP_FILES, PLAN_APP_WITH_COMMENTS, planPageData } from './plan-fixture'

/**
 * What the command wires together: the application it scans, the plan it reads, and
 * the findings the page ends up carrying. Each application lives in a *subdirectory*
 * of the workspace, and the plan at its root, so `--app` names a root the process
 * cwd is not: with both in one place every case passes whether or not the flag is
 * honoured, and a plan resolved against `--app` would still be found.
 */
const APP_DIR = 'application'
const APP_WITH_COMMENTS_DIR = 'application-with-comments'

describe('plan:render', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-plan-render-cmd-')
    await writeWorkspaceFiles(join(workspace.dir, APP_DIR), PLAN_APP_FILES)
    await writePlan()
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  async function writePlan(document: unknown = loadCommentsPlan()): Promise<void> {
    await writeWorkspaceFiles(workspace.dir, { 'comments.plan.json': JSON.stringify(document) })
  }

  async function render(app = APP_DIR): Promise<void> {
    await runCommand(builtinSubCommands['plan:render'], { rawArgs: ['comments.plan.json', '--app', app] })
  }

  async function renderedPage(): Promise<string> {
    return readFile(join(workspace.dir, 'comments.plan.html'), 'utf8')
  }

  async function renderedChecks(): Promise<PlanCheckResult[]> {
    return planPageData(await renderedPage()).checks
  }

  test('should pin the findings the plan raises against the application', async () => {
    await render()

    const findings = (await renderedChecks()).filter((result) => result.status !== 'pass')
    expect(findings.map((finding) => `${finding.status} ${finding.key} ${finding.elementId ?? ''}`).sort()).toEqual([
      'warn plan:acceptance route.comments.destroy',
      'warn plan:app-unreadable ',
      'warn plan:route-authorization route.comments.store',
    ])
  })

  test('should render a section the scanners could not read, with the warning that says so', async () => {
    await writeWorkspaceFiles(join(workspace.dir, APP_DIR), {
      'app/Http/Controllers/BrokenController.ts': 'export class Broken extends {{{',
    })

    await render()

    const unreadable = (await renderedChecks()).filter((result) => result.key === 'plan:app-unreadable')
    expect(unreadable.map((result) => result.message)).toContainEqual(expect.stringContaining('BrokenController.ts'))
  })

  test('should report a duplicate id once, as a check rather than as its own warning', async () => {
    const fixture = loadCommentsPlan()
    const models = fixture.models as Array<{ id: string }>
    models[1].id = models[0].id
    await writePlan(fixture)

    await render()

    const duplicates = (await renderedChecks()).filter((result) => result.key === 'plan:duplicate-id')
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0]).toMatchObject({ elementId: 'model.post', status: 'fail' })
  })

  test('should print the page path and the checks it carries under --json', async () => {
    const lines: string[] = []
    const log = spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    try {
      await runCommand(builtinSubCommands['plan:render'], { rawArgs: ['comments.plan.json', '--app', APP_DIR, '--json'] })
    } finally {
      log.mockRestore()
    }

    const printed = JSON.parse(lines.join('\n')) as { path: string; checks: PlanCheckResult[] }
    expect(printed.path.endsWith('comments.plan.html')).toBe(true)
    expect(printed.checks).toEqual(await renderedChecks())
    expect(printed.checks.some((result) => result.status === 'warn')).toBe(true)
  })

  test('should scan the root --app names while the plan stays where the shell points', async () => {
    await writeWorkspaceFiles(join(workspace.dir, APP_WITH_COMMENTS_DIR), PLAN_APP_WITH_COMMENTS)

    await render(APP_WITH_COMMENTS_DIR)
    const collisions = (await renderedChecks()).filter((result) => result.key === 'plan:app-collision')
    await render()
    const withoutComments = (await renderedChecks()).filter((result) => result.key === 'plan:app-collision')

    // One plan, two applications: `model.comment` is an `add` only one of them already
    // has. A flag the command ignored would answer for the working directory both times.
    expect(collisions.map((result) => result.elementId)).toContain('model.comment')
    expect(withoutComments).toEqual([])
  })

  test('should write the page beside the plan rather than inside the application', async () => {
    await render()

    expect(await renderedPage()).toContain('plan-data')
    await expect(readFile(join(workspace.dir, APP_DIR, 'comments.plan.html'), 'utf8')).rejects.toThrow()
  })
})
