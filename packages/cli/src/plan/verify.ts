/**
 * The executing half of `guren plan:verify` (RFC 0030 §6): runs a step's verify commands
 * and its tests, and records the result at a fingerprint of the files that hold the
 * step's elements. `bun test` boots the application and `db:migrate` opens the configured
 * database, so this runs where those can. What cannot run here (no script, no tool, no
 * database reachable, a timeout) is `blocked`, never a failed implementation.
 * Subprocesses go through `exec`, the seam tests fake.
 */

import { readFile, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCheck } from '../check'
import { formatFinding, gatingResults, type CheckReport } from '../check-result'
import { cliEntry } from '../cli-entry'
import { capFindings, nonEmptyLines, OUTPUT_TAIL_LINES, outputFindings, resolveScriptCommand } from '../command-output'
import { discoverTestFiles, toPosixRelative } from '../discovery'
import { bunExecutable, type CapturedExec, type CapturedRun } from '../subprocess'
import {
  acceptanceStatus,
  bracketedTokens,
  planAcceptanceIds,
  type AcceptanceBehaviourStatus,
  type AcceptanceError,
  type AcceptanceReport,
} from './acceptance-status'
import type { Plan, PlanDraft } from './schema'
import type { PlanCommandRecord, PlanFingerprint, PlanStepRecord } from './state'
import { awaitsVerification, type PlanElementStatus, type PlanStatus } from './status'
import { findPlanStep, type PlanDerivedStep, type PlanTaskDerivation, type PlanVerifyCommand } from './tasks'
import { hashFiles } from './verification'

export interface PlanStepVerification {
  stepId: string
  taskId: string
  record: PlanStepRecord
}

export interface PlanVerifierOptions {
  root: string
  /** What every record of this verifier names as the plan it ran against. */
  planDigest: string
  /** Defaults to a real subprocess. */
  exec: CapturedExec
  /** Per command. A child killed for it is `blocked`. */
  timeoutMs: number
  /** The app's `package.json` scripts. */
  scripts: Record<string, string>
  /** Defaults to `runCheck()` against `root`. */
  check?: () => Promise<CheckReport>
  /** Test files, absolute. Defaults to `discoverTestFiles(root)`. */
  testFiles?: () => Promise<string[]>
  now?: () => Date
}

type CommandOutcome = Omit<PlanCommandRecord, 'command' | 'durationMs'>

/**
 * Output that says the database, not the migration, is what failed. A migration that
 * fails for any other reason is a failed implementation, so the list stays short and
 * literal: a broader one would turn real failures into environment problems.
 */
const DATABASE_SIGNATURES = [
  /\bECONNREFUSED\b/u,
  /\bENOTFOUND\b/u,
  /\bEAI_AGAIN\b/u,
  /\bECONNRESET\b/u,
  /connection refused/iu,
  /could not connect/iu,
  /password authentication failed/iu,
  /\bSQLITE_CANTOPEN\b/u,
  /drizzle-kit[^\n]*not (?:found|installed)/iu,
]

/** A shell's "command not found", which every script-backed command may hit: the tool, not the code, is missing. */
const MISSING_TOOL_EXIT_CODE = 127
const MISSING_TOOL_PATTERN = /command not found/iu

const TYPECHECK_PATTERN = /error TS\d+/u
const CODEGEN_PATTERN = /error|Error|failed/u

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function currentEnvironment(): PlanFingerprint['environment'] {
  return {
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
    platform: process.platform,
    arch: process.arch,
    hostname: hostname(),
  }
}

/** The test files, app-relative, whose source carries any of `ids` as a literal bracketed token. */
export async function acceptanceTestFiles(root: string, files: readonly string[], ids: readonly string[]): Promise<string[]> {
  const wanted = new Set(ids)
  if (wanted.size === 0) return []
  const matched: string[] = []
  for (const file of files) {
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch {
      continue
    }
    if (bracketedTokens(source).some((token) => wanted.has(token))) matched.push(toPosixRelative(root, file))
  }
  return matched.sort()
}

function stepOutcome(commands: readonly PlanCommandRecord[], incomplete: readonly string[]): PlanStepRecord['outcome'] {
  if (commands.some((command) => command.status === 'blocked')) return 'blocked'
  if (commands.some((command) => command.status === 'fail')) return 'failed'
  return incomplete.length > 0 ? 'incomplete' : 'verified'
}

function describeCases(cases: ReadonlyArray<{ title: string; outcome: string }>): string {
  if (cases.length === 0) return ''
  return `: ${cases.map((entry) => `${entry.outcome} "${entry.title}"`).join('; ')}`
}

function describeAcceptanceError(error: AcceptanceError): string {
  if (error.kind === 'id-in-several-files') return `[${error.id}] is carried by ${error.files.join(' and ')}`
  return `[${error.id}] in ${error.file} ("${error.title}") is not a behaviour of the plan`
}

/** `tests`: every behaviour of the step must be `passing`. */
function notPassing(ids: readonly string[], behaviours: readonly AcceptanceBehaviourStatus[]): string[] {
  const findings: string[] = []
  for (const id of ids) {
    const behaviour = behaviours.find((candidate) => candidate.id === id)
    if (!behaviour) findings.push(`[${id}] is pending`)
    else if (behaviour.status !== 'passing') findings.push(`[${id}] is ${behaviour.status}${describeCases(behaviour.cases)}`)
  }
  return findings
}

/** `tests:fail`: every behaviour must have a case, and each case must have failed; a skipped case is not a run. */
function notFailing(ids: readonly string[], behaviours: readonly AcceptanceBehaviourStatus[]): string[] {
  const findings: string[] = []
  for (const id of ids) {
    const behaviour = behaviours.find((candidate) => candidate.id === id)
    if (!behaviour || behaviour.cases.length === 0) findings.push(`[${id}] has no test`)
    else if (!behaviour.cases.every((entry) => entry.outcome === 'failed')) {
      findings.push(`[${id}] must fail before its implementation exists${describeCases(behaviour.cases)}`)
    }
  }
  return findings
}

interface TestRun {
  /** App-relative, sorted: what `bun test` is given. */
  files: string[]
  label: string
  /** Set once a tests command ran the files. */
  result?: CapturedRun
  report?: AcceptanceReport
}

/**
 * Runs steps of one plan against one application. A command runs once per verifier and
 * its result is reused, since a verifier lives for one invocation and every step's list
 * opens with `codegen`, so nothing is judged before the generated files exist. One
 * `bun test` runs per file set; `tests` and `tests:fail` judge the same run differently.
 */
export class PlanVerifier {
  private readonly commands = new Map<string, Promise<PlanCommandRecord>>()
  /** Keyed by the step's acceptance ids: the selected files, then the run over them. */
  private readonly testRuns = new Map<string, Promise<TestRun>>()
  private readonly elements: Map<string, PlanElementStatus>
  private readonly declaredIds: string[]
  private testFilesPromise: Promise<string[]> | undefined

  constructor(
    plan: PlanDraft | Plan,
    status: PlanStatus,
    private readonly derivation: PlanTaskDerivation,
    private readonly options: PlanVerifierOptions,
  ) {
    this.elements = new Map(status.elements.map((element) => [element.id, element]))
    this.declaredIds = planAcceptanceIds(plan)
  }

  async verify(stepId: string): Promise<PlanStepVerification> {
    const found = findPlanStep(this.derivation, stepId)
    if (!found) throw new Error(`no step ${stepId} is derived from this plan`)
    const started = performance.now()
    const ranAt = (this.options.now ?? (() => new Date()))().toISOString()
    const run = await this.runStep(found.step)
    return {
      stepId,
      taskId: found.task.id,
      record: { planDigest: this.options.planDigest, ranAt, durationMs: Math.round(performance.now() - started), ...run },
    }
  }

  private async runStep(step: PlanDerivedStep): Promise<Omit<PlanStepRecord, 'planDigest' | 'ranAt' | 'durationMs'>> {
    const commands: PlanCommandRecord[] = []
    // Sequential on purpose: codegen writes what typecheck, check and the tests read.
    for (const command of step.verify) commands.push(await this.command(command, step))

    // An owned id the status did not judge can never verify: listing it keeps a new section from reading as green.
    const incomplete: string[] = []
    const owned: PlanElementStatus[] = []
    for (const id of step.elementIds) {
      const element = this.elements.get(id)
      if (!element) incomplete.push(`${id}: not judged by plan:status`)
      else if (!awaitsVerification(element)) incomplete.push(`${id}: ${element.state}`)
      else owned.push(element)
    }

    const tests = await this.testRun(step)
    const files = [...new Set([...owned.flatMap((element) => element.files), ...tests.files])].sort()
    const fingerprint: PlanFingerprint = {
      files: Object.fromEntries(await hashFiles(this.options.root, files)),
      environment: currentEnvironment(),
    }

    const behaviours = tests.report?.state === 'judged' ? tests.report.behaviours : []
    const acceptance = step.acceptanceIds.map((id) => ({ id, status: behaviours.find((behaviour) => behaviour.id === id)?.status ?? ('pending' as const) }))
    return { outcome: stepOutcome(commands, incomplete), commands, acceptance, incomplete, fingerprint }
  }

  private command(command: PlanVerifyCommand, step: PlanDerivedStep): Promise<PlanCommandRecord> {
    const key = command === 'tests' || command === 'tests:fail' ? `${command}:${this.testKey(step)}` : command
    let pending = this.commands.get(key)
    if (!pending) {
      pending = this.runCommand(command, step)
      this.commands.set(key, pending)
    }
    return pending
  }

  private async runCommand(command: PlanVerifyCommand, step: PlanDerivedStep): Promise<PlanCommandRecord> {
    const started = performance.now()
    let outcome: CommandOutcome
    try {
      outcome = await this.dispatch(command, step)
    } catch (error) {
      outcome = { label: command, status: 'blocked', reason: `could not run: ${reasonOf(error)}`, findings: [] }
    }
    return { command, durationMs: Math.round(performance.now() - started), ...outcome }
  }

  private dispatch(command: PlanVerifyCommand, step: PlanDerivedStep): Promise<CommandOutcome> {
    switch (command) {
      case 'codegen':
        return this.script('codegen', ['guren codegen', [bunExecutable(), cliEntry(), 'codegen']], CODEGEN_PATTERN)
      case 'typecheck':
        return this.script('typecheck', null, TYPECHECK_PATTERN)
      case 'db:migrate':
        return this.script('db:migrate', null, /error|Error|failed/u, DATABASE_SIGNATURES)
      case 'check':
        return this.check()
      case 'tests':
      case 'tests:fail':
        return this.tests(command, step)
    }
  }

  private exec(command: string[]): Promise<CapturedRun> {
    return this.options.exec(command, this.options.root, { timeoutMs: this.options.timeoutMs })
  }

  /**
   * A command backed by the app's own script, else `fallback`, else `blocked`: a missing
   * script is the environment's to fix, as is a tool the shell cannot find and any
   * output matching `blockedWhen`.
   */
  private async script(script: string, fallback: [label: string, command: string[]] | null, pattern: RegExp, blockedWhen: readonly RegExp[] = []): Promise<CommandOutcome> {
    const resolved = resolveScriptCommand(this.options.scripts, script, fallback)
    if (!resolved) return { label: `bun run ${script}`, status: 'blocked', reason: `no "${script}" script in package.json`, findings: [] }
    const { label } = resolved
    const result = await this.exec(resolved.command)
    if (result.timedOut) return { label, status: 'blocked', reason: `\`${label}\` timed out after ${this.options.timeoutMs} ms`, findings: [] }
    if (result.exitCode === 0) return { label, status: 'pass', findings: [] }
    const output = `${result.stdout}\n${result.stderr}`
    const findings = outputFindings(output, pattern)
    if (result.exitCode === MISSING_TOOL_EXIT_CODE || MISSING_TOOL_PATTERN.test(output)) {
      return { label, status: 'blocked', reason: `\`${label}\` exited ${result.exitCode}: a tool it needs is not installed`, findings }
    }
    if (blockedWhen.some((signature) => signature.test(output))) {
      return { label, status: 'blocked', reason: `\`${label}\` exited ${result.exitCode} on what reads as an unreachable database`, findings }
    }
    return { label, status: 'fail', reason: `\`${label}\` exited ${result.exitCode}`, findings }
  }

  private async check(): Promise<CommandOutcome> {
    const label = 'guren check'
    let report: CheckReport
    try {
      report = await (this.options.check ?? (() => runCheck({ cwd: this.options.root, json: true })))()
    } catch (error) {
      return { label, status: 'blocked', reason: `could not run: ${reasonOf(error)}`, findings: [] }
    }
    const failing = gatingResults(report)
    return { label, status: failing.length > 0 ? 'fail' : 'pass', findings: capFindings(failing.map(formatFinding)) }
  }

  private testKey(step: PlanDerivedStep): string {
    return [...step.acceptanceIds].sort().join('\0')
  }

  /** The step's test files, and with `run` the one run over them, whichever tests command asked first. */
  private testRun(step: PlanDerivedStep, run = false): Promise<TestRun> {
    const key = this.testKey(step)
    const selected = this.testRuns.get(key) ?? this.selectTests(step)
    const pending = run ? selected.then((entry) => (entry.result ? entry : this.runTests(entry))) : selected
    this.testRuns.set(key, pending)
    return pending
  }

  private async selectTests(step: PlanDerivedStep): Promise<TestRun> {
    this.testFilesPromise ??= (this.options.testFiles ?? (() => discoverTestFiles(this.options.root)))().catch((): string[] => [])
    const files = await acceptanceTestFiles(this.options.root, await this.testFilesPromise, step.acceptanceIds)
    return { files, label: `bun test ${files.join(' ')}`.trimEnd() }
  }

  /**
   * `bun test` on the selected files, never `-t`: a filtered-out case is written as
   * skipped, which reads as failing. The junit report is read before the outfile goes.
   */
  private async runTests(entry: TestRun): Promise<TestRun> {
    const outfile = join(tmpdir(), `guren-plan-verify-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`)
    try {
      const result = await this.exec([bunExecutable(), 'test', ...entry.files, '--reporter=junit', `--reporter-outfile=${outfile}`])
      const junit = await readFile(outfile, 'utf8').catch(() => undefined)
      return { ...entry, result, ...(result.timedOut ? {} : { report: acceptanceStatus(junit, this.declaredIds) }) }
    } finally {
      await rm(outfile, { force: true })
    }
  }

  /**
   * `tests` passes when every behaviour passes and the run exits 0, since a file that
   * fails to load and a throwing `beforeAll` show only there; `tests:fail` when every
   * behaviour has a case and each case failed. An id the plan does not declare fails the
   * command: the test, not the environment, is wrong.
   */
  private async tests(command: 'tests' | 'tests:fail', step: PlanDerivedStep): Promise<CommandOutcome> {
    const ids = step.acceptanceIds
    if (ids.length === 0) return { label: 'bun test', status: 'pass', reason: 'the step has no acceptance behaviours', findings: [] }
    const selected = await this.testRun(step)
    if (selected.files.length === 0) {
      return { label: 'bun test', status: 'fail', reason: `no test file carries ${ids.map((id) => `[${id}]`).join(', ')} as a literal token`, findings: [] }
    }

    const { label, result, report } = await this.testRun(step, true)
    if (!result || result.timedOut) return { label, status: 'blocked', reason: `\`${label}\` timed out after ${this.options.timeoutMs} ms`, findings: [] }
    const tail = capFindings(nonEmptyLines(`${result.stdout}\n${result.stderr}`).slice(-OUTPUT_TAIL_LINES))
    if (!report || report.state === 'blocked') return { label, status: 'blocked', reason: report?.reason ?? 'no junit report was read', findings: tail }
    if (report.state === 'invalid') {
      return { label, status: 'fail', reason: 'the test report names behaviours the plan does not, or one behaviour in several files', findings: capFindings(report.errors.map(describeAcceptanceError)) }
    }

    const findings = command === 'tests' ? notPassing(ids, report.behaviours) : notFailing(ids, report.behaviours)
    if (findings.length > 0) {
      return { label, status: 'fail', reason: command === 'tests' ? 'a behaviour is not passing' : 'a behaviour is not failing', findings: capFindings(findings) }
    }
    if (command === 'tests' && result.exitCode !== 0) {
      return { label, status: 'fail', reason: `\`${label}\` exited ${result.exitCode} with every behaviour passing: a test file failed to load, or a test outside the plan failed`, findings: tail }
    }
    return { label, status: 'pass', findings: [] }
  }
}
