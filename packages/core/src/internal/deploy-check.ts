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
  /** Absent on a @guren/cli older than RFC 0020 Part 0; `options` is ignored by one older than RFC 0035 §2.1. */
  checkDeployRuntime?(cwd: string, options?: { target?: 'cloudflare' }): Promise<DeployRuntimeVerdict[]>
  /** Absent on a @guren/cli older than RFC 0035 §2. */
  inspectDeployTarget?(cwd: string, options: { target: 'cloudflare' }): Promise<{ verdicts: DeployRuntimeVerdict[]; introspection?: IntrospectionResult }>
}

/** The part of the CLI's `Introspection` a deploy reads; every other field is ignored. */
type IntrospectionResult =
  | { status: 'ok'; manifest: { storage?: unknown; database?: unknown } }
  | { status: 'failed'; reason: string; message: string }

/**
 * The app as the target runs it, for the deploy plugin to read its bindings from (RFC 0035 §2):
 * the introspected `storage` and `database` sections, or why they could not be read.
 */
export type DeployTargetApp =
  | { status: 'read'; storage?: unknown; database?: unknown }
  | { status: 'unread'; reason: string }

interface DeployRuntimeVerdict {
  title: string
  status: 'pass' | 'warn'
  message: string
  fix?: string
  /** Absent on a @guren/cli older than RFC 0026 Part 2a. */
  evidence?: 'manifest' | 'static' | 'none'
  evidenceReason?: string
  /** Absent on a @guren/cli older than RFC 0035 §2.1, which introspects the dev branch whatever `target` says. */
  introspectedAs?: 'cloudflare'
}

export interface ReportDeployRuntimeHazardsOptions {
  /** App root the scan reads. */
  root: string
  /** Prefix of every line, e.g. `Cloudflare build`. */
  label: string
  /** Judge the app's branch for this platform (RFC 0035 §2.1), for a plugin whose `env` subpath honours it. */
  target?: 'cloudflare'
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
  return (await inspectDeployRuntime(options)).hazards
}

/**
 * {@link reportDeployRuntimeHazards}, also returning the introspected app when `target` is set, from
 * the same child. A CLI that cannot return it leaves `app` unread, which fails nothing.
 */
export async function inspectDeployRuntime(
  options: ReportDeployRuntimeHazardsOptions,
): Promise<{ hazards: string[]; app?: DeployTargetApp }> {
  const { root, label, target } = options

  let cli: DeployCheckCliApi
  try {
    cli = (await import('@guren/cli')) as DeployCheckCliApi
  } catch (error) {
    const reason = `@guren/cli could not be loaded (${describeError(error)})`
    return { hazards: skipped(label, reason), ...(target ? { app: { status: 'unread', reason } } : {}) }
  }

  if (typeof cli.checkDeployRuntime !== 'function') {
    return { hazards: skipped(label, 'the installed @guren/cli predates them; upgrade it'), ...(target ? { app: { status: 'unread', reason: 'the installed @guren/cli predates the deploy checks' } } : {}) }
  }

  let verdicts: DeployRuntimeVerdict[]
  let app: DeployTargetApp | undefined
  try {
    if (target && typeof cli.inspectDeployTarget === 'function') {
      const inspection = await cli.inspectDeployTarget(root, { target })
      verdicts = inspection.verdicts
      app = readTargetApp(inspection.introspection)
    } else {
      verdicts = await cli.checkDeployRuntime(root, { target })
      if (target) app = { status: 'unread', reason: 'the installed @guren/cli predates inspectDeployTarget(); upgrade it' }
    }
  } catch (error) {
    const reason = `the scan failed (${describeError(error)})`
    return { hazards: skipped(label, reason), ...(target ? { app: { status: 'unread', reason } } : {}) }
  }

  const evidence = describeEvidence(label, verdicts)
  if (evidence) console.log(evidence)

  const lines = verdicts
    .filter((verdict) => verdict.status !== 'pass')
    .map((verdict) => `${label}: ${verdict.message}${verdict.fix ? ` ${verdict.fix}` : ''}`)
  for (const line of lines) {
    console.warn(line)
  }
  return { hazards: lines, ...(app ? { app } : {}) }
}

function readTargetApp(introspection: IntrospectionResult | undefined): DeployTargetApp {
  if (!introspection) return { status: 'unread', reason: 'the app declares no deploy target, so it was not introspected' }
  if (introspection.status !== 'ok') return { status: 'unread', reason: `introspection failed with ${introspection.reason}: ${introspection.message}` }
  const { storage, database } = introspection.manifest
  return { status: 'read', ...(storage !== undefined ? { storage } : {}), ...(database !== undefined ? { database } : {}) }
}

/** One line naming what each verdict was judged from, and why the source when the app could not be read. */
function describeEvidence(label: string, verdicts: DeployRuntimeVerdict[]): string | undefined {
  const judged: string[] = []
  for (const { title, evidence, introspectedAs } of verdicts) {
    if (evidence === undefined) return undefined
    judged.push(`${title} from ${EVIDENCE_LABELS[evidence]}${introspectedAs ? ` as ${TARGET_LABELS[introspectedAs]} runs it` : ''}`)
  }
  if (judged.length === 0) return undefined
  const reasons = [...new Set(verdicts.flatMap((verdict) => (verdict.evidenceReason ? [verdict.evidenceReason] : [])))]
  return `${label}: deploy-runtime checks judged ${judged.join(', ')}${reasons.length > 0 ? ` (${reasons.join('; ')})` : ''}.`
}

const EVIDENCE_LABELS = { manifest: 'the introspected app', static: 'source', none: 'nothing verifiable' } as const
/** Matches `SERVERLESS_RUNTIME_LABELS` in @guren/server, which this module does not import. */
const TARGET_LABELS = { cloudflare: 'Cloudflare Workers' } as const

function skipped(label: string, reason: string): string[] {
  const line = `${label}: deploy-runtime checks skipped — ${reason}. Run \`bunx guren doctor\` before deploying.`
  console.warn(line)
  return [line]
}
