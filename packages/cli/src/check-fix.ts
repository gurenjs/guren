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
    const run = await exec([bunExecutable(), cliEntry(), ...fix.args], report.cwd)
    runs.push(run.exitCode === 0 ? { command, ok: true } : { command, ok: false, output: outputTail(`${run.stdout}\n${run.stderr}`) })
  }
  return runs
}
