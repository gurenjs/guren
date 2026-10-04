import { z } from 'zod'
import type { DoctorCheck, DoctorReport, RunDoctorOptions } from './doctor'
import { runCheckFixes, settleFixRuns } from './check-fix'
import { formatFixCommand, type CheckReport } from './check-result'
import { cliEntry } from './cli-entry'
import { bunExecutable, runCaptured, type CapturedExec } from './subprocess'

const recheckSchema = z.object({
  version: z.literal(1),
  cwd: z.string(),
  checks: z.array(z.object({
    key: z.string(), title: z.string(), status: z.enum(['pass', 'warn', 'fail']), message: z.string(),
    fix: z.string().nullable(), canAutofix: z.boolean(), manualFix: z.string().nullable(),
    repair: z.object({ kind: z.literal('command'), args: z.array(z.string()) }).optional(),
    evidence: z.enum(['manifest', 'static', 'none']).optional(), evidenceReason: z.string().optional(),
  })),
  nextSteps: z.array(z.object({
    priority: z.number(), title: z.string(), description: z.string(),
    filePath: z.string().optional(), command: z.string().optional(), content: z.string().optional(),
  })).nullable(),
  recommendedCommands: z.array(z.string()),
})

function fixReport(report: DoctorReport): CheckReport {
  const checks = report.checks.map(({ repair, ...check }) => ({ ...check, fix: repair }))
  return {
    cwd: report.cwd, checks,
    passCount: checks.filter((check) => check.status === 'pass').length,
    warnCount: checks.filter((check) => check.status === 'warn').length,
    failCount: checks.filter((check) => check.status === 'fail').length,
  }
}

export function doctorRecheckArgs(options: RunDoctorOptions): string[] {
  return ['doctor', '--json', ...(options.next ? ['--next'] : []), ...(options.introspect ? [] : ['--no-introspect'])]
}

/** Re-read in a child: generators can clear failed imports that this process's ESM cache retains. */
export async function repairDoctorReport(
  before: DoctorReport,
  options: RunDoctorOptions,
  exec: CapturedExec = runCaptured,
): Promise<DoctorReport> {
  const runs = await runCheckFixes(fixReport(before), exec)
  if (runs.length === 0) return { ...before, fixes: [] }
  try {
    const child = await exec([bunExecutable(), cliEntry(), ...doctorRecheckArgs(options)], before.cwd)
    if (child.exitCode !== 0) throw new Error('Doctor recheck failed.')
    const data = recheckSchema.parse(JSON.parse(child.stdout))
    if (data.cwd !== before.cwd) throw new Error('Doctor recheck returned a different app root.')
    const checks: DoctorCheck[] = data.checks.map(({ fix, manualFix, ...check }) => ({
      ...check, ...(fix === null ? {} : { fix }), ...(manualFix === null ? {} : { manualFix }),
    }))
    // A truncated report cannot certify repairs or preserve unrelated strict warnings.
    if (before.checks.some((check) => !checks.some((after) => after.key === check.key))) {
      throw new Error('Doctor recheck omitted an original check.')
    }
    const after: DoctorReport = {
      cwd: data.cwd, checks,
      fixableChecks: checks.filter((check) => check.status !== 'pass' && check.canAutofix),
      manualChecks: checks.filter((check) => check.status !== 'pass' && !check.canAutofix),
      hasWarnings: checks.some((check) => check.status === 'warn'),
      hasFailures: checks.some((check) => check.status === 'fail'),
      ...(data.nextSteps === null ? {} : { nextSteps: data.nextSteps }),
      recommendedCommands: data.recommendedCommands,
    }
    const fixes = settleFixRuns(runs, fixReport(after)).map((run) => {
      const unsettled = before.checks.some((check) => check.repair && formatFixCommand(check.repair) === run.command
        && checks.find((current) => current.key === check.key)?.status !== 'pass')
      return run.ok && unsettled
        ? { ...run, ok: false, output: ['It exited 0, but the generated-file findings did not pass recheck.'] }
        : run
    })
    return { ...after, fixes }
  } catch (error) {
    const message = `Could not verify generated-file repairs: ${error instanceof Error ? error.message : String(error)}`
    return { ...before, fixes: runs.map((run) => run.ok ? { ...run, ok: false, output: [message] } : run) }
  }
}
