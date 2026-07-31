export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface CheckResult {
  key: string
  title: string
  status: CheckStatus
  message: string
  suggestion?: string
  filePath?: string
  /**
   * Advice rather than integrity (e.g. test-coverage nudges): exit-code
   * gates such as `check --ci` skip advisory warns, and JSON consumers can
   * predict the exit code without re-deriving the rule from finding keys.
   */
  advisory?: boolean
}

export interface CheckReport {
  cwd: string
  checks: CheckResult[]
  passCount: number
  warnCount: number
  failCount: number
}

export function check(
  key: string,
  title: string,
  status: CheckStatus,
  message: string,
  suggestion?: string,
  filePath?: string,
): CheckResult {
  return { key, title, status, message, suggestion, filePath }
}
