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
  inspectDeployTarget?(cwd: string, options: { target: 'cloudflare' }): Promise<{ verdicts: DeployRuntimeVerdict[]; app: DeployTargetApp }>
}

/**
 * Restates `DeployTargetApp` in @guren/cli's deploy-runtime.ts structurally, since this module imports
 * no CLI type: the CLI an app installs may be older or newer than this core.
 * The app as the target runs it, for the deploy plugin to read its bindings from (RFC 0035 §2):
 * the introspected `storage` and `database` sections the CLI vouches for, or why they could not be read.
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
  const bail = (reason: string) => ({ hazards: skipped(label, reason), ...(target ? { app: unread(reason) } : {}) })

  let cli: DeployCheckCliApi
  try {
    cli = (await import('@guren/cli')) as DeployCheckCliApi
  } catch (error) {
    return bail(`@guren/cli could not be loaded (${describeError(error)})`)
  }

  if (typeof cli.checkDeployRuntime !== 'function') {
    return bail('the installed @guren/cli predates them; upgrade it')
  }

  let verdicts: DeployRuntimeVerdict[]
  let app: DeployTargetApp | undefined
  try {
    if (target && typeof cli.inspectDeployTarget === 'function') {
      ;({ verdicts, app } = await cli.inspectDeployTarget(root, { target }))
    } else {
      verdicts = await cli.checkDeployRuntime(root, { target })
      if (target) app = unread('the installed @guren/cli predates inspectDeployTarget(); upgrade it')
    }
  } catch (error) {
    return bail(`the scan failed (${describeError(error)})`)
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

function unread(reason: string): DeployTargetApp {
  return { status: 'unread', reason }
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
