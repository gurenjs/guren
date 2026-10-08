import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import type { DoctorCheck, DoctorJsonOutput, DoctorReport, RunDoctorOptions } from './doctor'
import { DOCTOR_STATUSES, summarizeDoctorReport } from './doctor-report'
import { runCheckFixes, settleFixRuns } from './check-fix'
import type { CheckReport } from './check-result'
import { cliEntry } from './cli-entry'
import { bunExecutable, runCaptured, type CapturedExec } from './subprocess'

// Only what the repair reads is checked; the child is this CLI, so the rest is
// DoctorJsonOutput. A closed copy of every field would fail a good recheck once a field gains a value.
const recheckSchema = z.object({
  version: z.literal(1),
  cwd: z.string(),
  checks: z.array(z.looseObject({ key: z.string(), status: z.enum(DOCTOR_STATUSES) })),
  nextSteps: z.array(z.unknown()).nullable(),
  recommendedCommands: z.array(z.string()),
})

function fixReport(cwd: string, checks: DoctorCheck[]): CheckReport {
  const findings = checks.map(({ repair, ...check }) => ({ ...check, fix: repair }))
  return {
    cwd, checks: findings,
    passCount: findings.filter((check) => check.status === 'pass').length,
    warnCount: findings.filter((check) => check.status === 'warn').length,
    failCount: findings.filter((check) => check.status === 'fail').length,
  }
}

export function hasPendingRepair(checks: DoctorCheck[]): boolean {
  return checks.some((check) => check.status !== 'pass' && check.repair !== undefined)
}

export function doctorRecheckArgs(options: RunDoctorOptions): string[] {
  return ['doctor', '--json', ...(options.next ? ['--next'] : []), ...(options.introspect ? [] : ['--no-introspect'])]
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
  if (a === b) return true
  const physical = (path: string) => realpath(path).catch(() => path)
  return (await physical(a)) === (await physical(b))
}

/** Re-read in a child: generators can clear failed imports that this process's ESM cache retains. */
export async function repairDoctorReport(
  before: DoctorReport,
  options: RunDoctorOptions,
  exec: CapturedExec = runCaptured,
): Promise<DoctorReport> {
  const runs = await runCheckFixes(fixReport(before.cwd, before.checks), exec)
  if (runs.length === 0) return { ...before, fixes: [] }
  try {
    const child = await exec([bunExecutable(), cliEntry(), ...doctorRecheckArgs(options)], before.cwd)
    if (child.exitCode !== 0) throw new Error('Doctor recheck failed.')
    const parsed: unknown = JSON.parse(child.stdout)
    recheckSchema.parse(parsed)
    const data = parsed as DoctorJsonOutput
    if (!(await sameDirectory(data.cwd, before.cwd))) throw new Error('Doctor recheck returned a different app root.')
    const checks: DoctorCheck[] = data.checks.map(({ fix, manualFix, ...check }) => ({
      ...check, ...(fix === null ? {} : { fix }), ...(manualFix === null ? {} : { manualFix }),
    }))
    // A truncated report cannot certify repairs or preserve unrelated strict warnings.
    if (before.checks.some((check) => !checks.some((after) => after.key === check.key))) {
      throw new Error('Doctor recheck omitted an original check.')
    }
    const after = summarizeDoctorReport(before.cwd, checks, data.nextSteps ?? undefined, data.recommendedCommands)
    // A finding that still fails without naming its repair has not been cleared by it either.
    const repairs = new Map(before.checks.flatMap((check) => (check.repair ? [[check.key, check.repair] as const] : [])))
    const settling = checks.map((check) => ({ ...check, repair: check.repair ?? repairs.get(check.key) }))
    return { ...after, fixes: settleFixRuns(runs, fixReport(before.cwd, settling)) }
  } catch (error) {
    const message = `Could not verify generated-file repairs: ${error instanceof Error ? error.message : String(error)}`
    return { ...before, fixes: runs.map((run) => run.ok ? { ...run, ok: false, output: [message] } : run) }
  }
}
