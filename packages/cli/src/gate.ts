/**
 * `guren gate`: one exit-coded verdict on a change, composed from the checks the
 * scaffolded CI runs, in its order (codegen, typecheck, lint, check --ci, audit,
 * test), so an agent's "done", a pre-commit run, and CI judge by the same rule.
 * Every stage runs and reports. A stage that *cannot* run (tool missing, routes
 * unloadable) fails rather than skips: an unavailable check is not a green one.
 * Only an app-declared opt-out (no `.oxlintrc.json`) skips. Subprocess stages go
 * through `exec`, the seam tests fake.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { consola } from 'consola'
import { runAudit } from './audit'
import { getChangedFiles } from './changed-files'
import { runCheck } from './check'
import { formatFinding, gatingResults } from './check-result'
import { cliEntry } from './cli-entry'
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
}

type StageOutcome = Omit<GateStageResult, 'name' | 'durationMs'>

/** Findings a stage may report before the rest collapses into one "and N more" line. */
const MAX_FINDINGS = 40
const OUTPUT_TAIL_LINES = 20

async function readScripts(cwd: string): Promise<Record<string, string>> {
  try {
    const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    return manifest.scripts ?? {}
  } catch {
    return {}
  }
}

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
}

function capFindings(findings: string[]): string[] {
  if (findings.length <= MAX_FINDINGS) return findings
  return [...findings.slice(0, MAX_FINDINGS), `... and ${findings.length - MAX_FINDINGS} more`]
}

interface StageContext {
  cwd: string
  exec: GateExec
  scripts: Record<string, string>
  changedFiles: Set<string> | null
  routesFile?: string
  deps: boolean
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
  let label: string
  let command: string[]
  if (ctx.scripts[script]) {
    label = `bun run ${script}`
    command = [bunExecutable(), 'run', script]
  } else if (fallback) {
    ;[label, command] = fallback
  } else {
    return {
      status: 'fail',
      findings: [],
      reason: `no "${script}" script in package.json (\`bunx guren doctor\` can write it)`,
    }
  }
  const result = await ctx.exec(command, ctx.cwd)
  if (result.exitCode === 0) return { status: 'pass', findings: [] }
  const lines = nonEmptyLines(`${result.stdout}\n${result.stderr}`)
  const matched = lines.filter((line) => pattern.test(line))
  return {
    status: 'fail',
    reason: `\`${label}\` exited ${result.exitCode}`,
    findings: capFindings(matched.length > 0 ? matched : lines.slice(-OUTPUT_TAIL_LINES)),
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
      findings: nonEmptyLines(run.output).slice(-OUTPUT_TAIL_LINES),
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
  })
  const failing = gatingResults(report)
  return { status: failing.length > 0 ? 'fail' : 'pass', findings: capFindings(failing.map(formatFinding)) }
}

async function auditStage(ctx: StageContext): Promise<StageOutcome> {
  const report = await runAudit({ cwd: ctx.cwd, routesFile: ctx.routesFile, deps: ctx.deps })
  const failing = report.findings.filter((finding) => finding.status === 'fail')
  const findings = capFindings(failing.map(formatFinding))
  // The `audit` command only warns here; a gate that passed with the
  // route-level rules never having run would be a vacuous green.
  if (!report.routesAnalyzed) {
    return {
      status: 'fail',
      findings,
      reason: 'route-level checks did not run (routes could not be loaded; pass --routes if the entry is elsewhere)',
    }
  }
  return { status: failing.length > 0 ? 'fail' : 'pass', findings }
}

const STAGE_RUNNERS: Record<GateStageName, (ctx: StageContext) => Promise<StageOutcome>> = {
  codegen: (ctx) => scriptStage(ctx, 'codegen', ['guren codegen', [bunExecutable(), cliEntry(), 'codegen']], /error|Error|failed/u),
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
  const ctx: StageContext = {
    cwd,
    exec: options.exec ?? runCaptured,
    scripts,
    changedFiles,
    routesFile: options.routesFile,
    deps: options.deps ?? false,
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
 * The stop-hook verdict for an agent ending a turn in `cwd`: `null` when the
 * working tree is clean or the gate passes, else the failures as text to feed
 * back. Outside a git repository the tree cannot be judged clean, so the gate
 * runs. Shared by every agent's stop hook; only the stdin/stdout contract differs.
 */
export async function stopGateFindings(cwd = process.cwd()): Promise<string | null> {
  const tree = await runCaptured(['git', 'status', '--porcelain'], cwd).catch(() => null)
  if (tree?.exitCode === 0 && tree.stdout.trim() === '') return null
  // `--changed`: check and lint on what this session touched; typecheck, audit,
  // and the tests answer for the whole app either way.
  const report = await runGate({ cwd, changed: true })
  if (report.ok) return null
  return `${describeGateFailures(report)}\nRun \`bunx guren gate\` to see every stage.`
}

/** The failing stages as plain text: what a hook feeds back to the agent. */
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
    log(`${label} ${stage.name} (${stage.durationMs}ms)${stage.reason ? `: ${stage.reason}` : ''}`)
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
