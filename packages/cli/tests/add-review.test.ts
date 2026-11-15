import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { addReview, REVIEW_LANE_LABELS, reviewFileEntries, reviewNextSteps, runsBareGate } from '../src/add-review'
import { readReviewPolicySource } from '../src/change/review-policy'
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

const WRITTEN = ['guren.review.ts', '.github/workflows/change.yml', '.github/pull_request_template.md', '.github/ISSUE_TEMPLATE/feature.md', '.github/ISSUE_TEMPLATE/defect.md', 'REVIEW.md']

describe('guren add review', () => {
  test('should write the workflow and the templates as shipped', async () => {
    const app = await createApp()
    const result = await addReview({ cwd: app })

    expect(result.created.map((path) => path.slice(app.length + 1))).toEqual(WRITTEN)
    for (const entry of reviewFileEntries()) expect(await readFile(join(app, entry.path), 'utf8')).toBe(entry.contents)
    expect(result.reviewDoc).toBe('written')
    expect(await readFile(join(app, 'REVIEW.md'), 'utf8')).toContain('<!-- guren:review generated -->')
  })

  test('should leave a REVIEW.md that exists alone, --force or not', async () => {
    const app = await createApp()
    await writeFile(join(app, 'REVIEW.md'), 'Our own rules.\n', 'utf8')

    const result = await addReview({ cwd: app, force: true, overwritten: [] })

    expect(result.reviewDoc).toBe('kept')
    expect(await readFile(join(app, 'REVIEW.md'), 'utf8')).toBe('Our own rules.\n')
    expect(reviewNextSteps(result)[0]).toContain('REVIEW.md exists and was left as it is')
  })

  test('should ship a policy that change:lane reads whole', () => {
    const policy = reviewFileEntries().find((entry) => entry.path === 'guren.review.ts')!.contents

    expect(readReviewPolicySource(policy)).toEqual({ state: 'read', policy: { approvals: { low: 0, medium: 1, high: 2 }, identities: 'auto', merge: { low: 'person' } } })
  })

  test('should keep what is there on a re-run, and replace it under --force', async () => {
    const app = await createApp()
    await mkdir(join(app, '.github'), { recursive: true })
    await writeFile(join(app, '.github/pull_request_template.md'), 'Our own template.\n', 'utf8')

    const kept = await addReview({ cwd: app })
    const before = await readFile(join(app, '.github/pull_request_template.md'), 'utf8')
    const overwritten: string[] = []
    const forced = await addReview({ cwd: app, force: true, overwritten })

    expect(kept.created).toHaveLength(5)
    expect(before).toBe('Our own template.\n')
    expect(forced.created).toHaveLength(5)
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
    expect(runsBareGate('        run: bunx guren  gate\n')).toBe(true)
    expect(runsBareGate('      # `bunx guren gate` runs the same stages locally.\n        run: bunx guren change:evidence\n')).toBe(false)
    expect(runsBareGate('      - run: bun run verify # formerly bunx guren gate\n')).toBe(false)
    expect(runsBareGate('      - name: Replacement for guren gate\n')).toBe(false)
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
    expect(workflow).not.toMatch(/^\s*retention-days:/m)
    expect(workflow).toContain('types: [opened, synchronize, reopened, edited]')
    expect(workflow).toContain("if: ${{ github.event.action != 'edited' || github.event.changes.base != null }}")
    expect(workflow).toContain('git fetch --no-tags origin "$BASE"')
    expect(workflow).toContain('name: guren-record-${{ env.HEAD }}')
  })

  test('should ask for each lane label the command offers to create', async () => {
    const template = reviewFileEntries().find((entry) => entry.path === '.github/pull_request_template.md')!.contents

    for (const label of REVIEW_LANE_LABELS) expect(template).toContain(label.name)
  })

  test('should name the label commands, and the duplicate gate only when there is one', () => {
    const plain = reviewNextSteps({ duplicateGate: false, reviewDoc: 'written' }).join('\n')

    for (const label of REVIEW_LANE_LABELS) expect(plain).toContain(`gh label create ${label.name} --color ${label.color}`)
    expect(plain).not.toContain('ci.yml')
    expect(reviewNextSteps({ duplicateGate: true, reviewDoc: 'written' })[0]).toContain('ci.yml appears to run')
  })

  test('should be registered, and refused to a plan', () => {
    expect(Object.keys((builtinSubCommands.add as { subCommands: Record<string, unknown> }).subCommands)).toContain('review')
    expect(PLAN_COMMAND_CLASSES['add review']).toBe('deploy')
  })
})
