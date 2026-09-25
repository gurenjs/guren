/**
 * `guren gate`: one exit-coded verdict on a change, composed from the checks the
 * scaffolded CI runs, in its order (codegen, typecheck, lint, check --ci, audit,
 * test), so an agent's "done", a pre-commit run, and CI judge by the same rule.
 * check and audit read the introspected app (RFC 0026 §5) through one run per gate.
 * Every stage runs and reports. A stage that *cannot* run (tool missing, routes
 * unloadable) fails rather than skips: an unavailable check is not a green one.
 * Only an app-declared opt-out (no `.oxlintrc.json`) skips. Subprocess stages go
 * through `exec`, the seam tests fake.
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { consola } from 'consola'
import { runAudit } from './audit'
import { getChangedFiles, runGit } from './changed-files'
import { runCheck } from './check'
import { formatFinding, gatingResults } from './check-result'
import { capFindings, codegenFallback, OUTPUT_ERROR_PATTERN, outputFindings, outputTail, readScripts, resolveScriptCommand } from './command-output'
import { advisoryIntrospection, introspectRunner, type Introspection } from './introspect'
import { INTROSPECTION_UNAVAILABLE } from './manifest-section'
import { isLintable, runOxlint } from './lint-run'
import { bunExecutable, runCaptured, type CapturedExec, type CapturedRun } from './subprocess'

export const GATE_STAGES = ['codegen', 'typecheck', 'lint', 'check', 'audit', 'test'] as const

export type GateStageName = (typeof GATE_STAGES)[number]

export type GateStageStatus = 'pass' | 'fail' | 'skip'

export interface GateStageResult {
  name: GateStageName
  status: GateStageStatus
  durationMs: number
  /** What to fix, one line each. A passing lint stage may still carry warnings here. */
  findings: string[]
  /** Why the stage skipped, or why it could not run. */
  reason?: string
  /** A step the stage ran beyond its default (`--deps` adds the dependency scan to audit). */
  detail?: string
}

export interface GateReport {
  cwd: string
  ok: boolean
  /** Whether `check` and `lint` were narrowed to changed files. */
  changed: boolean
  stages: GateStageResult[]
}

export type GateExec = CapturedExec
export type GateExecResult = CapturedRun

export interface RunGateOptions {
  cwd?: string
  /**
   * Narrow `check` and `lint` to files changed vs. the merge base with `main`.
   * typecheck, audit, and test answer a whole-app question and always run in full.
   */
  changed?: boolean
  /**
   * Scan dependencies in the audit stage (`bun audit`, needs registry access). Off so
   * the gate stays hermetic; the scaffolded CI's `audit` step scans, so a CI that
   * runs the gate instead passes `--deps`.
   */
  deps?: boolean
  routesFile?: string
  /** Defaults to a real subprocess. */
  exec?: GateExec
  /** The introspection the check and audit stages share. Defaults to a run of its own for this gate. */
  introspect?: () => Promise<Introspection>
}

type StageOutcome = Omit<GateStageResult, 'name' | 'durationMs'>

interface StageContext {
  cwd: string
  exec: GateExec
  scripts: Record<string, string>
  changedFiles: Set<string> | null
  routesFile?: string
  deps: boolean
  /** One introspection per gate run, shared by the check and audit stages (RFC 0026 §5). */
  introspect: () => Promise<Introspection>
  /** Whether a stage already reported that the app could not be introspected. */
  introspectionNoted: boolean
}

/**
 * A failed introspection as one finding on the stage that met it first. It never fails the
 * stage: the rules it served fell back to source or report `-unverified`, both advisory.
 */
function introspectionNote(ctx: StageContext, results: ReadonlyArray<{ key: string; title: string; message: string; suggestion?: string }>): string[] {
  const found = results.find((result) => result.key === INTROSPECTION_UNAVAILABLE)
  if (!found || ctx.introspectionNoted) return []
  ctx.introspectionNoted = true
  return [formatFinding({ ...found, title: `${found.title} (advisory)` })]
}

/**
 * A stage backed by the app's own package.json script, else `fallback`, else a
 * failure. Findings are the output lines matching `pattern`, or its tail when
 * none do.
 */
async function scriptStage(
  ctx: StageContext,
  script: string,
  fallback: [label: string, command: string[]] | null,
  pattern: RegExp,
): Promise<StageOutcome> {
  const resolved = resolveScriptCommand(ctx.scripts, script, fallback)
  if (!resolved) {
    return {
      status: 'fail',
      findings: [],
      reason: `no "${script}" script in package.json (\`bunx guren doctor\` can write it)`,
    }
  }
  const result = await ctx.exec(resolved.command, ctx.cwd)
  if (result.exitCode === 0) return { status: 'pass', findings: [] }
  return {
    status: 'fail',
    reason: `\`${resolved.label}\` exited ${result.exitCode}`,
    findings: outputFindings(`${result.stdout}\n${result.stderr}`, pattern),
  }
}

async function lintStage(ctx: StageContext): Promise<StageOutcome> {
  if (!existsSync(join(ctx.cwd, '.oxlintrc.json'))) {
    return { status: 'skip', findings: [], reason: 'no .oxlintrc.json (`bunx guren add lint` opts in)' }
  }
  let files: string[] = []
  if (ctx.changedFiles !== null) {
    files = [...ctx.changedFiles].filter(isLintable).sort()
    if (files.length === 0) return { status: 'skip', findings: [], reason: 'no changed lintable files' }
  }
  const run = await runOxlint(ctx.cwd, files, ctx.exec)
  if (run.kind === 'not-installed') {
    return {
      status: 'fail',
      findings: [],
      reason: '.oxlintrc.json is present but oxlint is not installed: run `bun install`',
    }
  }
  if (run.exitCode !== 0 && run.findings.length === 0) {
    return {
      status: 'fail',
      reason: `oxlint exited ${run.exitCode} without linting`,
      findings: outputTail(run.output),
    }
  }
  // Warnings do not fail (the CI `bun run lint` rule) but are reported: the
  // agent that just wrote the code is the one who can act on them.
  return { status: run.exitCode === 0 ? 'pass' : 'fail', findings: capFindings(run.findings) }
}

async function checkStage(ctx: StageContext): Promise<StageOutcome> {
  const report = await runCheck({
    cwd: ctx.cwd,
    routesFile: ctx.routesFile,
    changedFiles: ctx.changedFiles,
    json: true,
    introspect: ctx.introspect,
  })
  const failing = gatingResults(report)
  const note = introspectionNote(ctx, report.checks)
  return { status: failing.length > 0 ? 'fail' : 'pass', findings: [...capFindings(failing.map(formatFinding)), ...note] }
}

async function auditStage(ctx: StageContext): Promise<StageOutcome> {
  const report = await runAudit({ cwd: ctx.cwd, routesFile: ctx.routesFile, deps: ctx.deps, introspect: ctx.introspect, changedFiles: ctx.changedFiles })
  const failing = report.findings.filter((finding) => finding.status === 'fail')
  const note = introspectionNote(ctx, report.findings)
  const findings = [...capFindings(failing.map(formatFinding)), ...note]
  const detail = ctx.deps ? 'dependency scan' : undefined
  // The `audit` command only warns here; a gate that passed with the
  // route-level rules never having run would be a vacuous green.
  if (!report.routesAnalyzed) {
    return {
      status: 'fail',
      findings,
      detail,
      reason: 'route-level checks did not run (routes could not be loaded; pass --routes if the entry is elsewhere)',
    }
  }
  return { status: failing.length > 0 ? 'fail' : 'pass', findings, detail }
}

const STAGE_RUNNERS: Record<GateStageName, (ctx: StageContext) => Promise<StageOutcome>> = {
  codegen: (ctx) => scriptStage(ctx, 'codegen', codegenFallback(), OUTPUT_ERROR_PATTERN),
  typecheck: (ctx) => scriptStage(ctx, 'typecheck', null, /error TS\d+/u),
  lint: lintStage,
  check: checkStage,
  audit: auditStage,
  test: (ctx) => scriptStage(ctx, 'test', ['bun test', [bunExecutable(), 'test']], /^\(fail\)|^error:|^\s*\d+ fail\b/u),
}

export async function runGate(options: RunGateOptions = {}): Promise<GateReport> {
  const cwd = resolve(options.cwd ?? process.cwd())
  // Outside a git repo there is nothing to narrow to, so the gate runs in full.
  const [changedFiles, scripts] = await Promise.all([
    options.changed ? getChangedFiles(cwd) : null,
    readScripts(cwd),
  ])
  // Its own run, not the process memo: the dev MCP server calls the gate for the whole session,
  // and codegen, the stage before check, is what lets a fresh clone's entry import at all.
  const introspect = introspectRunner(cwd, options.introspect ?? advisoryIntrospection(cwd, { fresh: true }))
  const ctx: StageContext = {
    cwd,
    exec: options.exec ?? runCaptured,
    scripts,
    changedFiles,
    routesFile: options.routesFile,
    deps: options.deps ?? false,
    introspect,
    introspectionNoted: false,
  }

  const stages: GateStageResult[] = []
  // Sequential on purpose: codegen must precede typecheck, check, and test (they
  // read `.guren/`), and the stages compete for the same cores.
  for (const name of GATE_STAGES) {
    const started = performance.now()
    let outcome: StageOutcome
    try {
      outcome = await STAGE_RUNNERS[name](ctx)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      outcome = { status: 'fail', findings: [], reason: `could not run: ${message}` }
    }
    stages.push({ name, durationMs: Math.round(performance.now() - started), ...outcome })
  }

  return {
    cwd,
    ok: stages.every((stage) => stage.status !== 'fail'),
    changed: changedFiles !== null,
    stages,
  }
}

/**
 * The stop-hook verdict for an agent ending a turn in the app at `cwd`: `null` when
 * the app's working tree is clean or the gate passes, else the failures as text to
 * feed back. Outside a git repository the tree cannot be judged clean, so the gate
 * runs. Shared by every agent's stop hook; only the stdin/stdout contract differs.
 */
export async function stopGateFindings(cwd = process.cwd()): Promise<string | null> {
  // Scoped to the app: a monorepo app is not the git root.
  const tree = await runGit(cwd, ['status', '--porcelain', '--', '.'])
  if (tree?.length === 0) return null
  // `--changed`: check and lint on what this session touched; typecheck, audit,
  // and the tests answer for the whole app either way.
  const report = await runGate({ cwd, changed: true })
  if (report.ok) return null
  return `${describeGateFailures(report)}\nRun \`bunx guren gate\` to see every stage.`
}

/** The failing stages as plain text, one line per finding. */
export function describeGateFailures(report: GateReport): string {
  const lines: string[] = []
  for (const stage of report.stages) {
    if (stage.status !== 'fail') continue
    lines.push(`guren gate: ${stage.name} failed${stage.reason ? ` (${stage.reason})` : ''}`)
    for (const finding of stage.findings) lines.push(`- ${finding}`)
  }
  return lines.join('\n')
}

const STAGE_STYLE: Record<GateStageStatus, { label: string; log: (message: string) => void }> = {
  pass: { label: '[ok]', log: (message) => consola.success(message) },
  fail: { label: '[fail]', log: (message) => consola.error(message) },
  skip: { label: '[skip]', log: (message) => consola.info(message) },
}

export function renderGateReport(report: GateReport): void {
  consola.box(`Guren gate for ${report.cwd}${report.changed ? ' (check and lint narrowed to changed files)' : ''}`)

  for (const stage of report.stages) {
    const { label, log } = STAGE_STYLE[stage.status]
    const name = stage.detail ? `${stage.name} + ${stage.detail}` : stage.name
    log(`${label} ${name} (${stage.durationMs}ms)${stage.reason ? `: ${stage.reason}` : ''}`)
    for (const finding of stage.findings) {
      consola.info(`       - ${finding}`)
    }
  }

  const count = (status: GateStageStatus): number => report.stages.filter((stage) => stage.status === status).length
  console.log('')
  console.log(
    `Gate ${report.ok ? 'passed' : 'failed'}: ${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped`,
  )
}
