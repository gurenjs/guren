export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface CheckResult {
  key: string
  title: string
  status: CheckStatus
  message: string
  suggestion?: string
  filePath?: string
  /** Set by the checks that read the manifest; absent on every other check. */
  evidence?: CheckEvidence
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

/**
 * The results an exit-code gate counts (`check --ci`, `guren gate`, the edit hook):
 * warns included, since most integrity problems report as 'warn' and a fail-only
 * gate would wave nearly everything through; advisory checks exempt.
 */
export function gatingResults(report: CheckReport): CheckResult[] {
  return report.checks.filter((result) => !result.advisory && result.status !== 'pass')
}

/** One finding as the line a gate or hook feeds back: `title: message [file:line] -> suggestion`. */
export function formatFinding(finding: {
  title: string
  message: string
  filePath?: string
  line?: number
  suggestion?: string
}): string {
  const location = finding.filePath ? ` [${finding.filePath}${finding.line ? `:${finding.line}` : ''}]` : ''
  const suggestion = finding.suggestion ? ` -> ${finding.suggestion}` : ''
  return `${finding.title}: ${finding.message}${location}${suggestion}`
}

/**
 * What a verdict was judged from (RFC 0026 §5): the introspected app's manifest,
 * the source scan it falls back to, or nothing, which is never a pass.
 */
export type CheckEvidence = 'manifest' | 'static' | 'none'

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

/** A warning `check --ci` and `guren gate` do not count. */
export function advisory(...args: Parameters<typeof check>): CheckResult {
  return { ...check(...args), advisory: true }
}
