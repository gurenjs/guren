/**
 * `guren plan:verify` (RFC 0030 §6): runs a step's verify commands and its tests, and
 * records the result at a fingerprint of the files that hold the step's elements. Where
 * `plan:status` observes, this executes: `bun test` boots the application and
 * `db:migrate` opens the configured database, so it runs where those can. What cannot run
 * here (no script, no `bun`, no database reachable, a timeout) is `blocked`, never a
 * failed implementation. Subprocesses go through `exec`, the seam tests fake.
 */

import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runCheck } from '../check'
import { formatFinding, gatingResults, type CheckReport } from '../check-result'
import { cliEntry } from '../cli-entry'
import { discoverTestFiles, toPosixRelative } from '../discovery'
import { bunExecutable, type CapturedExec, type CapturedRun } from '../subprocess'
import {
  acceptanceStatus,
  bracketedTokens,
  planAcceptanceIds,
  type AcceptanceError,
  type AcceptanceReport,
  type AcceptanceStatus,
} from './acceptance-status'
import type { Plan, PlanDraft } from './schema'
import type { PlanFingerprint, PlanStepRecord } from './state'
import { awaitsVerification, summarize, type PlanElementState, type PlanElementStatus, type PlanStatus } from './status'
import type { PlanDerivedStep, PlanDerivedTask, PlanTaskDerivation, PlanVerifyCommand } from './tasks'

export type PlanVerifyCommandStatus = PlanStepRecord['commands'][number]['status']
export type PlanVerifyCommandResult = PlanStepRecord['commands'][number]
export type PlanStepOutcome = PlanStepRecord['outcome']

export interface PlanStepVerification extends PlanStepRecord {
  stepId: string
  taskId: string
}

export interface PlanVerifierOptions {
  root: string
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

/** Findings a command may report before the rest collapses into one "and N more" line. */
const MAX_FINDINGS = 40
const OUTPUT_TAIL_LINES = 20

/**
 * Output that says the database, not the migration, is what failed. A migration that
 * fails for any other reason is a failed implementation, so the list stays short and
 * literal: a broader one would turn real failures into environment problems.
 */
const INFRASTRUCTURE_SIGNATURES = [
  /\bECONNREFUSED\b/u,
  /\bENOTFOUND\b/u,
  /\bEAI_AGAIN\b/u,
  /\bECONNRESET\b/u,
  /connection refused/iu,
  /could not connect/iu,
  /password authentication failed/iu,
  /\bSQLITE_CANTOPEN\b/u,
  /command not found/iu,
  /drizzle-kit[^\n]*not (?:found|installed)/iu,
]

const TYPECHECK_PATTERN = /error TS\d+/u
const CODEGEN_PATTERN = /error|Error|failed/u

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

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** App-relative path → hash, or `undefined` for a file that cannot be read. */
export async function hashFiles(root: string, files: Iterable<string>): Promise<Map<string, string | undefined>> {
  const hashes = new Map<string, string | undefined>()
  for (const file of new Set(files)) {
    try {
      hashes.set(file, sha256(await readFile(resolve(root, file))))
    } catch {
      hashes.set(file, undefined)
    }
  }
  return hashes
}

export function currentEnvironment(): PlanFingerprint['environment'] {
  return {
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
    platform: process.platform,
    arch: process.arch,
    hostname: hostname(),
  }
}

/** The test files, app-relative, whose source carries any of `ids` as a bracketed token. */
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

type StepRun = Omit<PlanStepVerification, 'stepId' | 'taskId' | 'planDigest' | 'ranAt' | 'durationMs'>

/**
 * Runs steps of one plan against one application. A command is run once per verifier
 * and its result reused: `typecheck` answers the same question for every step, and a
 * verifier lives for one invocation.
 */
export class PlanVerifier {
  private readonly cache = new Map<string, Promise<PlanVerifyCommandResult>>()
  private readonly elements: Map<string, PlanElementStatus>
  private readonly declaredIds: string[]
  private testFilesPromise: Promise<string[]> | undefined
  /** One `bun test` per file set: `tests` and `tests:fail` judge the same run differently. */
  private readonly testRuns = new Map<string, Promise<{ result: CapturedRun; junit: string | undefined }>>()

  constructor(
    private readonly plan: PlanDraft | Plan,
    status: PlanStatus,
    private readonly derivation: PlanTaskDerivation,
    private readonly options: PlanVerifierOptions,
  ) {
    this.elements = new Map(status.elements.map((element) => [element.id, element]))
    this.declaredIds = planAcceptanceIds(plan)
  }

  /** Every step, in task order: what runs when no `--step` narrows the command. */
  stepIds(): string[] {
    return this.derivation.tasks.flatMap((task) => task.steps.map((step) => step.id))
  }

  findStep(stepId: string): { task: PlanDerivedTask; step: PlanDerivedStep } | undefined {
    for (const task of this.derivation.tasks) {
      const step = task.steps.find((candidate) => candidate.id === stepId)
      if (step) return { task, step }
    }
    return undefined
  }

  async verify(stepId: string, planDigest: string): Promise<PlanStepVerification> {
    const found = this.findStep(stepId)
    if (!found) throw new Error(`no step ${stepId} is derived from this plan`)
    const started = performance.now()
    const ranAt = (this.options.now ?? (() => new Date()))().toISOString()
    const run = await this.runStep(found.step)
    return {
      stepId,
      taskId: found.task.id,
      planDigest,
      ranAt,
      durationMs: Math.round(performance.now() - started),
      ...run,
    }
  }

  private async runStep(step: PlanDerivedStep): Promise<StepRun> {
    const commands: PlanVerifyCommandResult[] = []
    // Sequential on purpose: codegen writes what typecheck, check and the tests read.
    for (const command of step.verify) commands.push(await this.command(command, step))

    const owned = step.elementIds.map((id) => this.elements.get(id)).filter((element): element is PlanElementStatus => element !== undefined)
    const incomplete = owned.filter((element) => !awaitsVerification(element)).map((element) => `${element.id}: ${element.state}`)

    const testFiles = await this.stepTestFiles(step)
    const files = [...new Set([...owned.flatMap((element) => element.files), ...testFiles])].sort()
    const hashes = await hashFiles(this.options.root, files)
    const fingerprint: PlanFingerprint = {
      files: Object.fromEntries([...hashes].filter((entry): entry is [string, string] => entry[1] !== undefined)),
      environment: currentEnvironment(),
    }

    const acceptance = this.acceptance(step)
    const outcome: PlanStepOutcome = commands.some((command) => command.status === 'blocked')
      ? 'blocked'
      : commands.some((command) => command.status === 'fail')
        ? 'failed'
        : incomplete.length > 0
          ? 'incomplete'
          : 'verified'
    return { outcome, commands, acceptance, incomplete, fingerprint }
  }

  /** The behaviours the step must see, at the status the test run gave them; `pending` when none ran. */
  private acceptance(step: PlanDerivedStep): PlanStepRecord['acceptance'] {
    const report = this.testReports.get(this.testKey(step))
    const behaviours = report?.state === 'judged' ? report.behaviours : report?.state === 'invalid' ? report.observed : []
    return step.acceptanceIds.map((id) => ({ id, status: behaviours.find((behaviour) => behaviour.id === id)?.status ?? 'pending' }))
  }

  private readonly testReports = new Map<string, AcceptanceReport | undefined>()

  private testKey(step: PlanDerivedStep): string {
    return [...step.acceptanceIds].sort().join('\0')
  }

  private stepTestFiles(step: PlanDerivedStep): Promise<string[]> {
    this.testFilesPromise ??= (this.options.testFiles ?? (() => discoverTestFiles(this.options.root)))()
    return this.testFilesPromise.then((files) => acceptanceTestFiles(this.options.root, files, step.acceptanceIds))
  }

  private command(command: PlanVerifyCommand, step: PlanDerivedStep): Promise<PlanVerifyCommandResult> {
    const key = command === 'tests' || command === 'tests:fail' ? `${command}:${this.testKey(step)}` : command
    let pending = this.cache.get(key)
    if (!pending) {
      pending = this.runCommand(command, step)
      this.cache.set(key, pending)
    }
    return pending
  }

  private async runCommand(command: PlanVerifyCommand, step: PlanDerivedStep): Promise<PlanVerifyCommandResult> {
    const started = performance.now()
    let outcome: Omit<PlanVerifyCommandResult, 'command' | 'durationMs'>
    try {
      outcome = await this.dispatch(command, step)
    } catch (error) {
      outcome = { label: command, status: 'blocked', reason: `could not run: ${reasonOf(error)}`, findings: [] }
    }
    return { command, durationMs: Math.round(performance.now() - started), ...outcome }
  }

  private dispatch(command: PlanVerifyCommand, step: PlanDerivedStep): Promise<Omit<PlanVerifyCommandResult, 'command' | 'durationMs'>> {
    switch (command) {
      case 'codegen':
        return this.script('codegen', ['guren codegen', [bunExecutable(), cliEntry(), 'codegen']], CODEGEN_PATTERN)
      case 'typecheck':
        return this.script('typecheck', null, TYPECHECK_PATTERN)
      case 'db:migrate':
        return this.script('db:migrate', null, /error|Error|failed/u, INFRASTRUCTURE_SIGNATURES)
      case 'check':
        return this.check()
      case 'tests':
      case 'tests:fail':
        return this.tests(command, step)
    }
  }

  private runTests(files: readonly string[]): Promise<{ result: CapturedRun; junit: string | undefined }> {
    const key = files.join('\0')
    let pending = this.testRuns.get(key)
    if (!pending) {
      pending = (async () => {
        const outfile = join(tmpdir(), `guren-plan-verify-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`)
        try {
          const result = await this.exec([bunExecutable(), 'test', ...files, '--reporter=junit', `--reporter-outfile=${outfile}`])
          return { result, junit: await readFile(outfile, 'utf8').catch(() => undefined) }
        } finally {
          await rm(outfile, { force: true })
        }
      })()
      this.testRuns.set(key, pending)
    }
    return pending
  }

  private async exec(command: string[]): Promise<CapturedRun> {
    return this.options.exec(command, this.options.root, { timeoutMs: this.options.timeoutMs })
  }

  /**
   * A command backed by the app's own script, else `fallback`, else `blocked`: a missing
   * script is the environment's to fix. Failure findings are the output lines matching
   * `pattern`, or its tail when none do.
   */
  private async script(
    script: string,
    fallback: [label: string, command: string[]] | null,
    pattern: RegExp,
    blockedWhen: readonly RegExp[] = [],
  ): Promise<Omit<PlanVerifyCommandResult, 'command' | 'durationMs'>> {
    let label: string
    let command: string[]
    if (this.options.scripts[script]) {
      label = `bun run ${script}`
      command = [bunExecutable(), 'run', script]
    } else if (fallback) {
      ;[label, command] = fallback
    } else {
      return { label: `bun run ${script}`, status: 'blocked', reason: `no "${script}" script in package.json`, findings: [] }
    }
    const result = await this.exec(command)
    if (result.timedOut) return { label, status: 'blocked', reason: `\`${label}\` timed out after ${this.options.timeoutMs} ms`, findings: [] }
    if (result.exitCode === 0) return { label, status: 'pass', findings: [] }
    const output = `${result.stdout}\n${result.stderr}`
    const lines = nonEmptyLines(output)
    const matched = lines.filter((line) => pattern.test(line))
    const findings = capFindings(matched.length > 0 ? matched : lines.slice(-OUTPUT_TAIL_LINES))
    if (blockedWhen.some((signature) => signature.test(output))) {
      return { label, status: 'blocked', reason: `\`${label}\` exited ${result.exitCode} on what reads as an unreachable database or a missing tool`, findings }
    }
    return { label, status: 'fail', reason: `\`${label}\` exited ${result.exitCode}`, findings }
  }

  private async check(): Promise<Omit<PlanVerifyCommandResult, 'command' | 'durationMs'>> {
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

  /**
   * `bun test` on the files carrying the step's behaviours, selected by file and never by
   * `-t` (a filtered-out case is written as skipped, which reads as failing). `tests`
   * passes when every behaviour passes and the run exits 0, since a file that fails to
   * load and a throwing `beforeAll` show only there; `tests:fail` when every behaviour
   * has a case and each case failed, which a skipped case does not do.
   */
  private async tests(command: 'tests' | 'tests:fail', step: PlanDerivedStep): Promise<Omit<PlanVerifyCommandResult, 'command' | 'durationMs'>> {
    const ids = step.acceptanceIds
    const files = await this.stepTestFiles(step)
    const label = `bun test ${files.join(' ')}`.trimEnd()
    if (ids.length === 0) return { label: 'bun test', status: 'pass', reason: 'the step has no acceptance behaviours', findings: [] }
    if (files.length === 0) {
      this.testReports.set(this.testKey(step), undefined)
      return { label: 'bun test', status: 'fail', reason: `no test file carries ${ids.map((id) => `[${id}]`).join(', ')}`, findings: [] }
    }

    const { result, junit } = await this.runTests(files)
    if (result.timedOut) return { label, status: 'blocked', reason: `\`${label}\` timed out after ${this.options.timeoutMs} ms`, findings: [] }

    const report = acceptanceStatus(junit, this.declaredIds)
    this.testReports.set(this.testKey(step), report)
    const tail = capFindings(nonEmptyLines(`${result.stdout}\n${result.stderr}`).slice(-OUTPUT_TAIL_LINES))
    if (report.state === 'blocked') return { label, status: 'blocked', reason: report.reason, findings: tail }
    if (report.state === 'invalid') {
      return { label, status: 'fail', reason: 'the test report names behaviours the plan does not, or one behaviour in several files', findings: capFindings(report.errors.map(describeAcceptanceError)) }
    }

    const findings: string[] = []
    for (const id of ids) {
      const behaviour = report.behaviours.find((candidate) => candidate.id === id)
      const status: AcceptanceStatus = behaviour?.status ?? 'pending'
      if (command === 'tests') {
        if (status !== 'passing') findings.push(`[${id}] is ${status}${describeCases(behaviour?.cases ?? [])}`)
      } else if (status === 'pending') {
        findings.push(`[${id}] has no test`)
      } else if (!behaviour!.cases.every((entry) => entry.outcome === 'failed')) {
        findings.push(`[${id}] must fail before its implementation exists${describeCases(behaviour!.cases)}`)
      }
    }
    if (command === 'tests' && result.exitCode !== 0 && findings.length === 0) {
      findings.push(...tail)
      return { label, status: 'fail', reason: `\`${label}\` exited ${result.exitCode} with every behaviour passing: a test file failed to load, or a test outside the plan failed`, findings }
    }
    return findings.length > 0 ? { label, status: 'fail', reason: command === 'tests' ? 'a behaviour is not passing' : 'a behaviour is not failing', findings: capFindings(findings) } : { label, status: 'pass', findings: [] }
  }
}

function describeCases(cases: ReadonlyArray<{ title: string; outcome: string }>): string {
  if (cases.length === 0) return ''
  return `: ${cases.map((entry) => `${entry.outcome} "${entry.title}"`).join('; ')}`
}

function describeAcceptanceError(error: AcceptanceError): string {
  if (error.kind === 'id-in-several-files') return `[${error.id}] is carried by ${error.files.join(' and ')}`
  return `[${error.id}] in ${error.file} ("${error.title}") is not a behaviour of the plan`
}

export interface PlanVerificationNotes {
  /** Step ids whose record ran against another revision of the plan, so it lifts nothing. */
  staleSteps: string[]
}

/**
 * Lays recorded verification over a `plan:status` result (RFC 0030 §6): an element its
 * step verified is `verified` while every fingerprinted file still hashes the same, and
 * `drifted` once one does not. Only an element at its completion state, or `unjudged`,
 * is lifted; a record from another revision of the plan is stale and lifts nothing.
 * `hashes` is what the fingerprinted files hash to now; one that cannot be read is a change.
 */
export function applyVerification(
  status: PlanStatus,
  derivation: PlanTaskDerivation,
  records: Readonly<Record<string, PlanStepRecord>>,
  digest: string,
  hashes: ReadonlyMap<string, string | undefined>,
): { status: PlanStatus<PlanElementState>; notes: PlanVerificationNotes } {
  const lifted = new Map<string, PlanElementStatus<PlanElementState>>(status.elements.map((element) => [element.id, { ...element, notes: [...element.notes] }]))
  const staleSteps: string[] = []

  for (const task of derivation.tasks) {
    for (const step of task.steps) {
      const record = records[step.id]
      if (!record || record.outcome !== 'verified') continue
      if (record.planDigest !== digest) {
        staleSteps.push(step.id)
        continue
      }
      const changed = Object.entries(record.fingerprint.files)
        .filter(([file, hash]) => hashes.get(file) !== hash)
        .map(([file]) => file)
      for (const id of step.elementIds) {
        const element = lifted.get(id)
        if (!element) continue
        if (!awaitsVerification(element)) {
          element.notes.push(`Verified ${record.ranAt} by ${step.id}, and no longer at the state that completes it.`)
          continue
        }
        if (changed.length === 0) {
          element.state = 'verified'
        } else {
          element.state = 'drifted'
          element.notes.push(`Verified ${record.ranAt} by ${step.id}; changed since: ${changed.join(', ')}.`)
        }
      }
    }
  }

  const elements = [...lifted.values()]
  return { status: { elements, summary: summarize(elements) }, notes: { staleSteps } }
}
