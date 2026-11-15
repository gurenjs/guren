/**
 * `guren change:evidence` (RFC 0040 §4): the gate, run as `guren gate --deps` runs it, with the
 * lane of the change beside it. The exit code is the gate's alone; everything else the evidence
 * could not establish is a hold, and the three files are written on every path.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runGit } from '../changed-files'
import type { GateReport } from '../gate'
import { writeFileAtomic } from '../plan/beside'
import { judgeChangeLane, rendersPages, type ChangeLaneReport, type Lane } from './lane'
import { policyNote, REVIEW_POLICY_FILE } from './review-policy'
import { openChange, resolveChange } from './resolve'
import { changeAdvisories } from './revision-advisories'
import { auditChangeRevisions } from './revision-audit'

export const EVIDENCE_DIR = '.guren/evidence'
export const RECORD_VERSION = 1

export interface ChangeHold {
  code: string
  lane: Lane
  message: string
}

export interface BrowserEvidence {
  configured: boolean
  /** `unavailable` when the runner did not finish or left no report the CLI can read. */
  report: 'read' | 'unavailable'
  cases: { passed: number; failed: number; skipped: number; fixme: number }
  /** Features the change touches (by the browser map) with no passing case. */
  uncovered: string[]
}

export interface ChangeEvidence {
  schemaVersion: 1
  /** Absent when the change could not be read; the `lane-unavailable` hold says why. */
  lane?: ChangeLaneReport
  gate: GateReport
  /** Plan evidence is not gathered by this version; the plans at the head are listed as the lane read them. */
  plans: { report: 'unavailable'; reason: string; atHead: ChangeLaneReport['plans'] }
  browser: BrowserEvidence
  migrationImpact: 'none' | 'additive' | 'destructive'
  /** Why this change cannot be low, however low its facts are. */
  holds: ChangeHold[]
  /** Low floor and no hold. */
  eligible: boolean
}

/** What outlives the run: the base record of later changes (RFC 0040 §4). Never finding text. */
export interface ChangeRecord {
  recordVersion: typeof RECORD_VERSION
  cli: string | null
  server: string | null
  /** The introspection target and `NODE_ENV` the run judged the application under. */
  target: 'default'
  environment: string | null
  base: string
  mergeBase: string | null
  head: string
  floor: Lane | null
  /** `policyFrom`: the lane before `guren.review.ts` set it, which the shadow comparison reads beside the label. */
  facts: Array<{ code: string; lane: Lane; policyFrom?: Lane; target?: string; files: string[] }>
  /** The readers that did not read, which is what a floor above its facts rests on. */
  unjudged: Array<{ reader: string; lane: Lane }>
  audit: ChangeLaneReport['audit'] | null
  /** Codes and lanes: a hold's message may carry an error's text, which this record outlives. */
  holds: Array<Omit<ChangeHold, 'message'>>
  eligible: boolean
  gate: { ok: boolean; deps: boolean; stages: Array<{ name: string; status: string }> }
  /** Per-route security records are not computed by this version: `unavailable`, never an empty list. */
  securityRecords: { unavailable: string }
}

export interface ChangeEvidenceOptions {
  cwd: string
  base: string
  head: string
  /** Scan dependencies in the gate's audit stage, as `guren gate --deps` does. */
  deps: boolean
  /** Audit both sides of the change (`change:lane`'s default). */
  audit: boolean
  /** The routes entry, as `guren gate --routes` takes it. */
  routesFile?: string
  /** Defaults to `runGate()`. */
  gate?: (cwd: string, options: { deps: boolean; routesFile?: string }) => Promise<GateReport>
  /** Defaults to `change:lane`'s own judgement. */
  lane?: (cwd: string, base: string, head: string, audit: boolean, deps: boolean) => Promise<ChangeLaneReport>
}

async function judgeLane(cwd: string, base: string, head: string, audit: boolean, deps: boolean): Promise<ChangeLaneReport> {
  const change = await resolveChange(cwd, base, head)
  const { reader, dispose } = openChange(cwd, change)
  try {
    return await judgeChangeLane(change, reader, {
      ...(audit ? { audit: () => auditChangeRevisions(cwd, change) } : {}),
      ...(deps ? { advisories: () => changeAdvisories(cwd, change) } : {}),
    })
  } finally {
    await dispose()
  }
}

async function runGateDefault(cwd: string, options: { deps: boolean; routesFile?: string }): Promise<GateReport> {
  const { runGate } = await import('../gate')
  return runGate({ cwd, ...options })
}

// `runGit()` trims each line, so a porcelain line's status may have lost its leading space.
const statusPath = (line: string): string => line.replace(/^[A-Z?!]{1,2}\s+/, '')

export function firstLine(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).split('\n')[0]!
  } catch {
    // A rejection with no string form (`Object.create(null)`) must not throw out of the catch that reads it.
    return 'a value with no message'
  }
}

/**
 * Masks the credentials a failing command most often prints: a URL's user information and a
 * `NAME=value` whose name reads as a secret. The files are uploaded as CI artifacts.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/gi, '$1[redacted]@')
    .replace(/\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY|APP_KEY)[A-Z0-9_]*)=([^\s"']+)/g, '$1=[redacted]')
}

/** Tracked paths that differ from the commit, over the whole worktree: an app's tsconfig may extend a file above it. */
async function trackedChanges(cwd: string): Promise<string[] | null> {
  const root = (await runGit(cwd, ['rev-parse', '--show-toplevel']))?.[0]
  // `submodule.<name>.ignore` would hide edits inside a submodule the gate compiles.
  return root === undefined ? null : runGit(root, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none'])
}

/**
 * The `@guren/server` the application resolves: its own `node_modules`, else the one its `@guren/core`
 * resolves (an isolated or a hoisted install leaves none beside the application).
 */
async function serverVersion(cwd: string): Promise<string | null> {
  // The core the application resolves may be hoisted to a directory above it, and link into an isolated store.
  const cores: string[] = []
  for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) {
    const core = await realpath(join(dir, 'node_modules/@guren/core')).catch(() => undefined)
    if (core !== undefined) {
      cores.push(core)
      break
    }
  }
  const starts = [cwd, ...cores]
  for (const start of starts) {
    for (let dir = start; dir !== dirname(dir); dir = dirname(dir)) {
      const path = join(dir, 'node_modules/@guren/server/package.json')
      if (!existsSync(path)) continue
      try {
        const version = (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version
        return typeof version === 'string' ? version : null
      } catch {
        return null
      }
    }
  }
  return null
}

/** This CLI's own version: the `package.json` above the running module, from `src/` or a `dist/` chunk alike. */
function ownVersion(): string | null {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir !== dirname(dir); dir = dirname(dir)) {
    const path = join(dir, 'package.json')
    if (!existsSync(path)) continue
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown }
      if (manifest.name === '@guren/cli') return typeof manifest.version === 'string' ? manifest.version : null
    } catch {
      return null
    }
  }
  return null
}

const BROWSER_CONFIGS = ['playwright.browser.config.ts', 'e2e.browser.config.ts']

async function changedPaths(cwd: string, lane: ChangeLaneReport): Promise<string[]> {
  const change = await resolveChange(cwd, lane.base, lane.head)
  return change.paths.filter((entry) => !entry.outsideApp).flatMap((entry) => (entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]))
}

export async function collectChangeEvidence(options: ChangeEvidenceOptions): Promise<ChangeEvidence> {
  const cwd = resolve(options.cwd)
  const holds: ChangeHold[] = []
  const hold = (code: string, message: string): void => {
    holds.push({ code, lane: 'medium', message })
  }

  // Before the gate: its codegen rewrites `.guren/`, which an application may commit.
  const checkout = (await runGit(cwd, ['rev-parse', 'HEAD']))?.[0]
  const dirty = await trackedChanges(cwd)
  const headSha = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${options.head}^{commit}`]))?.[0]
  if (checkout === undefined || headSha === undefined || checkout !== headSha) {
    hold('checkout-not-head', `the checkout is at ${checkout?.slice(0, 12) ?? 'no commit'}, not at --head ${options.head.slice(0, 12)}, so the gate judged other code than the change. On a pull request, check out the head SHA (actions/checkout's ref), not the merge commit`)
  }
  if (dirty === null) hold('checkout-unreadable', 'git status did not answer, so uncommitted changes could not be ruled out')
  else if (dirty.length > 0) hold('checkout-dirty', `the checkout has ${dirty.length} uncommitted ${dirty.length === 1 ? 'change' : 'changes'} to tracked files, which the gate judged and the change does not hold: ${dirty.slice(0, 5).map((line) => statusPath(line)).join(', ')}`)

  let gate: GateReport
  try {
    gate = await (options.gate ?? runGateDefault)(cwd, { deps: options.deps, ...(options.routesFile ? { routesFile: options.routesFile } : {}) })
  } catch (error) {
    // A gate that could not run is a failed gate: the command still fails, and still writes its files.
    gate = { cwd, ok: false, changed: false, stages: [] }
    hold('gate-failed', `the gate could not run: ${firstLine(error)}`)
  }
  if (!gate.ok && !holds.some((entry) => entry.code === 'gate-failed')) {
    hold('gate-failed', `the gate failed: ${gate.stages.filter((stage) => stage.status === 'fail').map((stage) => stage.name).join(', ') || 'no stage reported'}`)
  }
  // The gate's codegen regenerates committed files, and the stages after it judge what it wrote, not the commit.
  const checkoutAfter = (await runGit(cwd, ['rev-parse', 'HEAD']))?.[0]
  if (checkout !== undefined && checkoutAfter !== checkout) {
    hold('checkout-moved', `the checkout moved from ${checkout.slice(0, 12)} to ${checkoutAfter?.slice(0, 12) ?? 'no commit'} while the gate ran, so the gate judged code the change may not hold`)
  }
  if (dirty !== null && dirty.length === 0) {
    const after = await trackedChanges(cwd)
    if (after === null) hold('checkout-unreadable', 'git status did not answer after the gate, so what the gate rewrote could not be ruled out')
    else if (after.length > 0) hold('gate-rewrote-tree', `the gate rewrote ${after.length} committed ${after.length === 1 ? 'file' : 'files'}, so it judged its own output rather than the commit: ${after.slice(0, 5).map((line) => statusPath(line)).join(', ')}. Commit what codegen writes`)
  }

  let lane: ChangeLaneReport | undefined
  try {
    lane = await (options.lane ?? judgeLane)(cwd, options.base, options.head, options.audit, options.deps)
  } catch (error) {
    hold('lane-unavailable', `the change could not be read: ${firstLine(error)}`)
  }
  if (lane !== undefined && (lane.mergeBase === lane.head || lane.facts.length === 0)) {
    const behind = lane.mergeBase === lane.head && lane.base !== lane.head
    hold('change-empty', behind ? 'the head is an ancestor of the base, so no commit of the change was read: were --base and --head swapped, or did the base branch move past the head?' : 'no path changed between the base and the head, so there is no change to judge')
  }

  const atHead = lane?.plans ?? []
  const openPlans = atHead.filter((plan) => plan.standing !== 'closed')
  if (lane === undefined || openPlans.length > 0) {
    const named = openPlans.map((plan) => `${plan.file} (${plan.standing})`).join(', ')
    hold('plan-evidence-unavailable', `plan evidence is not gathered by this version, so a change under a plan is held${named ? `: ${named}` : ''}`)
  }

  const browser: BrowserEvidence = {
    configured: BROWSER_CONFIGS.some((file) => existsSync(join(cwd, file))),
    report: 'unavailable',
    cases: { passed: 0, failed: 0, skipped: 0, fixme: 0 },
    uncovered: [],
  }
  // A catalog is what a page renders as its labels, which the browser specs locate controls by.
  const routesEntry = options.routesFile === undefined ? undefined : relative(cwd, resolve(cwd, options.routesFile)).split(sep).join('/')
  const rendered = (path: string): boolean => rendersPages(path) || /^(?:modules\/[^/]+\/)?lang\//.test(path) || path === routesEntry
  // Both sides of each path, since a page moved out of `resources/js/pages/` is a page the change removed.
  const touched = lane === undefined ? [] : await changedPaths(cwd, lane).catch(() => lane.facts.flatMap((fact) => fact.files))
  const pages = [...new Set(touched.filter(rendered))]
  if (lane === undefined || pages.length > 0) {
    hold('browser-evidence-unavailable', `browser evidence is not gathered by this version${pages.length > 0 ? `, and the change edits what a page renders: ${pages.slice(0, 5).join(', ')}${pages.length > 5 ? ', …' : ''}` : ''}`)
  }

  const codes = new Set(lane?.facts.map((fact) => fact.code) ?? [])
  const migrationImpact = codes.has('migration-destructive') ? 'destructive' : codes.has('migration') ? 'additive' : 'none'

  return {
    schemaVersion: 1,
    ...(lane ? { lane } : {}),
    gate,
    plans: { report: 'unavailable', reason: 'plan evidence arrives with the declaration matcher', atHead },
    browser,
    migrationImpact,
    holds,
    eligible: lane !== undefined && lane.floor === 'low' && holds.length === 0 && gate.ok,
  }
}

export async function changeRecord(cwd: string, base: string, head: string, evidence: ChangeEvidence, deps: boolean): Promise<ChangeRecord> {
  return {
    recordVersion: RECORD_VERSION,
    cli: ownVersion(),
    server: await serverVersion(resolve(cwd)),
    target: 'default',
    environment: process.env.NODE_ENV ?? null,
    base: evidence.lane?.base ?? base,
    mergeBase: evidence.lane?.mergeBase ?? null,
    head: evidence.lane?.head ?? head,
    floor: evidence.lane?.floor ?? null,
    facts: (evidence.lane?.facts ?? []).map(({ code, lane, policyFrom, target, files }) => ({ code, lane, ...(policyFrom ? { policyFrom } : {}), ...(target ? { target } : {}), files })),
    unjudged: (evidence.lane?.unjudged ?? []).map(({ reader, lane }) => ({ reader, lane })),
    audit: evidence.lane?.audit ?? null,
    holds: evidence.holds.map(({ code, lane }) => ({ code, lane })),
    eligible: evidence.eligible,
    gate: { ok: evidence.gate.ok, deps, stages: evidence.gate.stages.map(({ name, status }) => ({ name, status })) },
    securityRecords: { unavailable: 'per-route security records are not computed by this version' },
  }
}

const escapeCell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ')

/** The job summary: the conclusion first, then why. */
export function renderEvidenceMarkdown(evidence: ChangeEvidence): string {
  const lane = evidence.lane
  const lines = [
    `## Change evidence: ${lane ? `floor \`${lane.floor}\`` : 'the change could not be read'}${evidence.eligible ? ', eligible for low' : ''}`,
    '',
    `Gate: **${evidence.gate.ok ? 'passed' : 'failed'}**. Migration impact: ${evidence.migrationImpact}.`,
  ]
  if (lane) lines.push('', `Read from ${lane.mergeBase.slice(0, 12)}..${lane.head.slice(0, 12)}.`)
  if (lane?.policy.state === 'read') {
    const approvals = lane.policy.policy.approvals?.[lane.floor]
    lines.push('', `${REVIEW_POLICY_FILE} at the merge base applies${approvals === undefined ? '' : `: a ${lane.floor} change needs ${approvals} ${approvals === 1 ? 'approval' : 'approvals'} where someone other than the author can approve`}. Nothing enforces it yet.`)
  }
  if (evidence.holds.length > 0) {
    lines.push('', '### Holds', '', ...evidence.holds.map((hold) => `- \`${hold.code}\`: ${hold.message}`))
  }
  lines.push('', '### Gate', '', '| Stage | Status |', '| --- | --- |', ...evidence.gate.stages.map((stage) => `| ${stage.name} | ${stage.status} |`))
  if (lane) {
    for (const level of ['high', 'medium', 'low'] satisfies Lane[]) {
      const facts = lane.facts.filter((fact) => fact.lane === level)
      if (facts.length === 0) continue
      lines.push('', `### ${level}`, '', '| Fact | What | Files |', '| --- | --- | --- |')
      for (const fact of facts) lines.push(`| \`${fact.code}\` | ${escapeCell(`${fact.message}${policyNote(fact)}`)} | ${escapeCell(fact.files.slice(0, 3).join(', '))}${fact.files.length > 3 ? ` and ${fact.files.length - 3} more` : ''} |`)
    }
    if (lane.unjudged.length > 0) lines.push('', '### Not judged', '', ...lane.unjudged.map((entry) => `- \`${entry.reader}\` (${entry.lane}): ${entry.reason}`))
  }
  // The person's judgement beside the floor is what the shadow comparison of RFC 0040 §8 reads.
  lines.push('', 'Reviewer: before merging, label the pull request `lane:low`, `lane:medium` or `lane:high` for the review it needed in your judgement, whatever the floor above says.')
  return `${lines.join('\n')}\n`
}

/** Writes the three files into `target`, which ignores itself when it is the application's `.guren/evidence/`. */
export async function writeChangeEvidence(cwd: string, dir: string, evidence: ChangeEvidence, record: ChangeRecord): Promise<string> {
  const target = resolve(cwd, dir)
  await mkdir(target, { recursive: true })
  if (resolve(cwd, EVIDENCE_DIR) === target) {
    await writeFile(join(target, '.gitignore'), '*\n', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
  const files: Array<[string, string]> = [
    ['evidence.json', `${JSON.stringify(evidence, null, 2)}\n`],
    ['record.json', `${JSON.stringify(record, null, 2)}\n`],
    ['evidence.md', renderEvidenceMarkdown(evidence)],
  ]
  // Each file on its own: one that cannot be written leaves the others to be.
  const failed: string[] = []
  for (const [name, content] of files) {
    await writeFileAtomic(join(target, name), redactSecrets(content)).catch((error: unknown) => failed.push(`${name}: ${firstLine(error)}`))
  }
  if (failed.length > 0) throw new Error(failed.join('; '))
  return target
}

