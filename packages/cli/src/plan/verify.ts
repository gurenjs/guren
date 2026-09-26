/**
 * The executing half of `guren plan:verify` (RFC 0030 §6): runs a step's verify commands
 * and its tests, and records the result at a fingerprint of the files that hold the
 * step's elements. `bun test` boots the application and `db:migrate` opens the configured
 * database, so this runs where those can. What cannot run here (no script, no tool, no
 * drizzle-kit to ask, no database reachable, a timeout) is `blocked`, never a failed
 * implementation. Subprocesses go through `exec`, the seam tests fake.
 */

import { readFile, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCheck } from '../check'
import { formatAdvisoryFinding, formatFinding, gatingResults, type CheckReport } from '../check-result'
import { capFindings, codegenFallback, OUTPUT_ERROR_PATTERN, outputFindings, outputTail, resolveScriptCommand } from '../command-output'
import { discoverTestFiles } from '../discovery'
import { readBracketedTokenFiles } from '../docs-acceptance'
import { resolveAppDrizzleKit, type AppDrizzleKit } from '../make-migration'
import { advisoryCheckResults } from '../manifest-section'
import { bunExecutable, type CapturedExec, type CapturedRun } from '../subprocess'
import {
  acceptanceStatus,
  planAcceptanceIds,
  SKELETON_BOOT_FAILED,
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
  /**
   * The plan's status, asked for once, after `codegen` has run: judged earlier it reads a
   * tree with no generated files, which blocks what imports them.
   */
  status: () => Promise<PlanStatus>
  exec: CapturedExec
  /** Per command. A child killed for it is `blocked`. */
  timeoutMs: number
  /** The app's `package.json` scripts. */
  scripts: Record<string, string>
  /** Element ids a waiver covers (RFC 0030 §6): left out of every step's judgement, and recorded. */
  waived?: ReadonlySet<string>
  /**
   * Defaults to an introspecting `runCheck()` against `root`: every verify list opens with a
   * `codegen` that must pass first, so the entry imports by the time the check runs.
   */
  check?: () => Promise<CheckReport>
  /** Test files, absolute. Defaults to `discoverTestFiles(root)`. */
  testFiles?: () => Promise<string[]>
  /** The drizzle-kit `db:migrate` asks whether a migration covers the schema. Defaults to the one `root` installs. */
  drizzleKit?: () => Promise<AppDrizzleKit>
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

/** What `drizzle-kit generate --explain --output json` prints (measured against 1.0.0-rc.4). */
interface ExplainedMigration {
  status: string
  statements?: Array<Record<string, unknown>>
  unresolved?: Array<{ type?: string; kind?: string; entity?: string[] }>
  /** `{ code, ...meta }`; only an `internal_error` carries a `message`. */
  error?: { code?: string; message?: string }
  /** Set by a plain `generate`, which wrote this migration: drizzle-kit ignored `--explain`. */
  migration_path?: string
}

/** The last stdout line that parses as an object with a `status`: drizzle-kit may print progress before it. */
function explainedMigration(stdout: string): ExplainedMigration | undefined {
  for (const line of stdout.split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as ExplainedMigration).status === 'string') return parsed as ExplainedMigration
    } catch {
      // Not the JSON line.
    }
  }
  return undefined
}

/** `create_table comments`, `add_column comments.edited_at`: the statement's type and what it names. */
function describeStatement(statement: Record<string, unknown>): string {
  const named = (value: unknown): { name?: unknown; table?: unknown } | undefined => (value !== null && typeof value === 'object' ? (value as { name?: unknown; table?: unknown }) : undefined)
  const column = named(statement.column)
  const table = named(statement.table)?.name ?? statement.table ?? column?.table ?? named(statement.index)?.table
  const target = [table, column?.name].filter((part) => typeof part === 'string').join('.')
  return `${String(statement.type)}${target ? ` ${target}` : ''}`
}

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
  const byId = await readBracketedTokenFiles(root, files, (token) => wanted.has(token))
  return [...new Set([...byId.values()].flat())].sort()
}

/** A failed command leaves the implementation something to fix whatever else was blocked, so it names the outcome. */
function stepOutcome(commands: readonly PlanCommandRecord[], incomplete: readonly string[]): PlanStepRecord['outcome'] {
  if (commands.some((command) => command.status === 'fail')) return 'failed'
  if (commands.some((command) => command.status === 'blocked')) return 'blocked'
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

function memoized<T>(store: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  let pending = store.get(key)
  if (!pending) {
    pending = create()
    store.set(key, pending)
  }
  return pending
}

interface TestSelection {
  /** App-relative, sorted: what `bun test` is given. */
  files: string[]
  label: string
}

interface TestOutcome extends TestSelection {
  result: CapturedRun
  /** Absent when the run timed out. */
  report?: AcceptanceReport
}

/**
 * Runs steps of one plan against one application. A command runs once per verifier and
 * its result is reused, since a verifier lives for one invocation and every step's list
 * opens with `codegen`, so nothing is judged before the generated files exist. One
 * `bun test` runs per acceptance-id set; `tests` and `tests:fail` judge the same run.
 */
export class PlanVerifier {
  private readonly commands = new Map<string, Promise<PlanCommandRecord>>()
  private readonly selections = new Map<string, Promise<TestSelection>>()
  private readonly outcomes = new Map<string, Promise<TestOutcome>>()
  private readonly declaredIds: string[]
  private readonly check: () => Promise<CheckReport>
  private readonly testFiles: () => Promise<string[]>
  private readonly drizzleKit: () => Promise<AppDrizzleKit>
  private readonly now: () => Date
  private judged: Promise<{ status: PlanStatus; elements: Map<string, PlanElementStatus> }> | undefined
  private testFilesPromise: Promise<string[]> | undefined

  constructor(
    plan: PlanDraft | Plan,
    private readonly derivation: PlanTaskDerivation,
    private readonly options: PlanVerifierOptions,
  ) {
    this.declaredIds = planAcceptanceIds(plan)
    this.check = options.check ?? (() => runCheck({ cwd: options.root, json: true, introspect: true }))
    this.testFiles = options.testFiles ?? (() => discoverTestFiles(options.root))
    this.drizzleKit = options.drizzleKit ?? (() => resolveAppDrizzleKit(options.root))
    this.now = options.now ?? (() => new Date())
  }

  /** The status the steps were judged against, or one judged now, after a `codegen` of its own when no step ran one. */
  status(): Promise<PlanStatus> {
    return this.load().then((judged) => judged.status)
  }

  private load(): Promise<{ status: PlanStatus; elements: Map<string, PlanElementStatus> }> {
    this.judged ??= memoized(this.commands, 'codegen', () => this.runCommand('codegen'))
      .then(() => this.options.status())
      .then((status) => ({ status, elements: new Map(status.elements.map((element) => [element.id, element])) }))
    return this.judged
  }

  async verify(stepId: string): Promise<PlanStepVerification> {
    const found = findPlanStep(this.derivation, stepId)
    if (!found) throw new Error(`no step ${stepId} is derived from this plan`)
    const started = performance.now()
    const ranAt = this.now().toISOString()
    const run = await this.runStep(found.step)
    return {
      stepId,
      taskId: found.task.id,
      record: { planDigest: this.options.planDigest, ranAt, durationMs: Math.round(performance.now() - started), ...run },
    }
  }

  /**
   * A `tests:fail` step whose verified record drifted, judged without a run: `tests:fail` cannot
   * pass once the implementation exists, and its red run was observed when it verified. It stays
   * verified while one test file still carries each behaviour's id as a bracketed token, which a
   * comment carries as well as a test title: a gap the run itself would catch, accepted here.
   */
  async recheckTests(stepId: string, previous: PlanStepRecord): Promise<PlanStepVerification> {
    const found = findPlanStep(this.derivation, stepId)
    if (!found) throw new Error(`no step ${stepId} is derived from this plan`)
    const started = performance.now()
    const ranAt = this.now().toISOString()
    const { files } = await this.selection(found.step)
    const wanted = new Set(found.step.acceptanceIds)
    const carriers = await readBracketedTokenFiles(this.options.root, files.map((file) => join(this.options.root, file)), (token) => wanted.has(token))
    const missing = found.step.acceptanceIds.filter((id) => !carriers.has(id))
    const findings = [
      ...missing.map((id) => `[${id}] is carried by no test file`),
      ...[...carriers].filter(([, carrying]) => carrying.length > 1).map(([id, carrying]) => `[${id}] is carried by ${carrying.join(' and ')}`),
    ]
    const command: PlanCommandRecord = {
      command: 'tests:fail',
      label: 'not run: a re-check that one test file still carries each behaviour',
      status: findings.length > 0 ? 'fail' : 'pass',
      durationMs: 0,
      ...(findings.length > 0 ? { reason: 'the test files no longer carry the behaviours the step saw fail' } : {}),
      findings,
    }
    return {
      stepId,
      taskId: found.task.id,
      record: {
        outcome: findings.length > 0 ? 'failed' : 'verified',
        planDigest: this.options.planDigest,
        ranAt,
        durationMs: Math.round(performance.now() - started),
        commands: [command],
        acceptance: previous.acceptance.map((behaviour) => (missing.includes(behaviour.id) ? { ...behaviour, status: 'pending' as const } : behaviour)),
        incomplete: [],
        waived: [],
        fingerprint: { files: Object.fromEntries(await hashFiles(this.options.root, files)), environment: currentEnvironment() },
      },
    }
  }

  private async runStep(step: PlanDerivedStep): Promise<Omit<PlanStepRecord, 'planDigest' | 'ranAt' | 'durationMs'>> {
    const commands = await this.runCommands(step)
    const { elements } = await this.load()

    // An owned id the status did not judge can never verify: listing it keeps a new section from reading as green.
    // A waiver outranks both, since a person's decision does not wait on what a reader found.
    const incomplete: string[] = []
    const waived: string[] = []
    const owned: PlanElementStatus[] = []
    for (const id of step.elementIds) {
      const element = elements.get(id)
      if (this.options.waived?.has(id)) waived.push(id)
      else if (!element) incomplete.push(`${id}: not judged by plan:status`)
      else if (!awaitsVerification(element)) incomplete.push(`${id}: ${element.state}`)
      else owned.push(element)
    }

    const selection = await this.selection(step)
    const files = [...new Set([...owned.flatMap((element) => element.files), ...selection.files])].sort()
    const fingerprint: PlanFingerprint = {
      files: Object.fromEntries(await hashFiles(this.options.root, files)),
      environment: currentEnvironment(),
    }

    // Peeked, never asked for: asking would spawn `bun test` for a step whose tests command was blocked.
    const report = (await this.outcomes.get(this.testKey(step))?.catch(() => undefined))?.report
    const behaviours = report?.state === 'judged' ? report.behaviours : []
    const acceptance = step.acceptanceIds.map((id) => ({ id, status: behaviours.find((behaviour) => behaviour.id === id)?.status ?? ('pending' as const) }))
    const outcome = stepOutcome(commands, incomplete)
    // A status judged behind a failed command would blame the code for what that command left unwritten.
    return { outcome, commands, acceptance, incomplete: outcome === 'failed' || outcome === 'blocked' ? [] : incomplete, waived, fingerprint }
  }

  /**
   * Sequential on purpose: codegen writes what typecheck, check and the tests read. Once
   * codegen has not passed, the rest is not run: its findings would blame the code for
   * the generated files it lacks.
   */
  private async runCommands(step: PlanDerivedStep): Promise<PlanCommandRecord[]> {
    const commands: PlanCommandRecord[] = []
    let stoppedBy: string | undefined
    for (const command of step.verify) {
      if (stoppedBy !== undefined) {
        commands.push({ command, label: 'not run', status: 'blocked', reason: `\`${stoppedBy}\` did not pass, so this did not run`, durationMs: 0, findings: [] })
        continue
      }
      const record = await this.command(command, step)
      commands.push(record)
      if (command === 'codegen' && record.status !== 'pass') stoppedBy = record.label
    }
    return commands
  }

  private command(command: PlanVerifyCommand, step: PlanDerivedStep): Promise<PlanCommandRecord> {
    const key = command === 'tests' || command === 'tests:fail' ? `${command}:${this.testKey(step)}` : command
    return memoized(this.commands, key, () => this.runCommand(command, step))
  }

  private async runCommand(command: PlanVerifyCommand, step?: PlanDerivedStep): Promise<PlanCommandRecord> {
    const started = performance.now()
    let outcome: CommandOutcome
    try {
      outcome = await this.dispatch(command, step)
    } catch (error) {
      outcome = { label: command, status: 'blocked', reason: `could not run: ${reasonOf(error)}`, findings: [] }
    }
    return { command, durationMs: Math.round(performance.now() - started), ...outcome }
  }

  private dispatch(command: PlanVerifyCommand, step?: PlanDerivedStep): Promise<CommandOutcome> {
    switch (command) {
      case 'codegen':
        return this.script('codegen', codegenFallback(), OUTPUT_ERROR_PATTERN)
      case 'typecheck':
        return this.script('typecheck', null, TYPECHECK_PATTERN)
      case 'db:migrate':
        return this.migrate()
      case 'check':
        return this.runCheck()
      case 'tests':
      case 'tests:fail':
        if (!step) throw new Error(`${command} runs for a step`)
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
    if (result.timedOut) return this.timedOut(label)
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

  /**
   * The app's `db:migrate`, once drizzle-kit says the migrations cover the schema: with nothing
   * generated the migrate applies nothing and passes, so a table the step adds would verify with
   * no migration behind it. Uncovered changes fail the command; drizzle-kit that cannot answer
   * blocks it.
   */
  private async migrate(): Promise<CommandOutcome> {
    if (resolveScriptCommand(this.options.scripts, 'db:migrate', null)) {
      const refused = await this.migrationCoverage()
      if (refused) return refused
    }
    return this.script('db:migrate', null, OUTPUT_ERROR_PATTERN, DATABASE_SIGNATURES)
  }

  private timedOut(label: string): CommandOutcome {
    return { label, status: 'blocked', reason: `\`${label}\` timed out after ${this.options.timeoutMs} ms`, findings: [] }
  }

  private async migrationCoverage(): Promise<CommandOutcome | undefined> {
    const label = 'drizzle-kit generate --explain'
    const kit = await this.drizzleKit()
    if ('missing' in kit) return { label, status: 'blocked', reason: `cannot tell whether a migration covers the schema: ${kit.missing}`, findings: [] }
    const result = await this.exec([bunExecutable(), kit.bin, 'generate', '--config', kit.config, '--explain', '--output', 'json'])
    if (result.timedOut) return this.timedOut(label)
    const explained = explainedMigration(result.stdout)
    // An `ok` with no statement list says nothing either way, so it falls through to blocked.
    const statements = explained?.status === 'ok' && Array.isArray(explained.statements) ? explained.statements : undefined
    if (explained?.status === 'no_changes' || statements?.length === 0) return undefined
    const fix = 'generate one with `guren make:migration`'
    if (statements) return { label, status: 'fail', reason: `the schema has changes no migration covers: ${fix}`, findings: capFindings(statements.map(describeStatement)) }
    if (explained?.status === 'missing_hints') {
      const findings = (explained.unresolved ?? []).map((entry) => `${entry.type ?? 'unresolved'}: ${entry.kind ?? ''} ${(entry.entity ?? []).join('.')}`.trim())
      return { label, status: 'fail', reason: `the schema has changes no migration covers, and drizzle-kit asks whether each is a rename: ${fix}`, findings: capFindings(findings) }
    }
    const said = [explained?.error?.code, explained?.error?.message, explained?.migration_path && `it wrote ${explained.migration_path}`].filter(Boolean).map((part) => `: ${part}`).join('')
    return { label, status: 'blocked', reason: `\`${label}\` exited ${result.exitCode} without saying whether a migration covers the schema${said}`, findings: outputTail(`${result.stdout}\n${result.stderr}`) }
  }

  private async runCheck(): Promise<CommandOutcome> {
    const label = 'guren check'
    let report: CheckReport
    try {
      report = await this.check()
    } catch (error) {
      return { label, status: 'blocked', reason: `could not run: ${reasonOf(error)}`, findings: [] }
    }
    const failing = gatingResults(report)
    // After the cap, as in the gate: forty gating findings must not hide why the app went unread.
    const advisory = advisoryCheckResults(report).map(formatAdvisoryFinding)
    return { label, status: failing.length > 0 ? 'fail' : 'pass', findings: [...capFindings(failing.map(formatFinding)), ...advisory] }
  }

  private testKey(step: PlanDerivedStep): string {
    return [...step.acceptanceIds].sort().join('\0')
  }

  private selection(step: PlanDerivedStep): Promise<TestSelection> {
    return memoized(this.selections, this.testKey(step), () => this.selectTests(step))
  }

  private async selectTests(step: PlanDerivedStep): Promise<TestSelection> {
    this.testFilesPromise ??= this.testFiles().catch((): string[] => [])
    const files = await acceptanceTestFiles(this.options.root, await this.testFilesPromise, step.acceptanceIds)
    return { files, label: `bun test ${files.join(' ')}`.trimEnd() }
  }

  /** The one run over the step's files, memoized as a promise so two commands on one key share it. */
  private outcome(step: PlanDerivedStep): Promise<TestOutcome> {
    return memoized(this.outcomes, this.testKey(step), () => this.selection(step).then((selection) => this.runTests(selection)))
  }

  /**
   * `bun test` on the selected files, never `-t`: a filtered-out case is written as
   * skipped, which reads as failing. The junit report is read before the outfile goes.
   */
  private async runTests(selection: TestSelection): Promise<TestOutcome> {
    const outfile = join(tmpdir(), `guren-plan-verify-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`)
    try {
      const result = await this.exec([bunExecutable(), 'test', ...selection.files, '--reporter=junit', `--reporter-outfile=${outfile}`])
      const junit = await readFile(outfile, 'utf8').catch(() => undefined)
      return { ...selection, result, ...(result.timedOut ? {} : { report: acceptanceStatus(junit, this.declaredIds) }) }
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
    const { files } = await this.selection(step)
    if (files.length === 0) {
      return { label: 'bun test', status: 'fail', reason: `no test file carries ${ids.map((id) => `[${id}]`).join(', ')} as a literal token`, findings: [] }
    }

    const { label, result, report } = await this.outcome(step)
    if (!report) return this.timedOut(label)
    const tail = outputTail(`${result.stdout}\n${result.stderr}`)
    if (report.state === 'blocked') return { label, status: 'blocked', reason: report.reason, findings: tail }
    if (report.state === 'invalid') {
      return { label, status: 'fail', reason: 'the test report names behaviours the plan does not, or one behaviour in several files', findings: capFindings(report.errors.map(describeAcceptanceError)) }
    }

    // The junit report carries no failure message, so the boot failure is read from Bun's own `error:` line.
    if (command === 'tests:fail' && `${result.stdout}\n${result.stderr}`.split('\n').some((line) => line.startsWith(`error: ${SKELETON_BOOT_FAILED}`))) {
      return { label, status: 'blocked', reason: 'the application did not boot, so a case failed without reaching its route', findings: tail }
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
