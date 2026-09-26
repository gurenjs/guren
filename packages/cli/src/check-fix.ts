import { CHECK_SUITES, type RunCheckOptions } from './check'
import { formatFixCommand, pendingFixes, type CheckFixRun, type CheckReport } from './check-result'
import { cliEntry } from './cli-entry'
import { outputTail } from './command-output'
import { bunExecutable, runCaptured, type CapturedExec } from './subprocess'

/**
 * `guren check --fix`: runs each distinct fix the report's findings carry, in report
 * order, from the app root. A failure does not stop the rest, since each fix rewrites
 * its own generated files; the caller checks again to see what the runs cleared.
 */
export async function runCheckFixes(report: CheckReport, exec: CapturedExec = runCaptured): Promise<CheckFixRun[]> {
  const runs: CheckFixRun[] = []
  for (const fix of pendingFixes(report)) {
    const command = formatFixCommand(fix)
    try {
      const run = await exec([bunExecutable(), cliEntry(), ...fix.args], report.cwd)
      runs.push(run.exitCode === 0 ? { command, ok: true } : { command, ok: false, output: outputTail(`${run.stdout}\n${run.stderr}`) })
    } catch (error) {
      runs.push({ command, ok: false, output: [error instanceof Error ? error.message : String(error)] })
    }
  }
  return runs
}

/** The `guren check --json` arguments that repeat a run with `options`, rooted at the report's app. */
export function recheckArgs(options: RunCheckOptions, cwd: string): string[] {
  const args = ['check', '--json', '--app', cwd]
  if (options.routesFile !== undefined) args.push('--routes', options.routesFile)
  for (const flag of [...CHECK_SUITES, 'changed'] as const) {
    if (options[flag]) args.push(`--${flag}`)
  }
  return args
}

/**
 * The check after the fixes, in a child process: this one has already imported the
 * routes file and everything it reaches, and ESM caches a module that failed to
 * resolve a `.guren/*.gen.ts` codegen has since written. `undefined` when the child
 * printed no report.
 */
export async function recheckInChild(
  options: RunCheckOptions,
  cwd: string,
  exec: CapturedExec = runCaptured,
): Promise<CheckReport | undefined> {
  try {
    const run = await exec([bunExecutable(), cliEntry(), ...recheckArgs(options, cwd)], cwd)
    return JSON.parse(run.stdout) as CheckReport
  } catch {
    return undefined
  }
}

/** A fix that exited 0 while the findings carrying it are still reported did not clear them. */
export function settleFixRuns(runs: CheckFixRun[], after: CheckReport): CheckFixRun[] {
  const remaining = new Set(pendingFixes(after).map(formatFixCommand))
  return runs.map((run) =>
    run.ok && remaining.has(run.command)
      ? { command: run.command, ok: false, output: ['It exited 0, but the findings it fixes are still reported.'] }
      : run,
  )
}
