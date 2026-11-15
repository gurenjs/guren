import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runCommand } from 'citty'
import { consola } from 'consola'

import { addReview, REVIEW_LANE_LABELS, reviewFileEntries, runsBareGate } from '../src/add-review'
import { builtinSubCommands } from '../src/commands'
import { PLAN_COMMAND_CLASSES } from '../src/plan/command-allowlist'
import { createTempRoot } from './helpers'

const ROOT_PREFIX = 'guren-add-review-'
let ROOT: string
let apps = 0

beforeAll(async () => {
  ROOT = await createTempRoot(ROOT_PREFIX)
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

async function createApp(): Promise<string> {
  const app = join(ROOT, `app-${apps++}`)
  await mkdir(app, { recursive: true })
  return app
}

const WRITTEN = ['.github/workflows/change.yml', '.github/pull_request_template.md', '.github/ISSUE_TEMPLATE/feature.md', '.github/ISSUE_TEMPLATE/defect.md']

describe('guren add review', () => {
  test('should write the workflow and the templates as shipped', async () => {
    const app = await createApp()
    const result = await addReview({ cwd: app })

    expect(result.created.map((path) => path.slice(app.length + 1))).toEqual(WRITTEN)
    for (const entry of reviewFileEntries()) expect(await readFile(join(app, entry.path), 'utf8')).toBe(entry.contents)
  })

  test('should keep what is there on a re-run, and replace it under --force', async () => {
    const app = await createApp()
    await mkdir(join(app, '.github'), { recursive: true })
    await writeFile(join(app, '.github/pull_request_template.md'), 'Our own template.\n', 'utf8')

    const kept = await addReview({ cwd: app })
    const overwritten: string[] = []
    const forced = await addReview({ cwd: app, force: true, overwritten })

    expect(kept.created).toHaveLength(3)
    expect(forced.created).toHaveLength(4)
    expect(overwritten).toContain(join(app, '.github/pull_request_template.md'))
    expect(await readFile(join(app, '.github/pull_request_template.md'), 'utf8')).toContain('lane:low')
  })

  test('should refuse an application below the root of its repository, writing nothing', async () => {
    const repo = await createApp()
    await Bun.spawn(['git', 'init', '-q'], { cwd: repo }).exited
    const app = join(repo, 'apps/web')
    await mkdir(app, { recursive: true })

    await expect(addReview({ cwd: app })).rejects.toThrow('GitHub would never run a workflow there')
    expect(await Bun.file(join(app, '.github/workflows/change.yml')).exists()).toBe(false)
  })

  test('should read a bare gate step in any form, and not a comment naming it', () => {
    expect(runsBareGate('      - run: bunx guren gate --deps\n')).toBe(true)
    expect(runsBareGate('        run: |\n          bunx guren gate\n')).toBe(true)
    expect(runsBareGate('        run: "bun x guren gate --deps"\n')).toBe(true)
    expect(runsBareGate('      # `bunx guren gate` runs the same stages locally.\n        run: bunx guren change:evidence\n')).toBe(false)
  })

  test('should say the gate runs twice while the scaffolded CI still runs it', async () => {
    const app = await createApp()
    await mkdir(join(app, '.github/workflows'), { recursive: true })
    await writeFile(join(app, '.github/workflows/ci.yml'), await readFile(join(import.meta.dir, '../../create-app/templates/default/.github/workflows/ci.yml'), 'utf8'), 'utf8')

    expect((await addReview({ cwd: app })).duplicateGate).toBe(true)
    expect((await addReview({ cwd: await createApp() })).duplicateGate).toBe(false)
  })

  test('should check out the head with its history, and keep the summary and the record past a failed gate', async () => {
    const workflow = reviewFileEntries().find((entry) => entry.path === '.github/workflows/change.yml')!.contents

    expect(workflow).toContain('ref: ${{ env.HEAD }}')
    expect(workflow).toContain('fetch-depth: 0')
    expect(workflow).toContain('run: bunx guren change:evidence --base "$BASE" --head "$HEAD"\n')
    expect(workflow.match(/if: \$\{\{ !cancelled\(\) && hashFiles\('\.guren\/evidence\/[a-z.]+'\) != '' \}\}\n {8}continue-on-error: true/g)).toHaveLength(2)
    expect(workflow).not.toContain('retention-days')
    expect(workflow).toContain('name: guren-record-${{ env.HEAD }}')
  })

  test('should ask for each lane label the command offers to create', async () => {
    const template = reviewFileEntries().find((entry) => entry.path === '.github/pull_request_template.md')!.contents

    for (const label of REVIEW_LANE_LABELS) expect(template).toContain(label.name)
  })

  test('should print the label commands through the command', async () => {
    const app = await createApp()
    const info = spyOn(consola, 'info').mockImplementation((() => {}) as never)
    const success = spyOn(consola, 'success').mockImplementation((() => {}) as never)
    const cwd = process.cwd()
    try {
      process.chdir(app)
      await runCommand((builtinSubCommands.add as { subCommands: Record<string, Parameters<typeof runCommand>[0]> }).subCommands.review!, { rawArgs: [] })
    } finally {
      process.chdir(cwd)
      info.mockRestore()
      success.mockRestore()
    }
    const printed = info.mock.calls.map((call) => String(call[0])).join('\n')

    for (const label of REVIEW_LANE_LABELS) expect(printed).toContain(`gh label create ${label.name} --color ${label.color}`)
    expect(success.mock.calls).toHaveLength(4)
  })

  test('should be registered, and refused to a plan', () => {
    expect(Object.keys((builtinSubCommands.add as { subCommands: Record<string, unknown> }).subCommands)).toContain('review')
    expect(PLAN_COMMAND_CLASSES['add review']).toBe('deploy')
  })
})
