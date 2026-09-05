export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface CheckResult {
  key: string
  title: string
  status: CheckStatus
  message: string
  suggestion?: string
  filePath?: string
  /**
   * Advice rather than integrity (e.g. test-coverage nudges): exit-code gates
   * such as `check --ci` skip advisory warns.
   */
  advisory?: boolean
}

export interface CheckReport {
  cwd: string
  checks: CheckResult[]
  passCount: number
  warnCount: number
  failCount: number
  /**
   * What each registered agent's scopes expand to against the loaded route
   * graph (RFC 0017 Open Question 2, answered as a check-time computation).
   *
   * Absent when the app has no `config/agents.ts`, empty when it has one but
   * the route graph was not loaded — two answers a consumer can tell apart.
   */
  agentScopes?: Array<{ agent: string; tools: string[] }>
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
