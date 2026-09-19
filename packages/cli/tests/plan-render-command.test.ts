import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runCommand } from 'citty'

import { builtinSubCommands } from '../src/commands'
import type { PlanCheckResult } from '../src/plan/validate'
import { captureWarnings, createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from './helpers'
import { loadCommentsPlan, PLAN_APP_FILES, planPageData } from './plan-fixture'

/**
 * What the command wires together: the application it scans, the plan it reads, and
 * the findings the page ends up carrying. The application lives in a *subdirectory*
 * of the workspace, and the plan at its root, so `--app` names a root the process
 * cwd is not: with both in one place every case passes whether or not the flag is
 * honoured, and a plan resolved against `--app` would still be found.
 */
const APP_DIR = 'application'

describe('plan:render', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-plan-render-cmd-')
    await writeWorkspaceFiles(join(workspace.dir, APP_DIR), PLAN_APP_FILES)
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  async function writePlan(document: unknown = loadCommentsPlan()): Promise<void> {
    await writeWorkspaceFiles(workspace.dir, { 'comments.plan.json': JSON.stringify(document) })
  }

  async function render(rawArgs: string[] = ['comments.plan.json', '--app', APP_DIR]): Promise<string[]> {
    const { warnings } = await captureWarnings(async () => {
      await runCommand(builtinSubCommands['plan:render'], { rawArgs })
    })
    return warnings
  }

  async function renderedChecks(): Promise<PlanCheckResult[]> {
    return planPageData(await readFile(join(workspace.dir, 'comments.plan.html'), 'utf8')).checks
  }

  test('should pin the findings the plan raises against the application', async () => {
    await writePlan()

    const warnings = await render()

    // The page is where they are read; the terminal only says how many there are.
    expect(warnings).toEqual(['3 check finding(s) are pinned at the top of the page.'])
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
    await writePlan()

    await render()

    const unreadable = (await renderedChecks()).filter((result) => result.key === 'plan:app-unreadable')
    expect(unreadable.map((result) => result.message)).toContainEqual(
      expect.stringContaining('BrokenController.ts'),
    )
  })

  test('should report a duplicate id once, as a check rather than as its own warning', async () => {
    const fixture = loadCommentsPlan()
    const models = fixture.models as Array<{ id: string }>
    models[1].id = models[0].id
    await writePlan(fixture)

    const warnings = await render()

    const duplicates = (await renderedChecks()).filter((result) => result.key === 'plan:duplicate-id')
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0]).toMatchObject({ elementId: 'model.post', status: 'fail' })
    expect(warnings.join('\n')).not.toContain('declared more than once')
  })

  test('should scan the root --app names while the plan stays where the shell points', async () => {
    await writePlan()

    await render(['comments.plan.json', '--app', 'nowhere'])

    const failures = (await renderedChecks()).filter((result) => result.status === 'fail')
    expect(failures.map((failure) => failure.elementId)).toContain('model.post')
    expect(await readFile(join(workspace.dir, 'comments.plan.html'), 'utf8')).toContain('plan-data')
  })

  test('should write the page beside the plan rather than inside the application', async () => {
    await writePlan()

    await render()

    expect(await readFile(join(workspace.dir, 'comments.plan.html'), 'utf8')).toContain('plan-data')
    await expect(readFile(join(workspace.dir, APP_DIR, 'comments.plan.html'), 'utf8')).rejects.toThrow()
  })
})
