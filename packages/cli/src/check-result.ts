export type CheckStatus = 'pass' | 'warn' | 'fail'

/**
 * A `guren` command that clears a finding by rewriting generated files only, so it
 * runs unattended: `guren check --fix` runs it. Attach one only when running it
 * leaves no decision to a person; everything else stays in `suggestion`.
 */
export interface CheckFix {
  kind: 'command'
  /** The arguments after `guren`, never a shell string. */
  args: string[]
}

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
  fix?: CheckFix
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
  /** What `check --fix` ran before this report was taken; absent on a run without the flag. */
  fixes?: CheckFixRun[]
}

export interface CheckFixRun {
  command: string
  ok: boolean
  /** The last lines the command printed, kept only when it failed. */
  output?: string[]
}

/**
 * The results an exit-code gate counts (`check --ci`, `guren gate`, the edit hook):
 * warns included, since most integrity problems report as 'warn' and a fail-only
 * gate would wave nearly everything through; advisory checks exempt.
 */
export function gatingResults(report: CheckReport): CheckResult[] {
  return report.checks.filter((result) => !result.advisory && result.status !== 'pass')
}

/**
 * The advisory results a gate still prints: verdicts only the registered app could answer that no
 * manifest vouched for (RFC 0026 §5). Without them a missing session binding or delivery mount, which
 * gate when the app is introspected, would pass a run with no manifest in silence.
 */
export function unverifiedResults(report: CheckReport): CheckResult[] {
  return report.checks.filter((result) => result.evidence === 'none')
}

/** A finding a gate prints without counting it. */
export function formatAdvisoryFinding(finding: Parameters<typeof formatFinding>[0]): string {
  return formatFinding({ ...finding, title: `${finding.title} (advisory)` })
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

export function commandFix(...args: string[]): CheckFix {
  return { kind: 'command', args }
}

/** A generator command that reads the route graph, pointed at the routes file the check read. */
export function routesCommandFix(command: string, routesFile?: string): CheckFix {
  return routesFile === undefined ? commandFix(command) : commandFix(command, '--routes', routesFile)
}

/** The fix as a copy-pasteable command line; an argument is quoted only when a shell would split it. */
export function formatFixCommand(fix: CheckFix): string {
  const words = fix.args.map((arg) => (/^[\w./@:=-]+$/u.test(arg) ? arg : `'${arg.replace(/'/gu, `'\\''`)}'`))
  return ['bunx', 'guren', ...words].join(' ')
}

/**
 * The distinct fixes a report's findings carry, in report order: every finding one
 * `codegen` run clears names the same arguments, so the run happens once.
 */
export function pendingFixes(report: CheckReport): CheckFix[] {
  const seen = new Map<string, CheckFix>()
  for (const result of report.checks) {
    if (result.status === 'pass' || !result.fix) continue
    const key = JSON.stringify(result.fix.args)
    if (!seen.has(key)) seen.set(key, result.fix)
  }
  return [...seen.values()]
}
