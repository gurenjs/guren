import type { DoctorCheck, DoctorReport, NextStep } from './doctor'

// Values doctor.ts and doctor-fix.ts both read: doctor.ts imports doctor-fix.ts, so these cannot live in doctor.ts.
export const DOCTOR_STATUSES = ['pass', 'warn', 'fail'] as const
export type DoctorStatus = (typeof DOCTOR_STATUSES)[number]

export const DOCTOR_RECOMMENDED_COMMANDS = [
  'bunx guren codegen --force',
  'bun run typecheck',
  'bun run build',
]

export function summarizeDoctorReport(
  cwd: string,
  checks: DoctorCheck[],
  nextSteps?: NextStep[],
  recommendedCommands: string[] = [...DOCTOR_RECOMMENDED_COMMANDS],
): DoctorReport {
  return {
    cwd,
    checks,
    fixableChecks: checks.filter((check) => check.status !== 'pass' && Boolean(check.canAutofix)),
    manualChecks: checks.filter((check) => check.status !== 'pass' && !check.canAutofix),
    hasWarnings: checks.some((check) => check.status === 'warn'),
    hasFailures: checks.some((check) => check.status === 'fail'),
    recommendedCommands,
    ...(nextSteps ? { nextSteps } : {}),
  }
}
