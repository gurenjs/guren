/**
 * `guren gate`: one exit-coded verdict on a change, composed from the checks the
 * scaffolded CI runs (codegen, check --ci, lint, typecheck, audit, test), so an
 * agent's "done", a pre-commit run, and CI judge by the same rule. Every stage runs
 * and reports. A stage that *cannot* run (tool missing, routes unloadable) fails
 * rather than skips: an unavailable check is not a green one. Only an app-declared
 * opt-out (no `.oxlintrc.json`) skips. Subprocess stages go through `exec`, the seam
 * tests fake.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { consola } from 'consola'
import { runAudit } from './audit'
import { getChangedFiles } from './changed-files'
import { runCheck } from './check'
import { gatingResults } from './check-result'
import { resolveRoutesEntry } from './route-registrar'

export const GATE_STAGES = ['codegen', 'check', 'lint', 'typecheck', 'audit', 'test'] as const

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

export interface GateExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** A subprocess run to completion. `command[0]` is the executable. */
export type GateExec = (command: string[], cwd: string) => Promise<GateExecResult>

export interface RunGateOptions {
  cwd?: string
  /**
   * Narrow `check` and `lint` to files changed vs. the merge base with `main`.
   * typecheck, audit, and test answer a whole-app question and always run in full.
   */
  changed?: boolean
  /** Scan dependencies in the audit stage (`bun audit`, needs registry access). Off so the gate stays hermetic. */
  deps?: boolean
  routesFile?: string
  /** Runs codegen, lint, typecheck, and test. Defaults to a real subprocess. */
  exec?: GateExec
}

type StageOutcome = Omit<GateStageResult, 'name' | 'durationMs'>

const LINTABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u
const UNLINTED_PREFIXES = ['.guren/', 'node_modules/', 'dist/', 'public/build/']
/** Findings a stage may report before the rest collapses into one "and N more" line. */
const MAX_FINDINGS = 40
const OUTPUT_TAIL_LINES = 20

function bunExecutable(): string {
  return process.versions.bun ? process.execPath : 'bun'
}

export const defaultGateExec: GateExec = (command, cwd) =>
  new Promise((resolvePromise, rejectPromise) => {
    const [executable, ...args] = command
    if (!executable) {
      rejectPromise(new Error('empty command'))
      return
    }
    // Colour codes would end up inside findings the agent reads back.
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.on('error', rejectPromise)
    child.on('close', (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }))
  })

/**
 * The CLI entry next to this module: `dist/bin.js` in a build, `src/bin.ts` from
 * source. Only reached when the app has no `codegen` script of its own.
 */
function cliBin(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const name of ['bin.js', 'bin.ts']) {
    const candidate = join(here, name)
    if (existsSync(candidate)) return candidate
  }
  return fileURLToPath(import.meta.resolve('@guren/cli/bin'))
}

/** The oxlint shim, wherever the install put it: a workspace may hoist it to an ancestor. */
function resolveOxlint(cwd: string): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', 'oxlint', 'bin', 'oxlint')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) return null
  }
}

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

function outputTail(result: GateExecResult): string[] {
  return nonEmptyLines(`${result.stdout}\n${result.stderr}`).slice(-OUTPUT_TAIL_LINES)
}

function capFindings(findings: string[]): string[] {
  if (findings.length <= MAX_FINDINGS) return findings
  return [...findings.slice(0, MAX_FINDINGS), `... and ${findings.length - MAX_FINDINGS} more`]
}

function isLintable(relPath: string): boolean {
  return LINTABLE.test(relPath) && !UNLINTED_PREFIXES.some((prefix) => relPath.startsWith(prefix))
}

/** Findings from a subprocess: the lines matching `pattern`, or the output tail when none do. */
function subprocessOutcome(
  label: string,
  result: GateExecResult,
  pattern: RegExp,
): StageOutcome {
  if (result.exitCode === 0) return { status: 'pass', findings: [] }
  const matched = nonEmptyLines(`${result.stdout}\n${result.stderr}`).filter((line) => pattern.test(line))
  return {
    status: 'fail',
    reason: `\`${label}\` exited ${result.exitCode}`,
    findings: capFindings(matched.length > 0 ? matched : outputTail(result)),
  }
}

interface StageContext {
  cwd: string
  exec: GateExec
  scripts: Record<string, string>
  changedFiles: Set<string> | null
  routesFile?: string
  deps: boolean
}

async function codegenStage(ctx: StageContext): Promise<StageOutcome> {
  const bun = bunExecutable()
  const [label, command] = ctx.scripts.codegen
    ? ['bun run codegen', [bun, 'run', 'codegen']]
    : ['guren codegen', [bun, cliBin(), 'codegen']]
  return subprocessOutcome(label, await ctx.exec(command, ctx.cwd), /error|Error|failed/u)
}

async function checkStage(ctx: StageContext): Promise<StageOutcome> {
  const report = await runCheck({
    cwd: ctx.cwd,
    routesFile: ctx.routesFile,
    changed: ctx.changedFiles !== null,
    json: true,
  })
  const failing = gatingResults(report)
  return {
    status: failing.length > 0 ? 'fail' : 'pass',
    findings: capFindings(
      failing.map((check) => {
        const location = check.filePath ? ` [${check.filePath}]` : ''
        const suggestion = check.suggestion ? ` -> ${check.suggestion}` : ''
        return `${check.title}: ${check.message}${location}${suggestion}`
      }),
    ),
  }
}

async function lintStage(ctx: StageContext): Promise<StageOutcome> {
  if (!existsSync(join(ctx.cwd, '.oxlintrc.json'))) {
    return { status: 'skip', findings: [], reason: 'no .oxlintrc.json (`bunx guren add lint` opts in)' }
  }
  const shim = resolveOxlint(ctx.cwd)
  if (shim === null) {
    return {
      status: 'fail',
      findings: [],
      reason: '.oxlintrc.json is present but oxlint is not installed: run `bun install`',
    }
  }
  let files: string[] = []
  if (ctx.changedFiles !== null) {
    files = [...ctx.changedFiles].filter(isLintable).sort()
    if (files.length === 0) return { status: 'skip', findings: [], reason: 'no changed lintable files' }
  }
  // The shim under Bun needs no Node. A file the config ignores is "no files to lint", not a failure.
  const result = await ctx.exec(
    [bunExecutable(), shim, '--no-error-on-unmatched-pattern', '--format', 'unix', ...files],
    ctx.cwd,
  )
  const findings = nonEmptyLines(result.stdout).filter((line) => /^[^\s:]+:\d+:\d+:/u.test(line))
  if (result.exitCode !== 0 && findings.length === 0) {
    // A config or plugin-load failure has no file prefix; it must not read as clean.
    return {
      status: 'fail',
      reason: `oxlint exited ${result.exitCode} without linting`,
      findings: outputTail(result),
    }
  }
  // Warnings do not fail (the CI `bun run lint` rule) but are reported: the
  // agent that just wrote the code is the one who can act on them.
  return { status: result.exitCode === 0 ? 'pass' : 'fail', findings: capFindings(findings) }
}

async function typecheckStage(ctx: StageContext): Promise<StageOutcome> {
  if (!ctx.scripts.typecheck) {
    return {
      status: 'fail',
      findings: [],
      reason: 'no "typecheck" script in package.json: add "typecheck": "tsc --noEmit" (`bunx guren doctor` can write it)',
    }
  }
  return subprocessOutcome(
    'bun run typecheck',
    await ctx.exec([bunExecutable(), 'run', 'typecheck'], ctx.cwd),
    /error TS\d+/u,
  )
}

async function auditStage(ctx: StageContext): Promise<StageOutcome> {
  const report = await runAudit({ cwd: ctx.cwd, routesFile: ctx.routesFile, deps: ctx.deps })
  const failing = report.findings.filter((finding) => finding.status === 'fail')
  const findings = capFindings(
    failing.map((finding) => {
      const location = finding.filePath
        ? ` [${finding.filePath}${finding.line ? `:${finding.line}` : ''}]`
        : ''
      const suggestion = finding.suggestion ? ` -> ${finding.suggestion}` : ''
      return `${finding.title}: ${finding.message}${location}${suggestion}`
    }),
  )
  // The `audit` command only warns here; a gate that passed with the
  // route-level rules never having run would be a vacuous green.
  if (!report.routesAnalyzed) {
    return {
      status: 'fail',
      findings,
      reason: 'route-level checks did not run (routes could not be loaded; pass --routes if the entry is not routes/web.ts)',
    }
  }
  return { status: failing.length > 0 ? 'fail' : 'pass', findings }
}

async function testStage(ctx: StageContext): Promise<StageOutcome> {
  const bun = bunExecutable()
  const [label, command] = ctx.scripts.test ? ['bun run test', [bun, 'run', 'test']] : ['bun test', [bun, 'test']]
  return subprocessOutcome(label, await ctx.exec(command, ctx.cwd), /^\(fail\)|^error:|^\s*\d+ fail\b/u)
}

const STAGE_RUNNERS: Record<GateStageName, (ctx: StageContext) => Promise<StageOutcome>> = {
  codegen: codegenStage,
  check: checkStage,
  lint: lintStage,
  typecheck: typecheckStage,
  audit: auditStage,
  test: testStage,
}

export async function runGate(options: RunGateOptions = {}): Promise<GateReport> {
  const cwd = resolve(options.cwd ?? process.cwd())
  // Outside a git repo there is nothing to narrow to, so the gate runs in full.
  const changedFiles = options.changed ? await getChangedFiles(cwd) : null
  // `check` probes the routes entry itself; `audit` defaults to routes/web.ts, so an
  // API-only app (routes/api.ts) would report its routes as unloadable. Probe once here.
  const routesFile = options.routesFile ?? (await resolveRoutesEntry(cwd)) ?? undefined
  const ctx: StageContext = {
    cwd,
    exec: options.exec ?? defaultGateExec,
    scripts: await readScripts(cwd),
    changedFiles,
    routesFile,
    deps: options.deps ?? false,
  }

  const stages: GateStageResult[] = []
  // Sequential on purpose: codegen must precede typecheck, and the stages
  // compete for the same cores.
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

export function renderGateReport(report: GateReport): void {
  consola.box(`Guren gate for ${report.cwd}${report.changed ? ' (check and lint narrowed to changed files)' : ''}`)

  for (const stage of report.stages) {
    const prefix = stage.status === 'pass' ? '[ok]' : stage.status === 'fail' ? '[fail]' : '[skip]'
    const log = stage.status === 'pass' ? consola.success : stage.status === 'fail' ? consola.error : consola.info
    const reason = stage.reason ? `: ${stage.reason}` : ''
    log(`${prefix} ${stage.name} (${stage.durationMs}ms)${reason}`)
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
