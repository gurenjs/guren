/**
 * The deploy-runtime verdicts at build time (RFC 0020 Part 0), published as
 * `@guren/core/internal/deploy-check` for the deploy plugins' build commands.
 * Its own entry, not part of `deploy-build`: that one imports node builtins
 * only (its test scans the built artifact), while the scan lives in
 * `@guren/cli`, reached here lazily so nothing loads until a build asks.
 * The CLI reads the introspected app, and reports a verdict it cannot vouch for as unverified (RFC 0026 §5).
 * Warns, never throws: a wrong guess must not block a deploy.
 */

interface DeployCheckCliApi {
  /** Absent on a @guren/cli older than RFC 0020 Part 0. */
  checkDeployRuntime?(cwd: string): Promise<DeployRuntimeVerdict[]>
}

interface DeployRuntimeVerdict {
  title: string
  status: 'pass' | 'warn'
  message: string
  fix?: string
  /** Absent on a @guren/cli older than RFC 0026 Part 2a. */
  evidence?: 'manifest' | 'static' | 'none'
  evidenceReason?: string
}

export interface ReportDeployRuntimeHazardsOptions {
  /** App root the scan reads. */
  root: string
  /** Prefix of every line, e.g. `Cloudflare build`. */
  label: string
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Print one `console.log` line naming the evidence, then every non-passing verdict
 * through `console.warn`, one line each, and return those. A scan that cannot run
 * prints one line saying so rather than nothing: silence would read as a clean report.
 */
export async function reportDeployRuntimeHazards(options: ReportDeployRuntimeHazardsOptions): Promise<string[]> {
  const { root, label } = options

  let cli: DeployCheckCliApi
  try {
    cli = (await import('@guren/cli')) as DeployCheckCliApi
  } catch (error) {
    return skipped(label, `@guren/cli could not be loaded (${describeError(error)})`)
  }

  if (typeof cli.checkDeployRuntime !== 'function') {
    return skipped(label, 'the installed @guren/cli predates them; upgrade it')
  }

  let verdicts: DeployRuntimeVerdict[]
  try {
    verdicts = await cli.checkDeployRuntime(root)
  } catch (error) {
    return skipped(label, `the scan failed (${describeError(error)})`)
  }

  const evidence = describeEvidence(label, verdicts)
  if (evidence) console.log(evidence)

  const lines = verdicts
    .filter((verdict) => verdict.status !== 'pass')
    .map((verdict) => `${label}: ${verdict.message}${verdict.fix ? ` ${verdict.fix}` : ''}`)
  for (const line of lines) {
    console.warn(line)
  }
  return lines
}

/** One line naming what each verdict was judged from, and why the source when the app could not be read. */
function describeEvidence(label: string, verdicts: DeployRuntimeVerdict[]): string | undefined {
  const judged: string[] = []
  for (const { title, evidence } of verdicts) {
    if (evidence === undefined) return undefined
    judged.push(`${title} from ${EVIDENCE_LABELS[evidence]}`)
  }
  if (judged.length === 0) return undefined
  const reasons = [...new Set(verdicts.flatMap((verdict) => (verdict.evidenceReason ? [verdict.evidenceReason] : [])))]
  return `${label}: deploy-runtime checks judged ${judged.join(', ')}${reasons.length > 0 ? ` (${reasons.join('; ')})` : ''}.`
}

const EVIDENCE_LABELS = { manifest: 'the introspected app', static: 'source', none: 'nothing verifiable' } as const

function skipped(label: string, reason: string): string[] {
  const line = `${label}: deploy-runtime checks skipped — ${reason}. Run \`bunx guren doctor\` before deploying.`
  console.warn(line)
  return [line]
}
