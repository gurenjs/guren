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
 *
 * Parsed rather than pattern-matched, because the distinction the whole gate
 * rests on is structural: `timeout-minutes` on a *step* caps that step only,
 * and a line-level search would read a workflow whose jobs are all uncapped as
 * covered. Two steps in ci.yml are even named `Run tests`, so "the cap near the
 * step with this name" is not a question text matching can answer either.
 */
const WORKFLOW_DIR = join(repoRoot, '.github/workflows')

/**
 * Above every cap in the tree, below GitHub's 6-hour default. Totality alone
 * would be satisfied by `timeout-minutes: 350`, which caps nothing.
 */
const MAX_REASONABLE_MINUTES = 60

type Step = { name?: string; 'timeout-minutes'?: unknown }
type Job = { 'timeout-minutes'?: unknown; steps?: Step[] }

function workflowFiles(): string[] {
  return [...new Bun.Glob('*.{yml,yaml}').scanSync({ cwd: WORKFLOW_DIR })].sort()
}

function jobsOf(file: string): Record<string, Job> {
  const parsed = Bun.YAML.parse(readFileSync(join(WORKFLOW_DIR, file), 'utf8')) as {
    jobs?: Record<string, Job>
  }
  return parsed.jobs ?? {}
}

describe('workflow job timeouts', () => {
  const workflows = workflowFiles().map((file) => ({ file, jobs: jobsOf(file) }))

  it('finds jobs in every workflow', () => {
    // Everything below is measured against this, so a workflow whose jobs this
    // stops recognising has to fail loudly rather than vacuously pass.
    for (const { file, jobs } of workflows) {
      expect([file, Object.keys(jobs).length > 0]).toEqual([file, true])
    }
  })

  it.each(
    workflows.flatMap(({ file, jobs }) =>
      Object.keys(jobs).map((job) => [file, job] as const),
    ),
  )('%s: %s caps its runtime', (file, job) => {
    const minutes = workflows.find((w) => w.file === file)!.jobs[job]!['timeout-minutes']
    expect(typeof minutes).toBe('number')
    expect(minutes as number).toBeGreaterThan(0)
    expect(minutes as number).toBeLessThanOrEqual(MAX_REASONABLE_MINUTES)
  })
})

describe("CI's trial lane", () => {
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
     * `Run tests` in build-and-test is also where the wedge actually happens,
     * so this cap is the one that fires first; the job cap stays as the
     * backstop for a hang anywhere else. It has to be *that* step: web-app has
     * a step by the same name, and a cap landing there would leave the one
     * that wedges uncapped.
     */
    const steps = jobsOf('ci.yml')['build-and-test']?.steps ?? []
    const runTests = steps.filter((step) => step.name === 'Run tests')

    expect(runTests).toHaveLength(1)
    expect(typeof runTests[0]!['timeout-minutes']).toBe('number')
    expect(runTests[0]!['timeout-minutes'] as number).toBeGreaterThan(0)
  })
})
