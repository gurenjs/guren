import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from './workspace-packages.ts'

/**
 * A job with no `timeout-minutes` inherits GitHub's 6-hour default, which is
 * not a cap on anything this repo does — it is a cap on how long a *hang* can
 * hold a runner. That bill came due on 2026-08-21: the Bun 1.4.0 trial lane hit
 * oven-sh/bun#34069 on four runs in one day and sat `in_progress` for 11 to 57
 * minutes each, until someone noticed and cancelled by hand. Nothing but a
 * human was standing between those runs and six hours apiece.
 *
 * So the property is totality, not any particular number: *every* job declares
 * one. A per-job cap that a new job silently opts out of is the same gap again,
 * which is why this reads the workflows off disk rather than from a list.
 *
 * The numbers themselves are measured (see the comment on each cap) and set
 * well above the observed ceiling on purpose. A cap tight enough to turn a slow
 * runner red is a cap someone deletes, and then there is no cap.
 */
const WORKFLOW_DIR = join(repoRoot, '.github/workflows')

/**
 * Above every cap in the tree, below GitHub's 6-hour default. Totality alone
 * would be satisfied by `timeout-minutes: 350`, which caps nothing.
 */
const MAX_REASONABLE_MINUTES = 60

function workflowFiles(): string[] {
  return [...new Bun.Glob('*.{yml,yaml}').scanSync({ cwd: WORKFLOW_DIR })].sort()
}

/**
 * Job id -> the lines of its block, for the one top-level `jobs:` mapping.
 *
 * Indentation is the whole point: `timeout-minutes` on a *step* sits deeper and
 * caps that step only, so a line-level search would read a workflow whose jobs
 * are all uncapped as covered. Job ids are the keys at exactly two spaces
 * inside `jobs:` — the `on:` block has two-space keys too (`push:`,
 * `schedule:`), hence scoping to the section rather than to the file.
 */
export function jobBlocks(source: string): Map<string, string[]> {
  const lines = source.split('\n')
  const blocks = new Map<string, string[]>()
  let inJobs = false
  let current: string[] | undefined

  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true
      continue
    }
    if (!inJobs) continue

    // A key back at column 0 ends the jobs mapping.
    if (/^\S/.test(line)) break

    const job = /^ {2}([A-Za-z_][\w-]*):\s*(?:#.*)?$/.exec(line)
    if (job) {
      current = []
      blocks.set(job[1]!, current)
      continue
    }
    current?.push(line)
  }

  return blocks
}

/** The job-level `timeout-minutes` of a job block, if it declares one. */
export function jobTimeout(block: string[]): number | undefined {
  for (const line of block) {
    const match = /^ {4}timeout-minutes:\s*(\d+)\s*(?:#.*)?$/.exec(line)
    if (match) return Number(match[1])
  }
  return undefined
}

describe('workflow job timeouts', () => {
  const workflows = workflowFiles().map((file) => ({
    file,
    jobs: jobBlocks(readFileSync(join(WORKFLOW_DIR, file), 'utf8')),
  }))

  it('finds jobs in every workflow', () => {
    // Everything below is measured against this, so a workflow whose jobs this
    // stops recognising has to fail loudly rather than vacuously pass.
    for (const { file, jobs } of workflows) {
      expect([file, jobs.size > 0]).toEqual([file, true])
    }
  })

  it.each(workflows.flatMap(({ file, jobs }) => [...jobs.keys()].map((job) => [file, job] as const)))(
    '%s: %s caps its runtime',
    (file, job) => {
      const minutes = jobTimeout(workflows.find((w) => w.file === file)!.jobs.get(job)!)
      expect(minutes).toBeDefined()
      expect(minutes!).toBeGreaterThan(0)
      expect(minutes!).toBeLessThanOrEqual(MAX_REASONABLE_MINUTES)
    },
  )
})

describe("CI's trial lane", () => {
  const ci = readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf8')

  it('caps the test step, not only the job', () => {
    /*
     * The trial lane is non-blocking through `continue-on-error`, which is
     * documented to cover a job that *fails*. A job-level timeout is not
     * documented to report as a failure rather than a cancellation, and a
     * cancellation is not masked — so resting the lane's non-blocking promise
     * on the job cap would be resting it on undocumented behaviour. A *step*
     * timeout fails the step, and a failed step fails the job, which
     * `continue-on-error` then masks by the documented path.
     *
     * `Run tests` is also where the wedge actually happens, so this cap is the
     * one that fires first; the job cap stays as the backstop for a hang
     * anywhere else.
     */
    const step = /^ {6}- name: Run tests\n {8}timeout-minutes: (\d+)$/m.exec(ci)
    expect(step).not.toBeNull()
    expect(Number(step![1])).toBeGreaterThan(0)
  })
})
