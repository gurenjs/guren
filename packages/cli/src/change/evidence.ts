/**
 * `guren change:evidence` (RFC 0040 §4): the gate, run as `guren gate --deps` runs it, with the
 * lane of the change beside it. The exit code is the gate's alone; everything else the evidence
 * could not establish is a hold, and the three files are written on every path.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runGit } from '../changed-files'
import type { GateReport } from '../gate'
import { writeFileAtomic } from '../plan/beside'
import { readInstalledVersion } from '../plugin-manifest'
import { judgeChangeLane, rendersPages, type ChangeLaneReport, type Lane } from './lane'
import { openChange, resolveChange } from './resolve'
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
  facts: Array<{ code: string; lane: Lane; target?: string; files: string[] }>
  holds: ChangeHold[]
  eligible: boolean
  gate: { ok: boolean; stages: Array<{ name: string; status: string }> }
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
  /** Defaults to `runGate()`. */
  gate?: (cwd: string, deps: boolean) => Promise<GateReport>
  /** Defaults to `change:lane`'s own judgement. */
  lane?: (cwd: string, base: string, head: string, audit: boolean) => Promise<ChangeLaneReport>
}

async function judgeLane(cwd: string, base: string, head: string, audit: boolean): Promise<ChangeLaneReport> {
  const change = await resolveChange(cwd, base, head)
  const { reader, dispose } = openChange(cwd, change)
  try {
    return await judgeChangeLane(change, reader, audit ? { audit: () => auditChangeRevisions(cwd, change) } : {})
  } finally {
    await dispose()
  }
}

async function runGateDefault(cwd: string, deps: boolean): Promise<GateReport> {
  const { runGate } = await import('../gate')
  return runGate({ cwd, deps })
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

export async function collectChangeEvidence(options: ChangeEvidenceOptions): Promise<ChangeEvidence> {
  const cwd = resolve(options.cwd)
  const holds: ChangeHold[] = []
  const hold = (code: string, message: string): void => {
    holds.push({ code, lane: 'medium', message })
  }

  // Before the gate: its codegen rewrites `.guren/`, which an application may commit.
  const checkout = (await runGit(cwd, ['rev-parse', 'HEAD']))?.[0]
  const dirty = await runGit(cwd, ['status', '--porcelain', '--untracked-files=no', '--', '.'])
  const headSha = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${options.head}^{commit}`]))?.[0]
  if (checkout === undefined || headSha === undefined || checkout !== headSha) {
    hold('checkout-not-head', `the checkout is at ${checkout?.slice(0, 12) ?? 'no commit'}, not at --head ${options.head.slice(0, 12)}, so the gate judged other code than the change. On a pull request, check out the head SHA (actions/checkout's ref), not the merge commit`)
  }
  if (dirty === null) hold('checkout-unreadable', 'git status did not answer, so uncommitted changes could not be ruled out')
  else if (dirty.length > 0) hold('checkout-dirty', `the checkout has ${dirty.length} uncommitted ${dirty.length === 1 ? 'change' : 'changes'} to tracked files, which the gate judged and the change does not hold`)

  let gate: GateReport
  try {
    gate = await (options.gate ?? runGateDefault)(cwd, options.deps)
  } catch (error) {
    // A gate that could not run is a failed gate: the command still fails, and still writes its files.
    gate = { cwd, ok: false, changed: false, stages: [] }
    hold('gate-failed', `the gate could not run: ${(error as Error).message.split('\n')[0]}`)
  }
  if (!gate.ok && gate.stages.length > 0) hold('gate-failed', `the gate failed: ${gate.stages.filter((stage) => stage.status === 'fail').map((stage) => stage.name).join(', ')}`)

  let lane: ChangeLaneReport | undefined
  try {
    lane = await (options.lane ?? judgeLane)(cwd, options.base, options.head, options.audit)
  } catch (error) {
    const reason = (error as Error).message.split('\n')[0]!
    hold('lane-unavailable', `the change could not be read: ${reason}${reason.includes('fetch-depth') ? '' : ' A shallow clone does this: check out with fetch-depth: 0.'}`)
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
  const pages = lane === undefined ? [] : [...new Set(lane.facts.flatMap((fact) => fact.files).filter(rendersPages))]
  if (lane === undefined || pages.length > 0) {
    hold('browser-evidence-unavailable', `browser evidence is not gathered by this version${pages.length > 0 ? `, and the change edits ${pages.length === 1 ? 'a page or a routes file' : 'pages or routes files'}: ${pages.slice(0, 5).join(', ')}${pages.length > 5 ? ', …' : ''}` : ''}`)
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
    eligible: lane !== undefined && lane.floor === 'low' && holds.length === 0,
  }
}

export async function changeRecord(cwd: string, base: string, head: string, evidence: ChangeEvidence): Promise<ChangeRecord> {
  return {
    recordVersion: RECORD_VERSION,
    cli: ownVersion(),
    server: await readInstalledVersion(cwd, '@guren/server').catch(() => null),
    target: 'default',
    environment: process.env.NODE_ENV ?? null,
    base: evidence.lane?.base ?? base,
    mergeBase: evidence.lane?.mergeBase ?? null,
    head: evidence.lane?.head ?? head,
    floor: evidence.lane?.floor ?? null,
    facts: (evidence.lane?.facts ?? []).map(({ code, lane, target, files }) => ({ code, lane, ...(target ? { target } : {}), files })),
    holds: evidence.holds,
    eligible: evidence.eligible,
    gate: { ok: evidence.gate.ok, stages: evidence.gate.stages.map(({ name, status }) => ({ name, status })) },
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
  if (evidence.holds.length > 0) {
    lines.push('', '### Holds', '', ...evidence.holds.map((hold) => `- \`${hold.code}\`: ${hold.message}`))
  }
  lines.push('', '### Gate', '', '| Stage | Status |', '| --- | --- |', ...evidence.gate.stages.map((stage) => `| ${stage.name} | ${stage.status} |`))
  if (lane) {
    for (const level of ['high', 'medium', 'low'] satisfies Lane[]) {
      const facts = lane.facts.filter((fact) => fact.lane === level)
      if (facts.length === 0) continue
      lines.push('', `### ${level}`, '', '| Fact | What | Files |', '| --- | --- | --- |')
      for (const fact of facts) lines.push(`| \`${fact.code}\` | ${escapeCell(fact.message)} | ${escapeCell(fact.files.slice(0, 3).join(', '))}${fact.files.length > 3 ? ` and ${fact.files.length - 3} more` : ''} |`)
    }
    if (lane.unjudged.length > 0) lines.push('', '### Not judged', '', ...lane.unjudged.map((entry) => `- \`${entry.reader}\` (${entry.lane}): ${entry.reason}`))
  }
  return `${lines.join('\n')}\n`
}

/** Writes the three files into `dir`, which ignores itself when it is the default under `.guren/`. */
export async function writeChangeEvidence(cwd: string, dir: string, evidence: ChangeEvidence, record: ChangeRecord): Promise<string> {
  const target = resolve(cwd, dir)
  await mkdir(target, { recursive: true })
  if (resolve(cwd, EVIDENCE_DIR) === target) {
    await writeFile(join(target, '.gitignore'), '*\n', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
  await writeFileAtomic(join(target, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  await writeFileAtomic(join(target, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
  await writeFileAtomic(join(target, 'evidence.md'), renderEvidenceMarkdown(evidence))
  return target
}

