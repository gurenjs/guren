import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from './workspace-packages.ts'

/**
 * A job with no `timeout-minutes` inherits GitHub's 6-hour default — a cap on
 * how long a *hang* holds a runner. The Bun 1.4.0 trial lane hit
 * oven-sh/bun#34069 four times in one day, sitting `in_progress` 11 to 57
 * minutes until cancelled by hand. The property is totality: every job declares
 * one, read off disk rather than from a list, with caps well above the observed
 * ceiling. Parsed rather than pattern-matched, since `timeout-minutes` on a
 * *step* caps that step only and two steps in ci.yml are named `Run tests`.
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
    // Everything below is measured against this, so unrecognised jobs have to
    // fail loudly rather than vacuously pass.
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
     * `continue-on-error` is documented to mask a job that *fails*, and a
     * job-level timeout may report as a cancellation, which is not masked. A
     * step timeout fails the step, which fails the job. It has to be
     * build-and-test's `Run tests` — where the wedge happens, and web-app has a
     * step by the same name.
     */
    const steps = jobsOf('ci.yml')['build-and-test']?.steps ?? []
    const runTests = steps.filter((step) => step.name === 'Run tests')

    expect(runTests).toHaveLength(1)
    expect(typeof runTests[0]!['timeout-minutes']).toBe('number')
    expect(runTests[0]!['timeout-minutes'] as number).toBeGreaterThan(0)
  })
})
