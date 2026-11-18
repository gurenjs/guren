/**
 * Change facts and the lane floor (RFC 0040 §3), the half read from the two revisions alone:
 * paths, migrations, the schema, acceptance tests, policies and manifests, and the audit of both
 * sides when the caller supplies it. What was not read is in `unjudged`, never an absent fact.
 */
import { posix } from 'node:path'

import type { File, ImportDeclaration, Statement } from '@babel/types'

import { formatDestructiveFinding, judgeMigrations, readMigrationSources } from '@guren/orm/internal/migration-guard'

import { parseSourceFile } from '../parse-cache'
import { bracketedTokens, isAcceptanceId } from '../plan/acceptance-status'
import { canonicalSyntax, objectLiteral, topLevelDeclaration, walk } from '../ast-walk'
import { TEST_FILE_PATTERN, toPosixRelative } from '../discovery'
import { extractClassDeclaration } from '../model-parser'
import { isPlanRevisionsDirName, planSlug } from '../plan/beside'
import { readPolicyAbilities } from '../plan/policy-abilities'
import { discoverPlanFiles, isPlanFileName, isPlanInput } from '../plan-check'
import { parseSchemaSource, type SchemaTable } from '../schema-parser'
import { auditCoverageGaps, auditFacts } from './audit-facts'
import { LANES, type FactCode, type Lane } from './fact-classes'
import { applyReviewPolicy, loadBaseReviewPolicy, REVIEW_POLICY_FILE, type LoadedReviewPolicy } from './review-policy'
import type { ChangedPath, ChangeReader, ChangeSide, ResolvedChange } from './resolve'
import type { ChangedDependencyFile, LockfileAdvisories } from './revision-advisories'
import type { BaseRecordReading } from './base-record'
import type { DeclarationSubject, OpenPlan } from './declarations'
import type { ChangeAudits, HeadRecords } from './revision-audit'
import { compareSecurityRecords, type SecurityRecords } from './security-records'

export type { FactCode, Lane } from './fact-classes'

export interface ChangeFact {
  code: FactCode
  /** The floor this fact sets. */
  lane: Lane
  /** The lane the fact had before `guren.review.ts` set it. */
  policyFrom?: Lane
  /** A table, a migration, a plan section: what the fact is about, when it is narrower than its files. */
  target?: string
  files: string[]
  evidence: 'registered' | 'static' | 'path'
  /** The plan and element ids whose declaration lowered it (`docs/plans/comments/plan.json#model.comment`). */
  declaredBy?: string
  message: string
}

export interface ChangeUnjudged {
  reader: string
  reason: string
  lane: Lane
  files?: string[]
}

export interface ChangePlan {
  file: string
  /** Empty where the plan does not read. */
  hash: string
  standing: 'open' | 'closed' | 'unapproved' | 'draft' | 'baseline-removed' | 'unreadable'
}

export interface ChangeLaneReport {
  schemaVersion: 1
  base: string
  mergeBase: string
  head: string
  floor: Lane
  facts: ChangeFact[]
  /** Readers that could not read, or do not exist yet; each sets the floor to at least its lane. */
  unjudged: ChangeUnjudged[]
  /** `compared`: both sides were audited and compared. `loadedCode`: the run executed the application's code, compared or not. */
  audit: { compared: boolean; loadedCode: boolean }
  /** `compared`: both sides' per-route security records were read and compared. */
  records: { compared: boolean; stored?: { head: string; cli: string | null; server: string | null } }
  plans: ChangePlan[]
  /** `guren.review.ts` at the merge base. */
  policy: LoadedReviewPolicy
}

/** ` (declared by docs/plans/comments/plan.json#model.comment)`, or nothing. */
export function declarationNote(fact: Pick<ChangeFact, 'declaredBy'>): string {
  return fact.declaredBy === undefined ? '' : ` (declared by ${fact.declaredBy})`
}

export function highestLane(lanes: Iterable<Lane>): Lane {
  let highest = 0
  for (const lane of lanes) highest = Math.max(highest, LANES.indexOf(lane))
  return LANES[highest]!
}

// `bunfig.toml` is not in the RFC's list: it names the preload and root `bun test` runs under.
// `REVIEW.md` is what the reviewer reads: its generated block too, since nothing checks it against the app in a change.
export const GATE_FILES = new Set([
  'REVIEW.md', '.oxlintrc.json', 'tsconfig.json', 'bunfig.toml', 'guren.arch.ts', 'guren.review.ts', 'playwright.browser.config.ts', 'e2e.browser.config.ts',
  '.claude/settings.json', '.claude/settings.local.json', '.codex/hooks.json', '.cursor/hooks.json',
])
// Wherever they sit: `.npmrc` names the registry an install asks; Cursor reads `BUGBOT.md` and `APPROVAL_POLICY.md` per directory.
export const GATE_BASENAMES = new Set(['.npmrc', 'BUGBOT.md', 'APPROVAL_POLICY.md'])
export const GATE_PREFIXES = ['scripts/', 'bin/', '.github/', '.claude/hooks/', '.codex/hooks/', '.codex/rules/', '.cursor/hooks/', '.cursor/approval-policies/']
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions', 'trustedDependencies', 'patchedDependencies']
const LOCKFILES = new Set(['bun.lock', 'bun.lockb'])
const AMBIENT: ReadonlyArray<{ target: string; test: (path: string) => boolean }> = [
  { target: 'generated files', test: (path) => path.startsWith('.guren/') || path === '.env.example' || path.startsWith('tests/browser/generated/') || path.startsWith('tests/browser/behaviours/generated/') || path.startsWith('docs/spec/') || path.startsWith('.e2e/cache/') },
  { target: 'documentation', test: (path) => path.startsWith('docs/') },
  { target: 'translation catalogs', test: (path) => path.startsWith('lang/') },
]
const AUDIT_IGNORE_MARKER = 'guren-audit-ignore'
const AUDIT_CONFIG_FILES = new Set(['config/audit.ts', 'config/audit.js', 'config/audit.mjs'])
const ACCEPTANCE_NEEDLE = '[AC-'

const MODULE = String.raw`(?:modules/[^/]+/)?`
// What a run collects, wider than discovery's `.test.` rule: bun also takes `_test`, `.spec` and `_spec`, Playwright and e2e the two below.
const TEST_FILE = /[._](?:test|spec)\.[cm]?[jt]sx?$/
const BROWSER_SPEC = new RegExp(`^${MODULE}tests/.+\\.(?:browser|e2e)\\.[cm]?[jt]s$`)
const TESTS_DIR = new RegExp(`^${MODULE}tests/`)
const SOURCE_FILE = /\.[cm]?[jt]sx?$/
const SCHEMA_FILE = new RegExp(`^${MODULE}db/schema\\.ts$`)
const POLICY_FILE = new RegExp(`^${MODULE}app/Policies/.+\\.[cm]?[jt]s$`)
const SECURITY_SURFACE = new RegExp(`^${MODULE}(?:routes(?:/.+)?\\.[cm]?[jt]s|app/Policies/|app/Http/(?:Controllers|Middleware)/)`)
const ROUTES_FILE = new RegExp(`^${MODULE}routes(?:/.+)?\\.[cm]?[jt]s$`)
const PAGE_FILE = new RegExp(`^${MODULE}resources/js/pages/.+\\.[cm]?[jt]sx?$`)

/** A page, or a routes file whose routes render one: what the browser evidence of RFC 0040 §4 covers. */
export const rendersPages = (path: string): boolean => (PAGE_FILE.test(path) || ROUTES_FILE.test(path)) && !TEST_FILE.test(path)

const isTestFile = (path: string): boolean => TEST_FILE.test(path) || BROWSER_SPEC.test(path)
// The files `discoverPolicyFiles()` reads: every source under the directory but a `.test.` sibling.
const isPolicyFile = (path: string): boolean => POLICY_FILE.test(path) && !TEST_FILE_PATTERN.test(path)
const isPlanRecord = (path: string): boolean => isPlanInput(path) || path.split('/').slice(0, -1).some(isPlanRevisionsDirName)
const isAmbient = (path: string): boolean => AMBIENT.some((ambient) => ambient.test(path))
const moduleOf = (path: string): string | null => /^modules\/([^/]+)\//.exec(path)?.[1] ?? null
const list = (names: readonly string[]): string => names.join(', ')

/** The path a changed entry had at the merge base, and the one it has at the head. */
function sides(entry: ChangedPath): { base?: string; head?: string } {
  return {
    ...(entry.status === 'added' ? {} : { base: entry.oldPath ?? entry.path }),
    ...(entry.status === 'deleted' ? {} : { head: entry.path }),
  }
}

function acceptanceIds(text: string | null): string[] {
  return text === null ? [] : [...new Set(bracketedTokens(text).filter(isAcceptanceId))].sort()
}

type Manifest = Record<string, unknown>

function parseManifest(text: string | null): Manifest | null | undefined {
  if (text === null) return null
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Manifest) : undefined
  } catch {
    return undefined
  }
}

function scriptsOf(manifest: Manifest | null | undefined): Record<string, string> {
  const scripts = manifest?.scripts
  if (typeof scripts !== 'object' || scripts === null) return {}
  return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function describeTable(table: SchemaTable): string {
  return table.tableName ?? table.identifier
}

/** What differs between two readings of one table, in the words a person scans. */
function tableDifferences(before: SchemaTable, after: SchemaTable): string[] {
  const differences: string[] = []
  const beforeColumns = new Map(before.columns.map((column) => [column.name, column]))
  const afterColumns = new Map(after.columns.map((column) => [column.name, column]))
  const added = [...afterColumns.keys()].filter((name) => !beforeColumns.has(name))
  const removed = [...beforeColumns.keys()].filter((name) => !afterColumns.has(name))
  const changed = [...afterColumns.keys()].filter((name) => beforeColumns.has(name) && JSON.stringify(beforeColumns.get(name)) !== JSON.stringify(afterColumns.get(name)))
  if (added.length > 0) differences.push(`columns added: ${list(added)}`)
  if (removed.length > 0) differences.push(`columns removed: ${list(removed)}`)
  if (changed.length > 0) differences.push(`columns changed: ${list(changed)}`)
  if (before.tableName !== after.tableName) differences.push(`table name ${before.tableName ?? '(none)'} to ${after.tableName ?? '(none)'}`)
  if (JSON.stringify(before.constraints) !== JSON.stringify(after.constraints)) differences.push('indexes or constraints changed')
  return differences
}

/** The words of a script as a shell splits them: a quoted or escaped space stays in its word. */
function scriptWords(script: string): string[] {
  const words: string[] = []
  let word = ''
  let quote: string | undefined
  for (let index = 0; index < script.length; index++) {
    const char = script[index]!
    if (quote) {
      if (char === quote) quote = undefined
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '\\' && index + 1 < script.length) {
      word += script[++index]
    } else if (/[\s=;|&()<>`]/.test(char)) {
      if (word.length > 0) words.push(word)
      word = ''
    } else {
      word += char
    }
  }
  if (word.length > 0) words.push(word)
  return words
}

/** A suppression covers its own line and the next, so one is told from another by both. */
function auditSuppressions(text: string | null): string[] {
  const lines = (text ?? '').split('\n')
  return lines.flatMap((line, index) => (line.includes(AUDIT_IGNORE_MARKER) ? [`${line.trim()}\n${lines[index + 1]?.trim() ?? ''}`] : []))
}

/** The policies a file declares at its top level: classes, and `definePolicy()` definitions. */
function policyNames(ast: File): string[] {
  return ast.program.body.flatMap((node) => {
    const declared = extractClassDeclaration(node)
    if (declared) return [declared.id?.name ?? 'default']
    return (topLevelDeclaration(node)?.declarations ?? []).flatMap((declarator) =>
      declarator.id.type === 'Identifier' && declarator.init?.type === 'CallExpression' && declarator.init.callee.type === 'Identifier' && declarator.init.callee.name === 'definePolicy' ? [declarator.id.name] : [],
    )
  })
}

export interface JudgeChangeLaneOptions {
  /** Audits both sides; asked only when the change touches a file the audit reads. Without it the audit facts are not judged. */
  audit?: () => Promise<ChangeAudits>
  /** `bun audit` on the lockfile governing each changed dependency file, both sides; asked only when there is one. Without it the advisories are not judged. */
  advisories?: (files: ChangedDependencyFile[]) => Promise<LockfileAdvisories[]>
  /** The merge base's stored record (`--base-record`), read where the base does not rebuild from this install. */
  baseRecord?: BaseRecordReading
  /** The head's records read alone, asked only when a stored base stands in. */
  headRecords?: () => Promise<HeadRecords>
}

/**
 * Judges a resolved change from its two revisions. Every changed path ends in at least one fact,
 * and the floor is the highest lane among the facts and the readers that could not read.
 */
export async function judgeChangeLane(change: ResolvedChange, reader: ChangeReader, options: JudgeChangeLaneOptions = {}): Promise<ChangeLaneReport> {
  const facts: ChangeFact[] = []
  const unjudged: ChangeUnjudged[] = []
  const claimed = new Set<ChangedPath>()
  // The entries, not their names: an outside-app path is named from the root, as an app path of the same spelling is.
  const dependencyEntries = new Set<ChangedPath>()
  // What a declarable fact is about, for the declaration matcher to read once every fact is in.
  const subjects = new Map<ChangeFact, DeclarationSubject>()
  const fact = (entries: readonly ChangedPath[], value: Omit<ChangeFact, 'files'>, subject?: DeclarationSubject): void => {
    const created = { ...value, files: entries.map((entry) => entry.path) }
    facts.push(created)
    if (subject) subjects.set(created, subject)
    for (const entry of entries) {
      claimed.add(entry)
      if (value.code === 'dependencies-changed') dependencyEntries.add(entry)
    }
  }
  const read = (side: ChangeSide, path: string | undefined): Promise<string | null> => (path === undefined ? Promise.resolve(null) : reader.read(side, path))
  const inApp = change.paths.filter((entry) => !entry.outsideApp)
  const touches = (entry: ChangedPath, test: (path: string) => boolean): boolean => Object.values(sides(entry)).some(test)

  const isGatePath = (path: string): boolean => GATE_FILES.has(path) || GATE_BASENAMES.has(posix.basename(path)) || GATE_PREFIXES.some((prefix) => path.startsWith(prefix))
  const fromRoot = (entry: ChangedPath, path: string): string => (entry.outsideApp ? path : `${change.appPrefix}${path}`)
  const readEntry = (entry: ChangedPath, side: ChangeSide, path: string | undefined): Promise<string | null> =>
    path === undefined ? Promise.resolve(null) : entry.outsideApp ? reader.readOutside(side, path) : reader.read(side, path)

  for (const [kind, reason] of [['symlink', "git gives a link's target as its content, so what it points at was not read"], ['submodule', 'a submodule pointer moved, and nothing inside the submodule was read']] as const) {
    const files = change.paths.filter((entry) => entry.kind === kind).map((entry) => entry.path)
    if (files.length > 0) unjudged.push({ reader: kind, reason, lane: 'high', files })
  }

  for (const entry of inApp) {
    if (touches(entry, isPlanRecord)) fact([entry], { code: 'plan-record', lane: 'high', evidence: 'path', message: `${entry.path} ${entry.status}: a plan, its approvals, its decision log or its closing document` })
  }

  const trees = { base: await reader.paths('base'), head: await reader.paths('head') }
  // From the repository root: the application's manifest, the root's above it, and each one a script enters with `cd` or `--cwd`.
  const gateManifests = [...new Set([`${change.appPrefix}package.json`, 'package.json'])]
  const scriptNamed = new Set<string>()
  const scriptsChanged = new Map<string, string[]>()
  for (const manifest of gateManifests) {
    const dir = posix.dirname(manifest) === '.' ? '' : `${posix.dirname(manifest)}/`
    const [old, now] = [scriptsOf(parseManifest(await reader.readOutside('base', manifest))), scriptsOf(parseManifest(await reader.readOutside('head', manifest)))]
    const names = [...new Set([...Object.keys(old), ...Object.keys(now)])].filter((name) => old[name] !== now[name])
    if (names.length > 0) scriptsChanged.set(manifest, names)
    for (const script of [...Object.values(old), ...Object.values(now)]) {
      const tokens = scriptWords(script)
      const entered: string[] = []
      let cwd = ''
      tokens.forEach((token, index) => {
        const flag = tokens[index - 1]
        if (flag === 'cd') entered.push((cwd = posix.normalize(`${cwd}${token}/`)))
        else if (flag === '--cwd' || flag === '-C') entered.push(posix.normalize(`${token}/`))
      })
      for (const token of tokens) {
        for (const from of ['', ...entered]) scriptNamed.add(posix.normalize(`${dir}${from}${token}`))
      }
      for (const from of entered) {
        const nested = posix.normalize(`${dir}${from}package.json`)
        if (!gateManifests.includes(nested)) gateManifests.push(nested)
      }
    }
  }
  for (const entry of change.paths) {
    if (claimed.has(entry)) continue
    const named = touches(entry, (path) => scriptNamed.has(fromRoot(entry, path)))
    if (named || touches(entry, isGatePath)) {
      const why = named ? 'a package.json script names it' : entry.outsideApp ? 'at the repository root, what CI, the gate or the harness runs' : 'what the gate or the harness runs'
      fact([entry], { code: 'gate-input', lane: 'high', evidence: 'path', message: `${entry.path} ${entry.status}: ${why}` })
    }
  }

  const fallbackCode = (entry: ChangedPath): FactCode => (entry.outsideApp ? 'outside-app' : entry.status === 'added' ? (SOURCE_FILE.test(entry.path) ? 'file-added' : 'non-source-added') : entry.status === 'deleted' ? 'source-removed' : entry.status === 'renamed' ? 'source-renamed' : 'source-edited')
  for (const entry of change.paths) {
    if (claimed.has(entry) || !touches(entry, (path) => posix.basename(path) === 'package.json')) continue
    const located = Object.values(sides(entry)).map((path) => fromRoot(entry, path))
    const scripts = [...new Set(located.flatMap((path) => scriptsChanged.get(path) ?? []))]
    if (scripts.length > 0) fact([entry], { code: 'gate-input', lane: 'high', target: 'package.json scripts', evidence: 'static', message: `scripts changed: ${list(scripts)}` })
    const before = parseManifest(await readEntry(entry, 'base', sides(entry).base))
    const after = parseManifest(await readEntry(entry, 'head', sides(entry).head))
    if (before === undefined || after === undefined) {
      unjudged.push({ reader: 'manifest', reason: `${entry.path} does not parse on one side, so its scripts and dependencies were not compared`, lane: 'high', files: [entry.path] })
      if (!claimed.has(entry)) fact([entry], { code: fallbackCode(entry), lane: 'medium', evidence: 'path', message: `${entry.path} ${entry.status}` })
      continue
    }
    const differs = (key: string): boolean => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)
    const dependencies = DEPENDENCY_FIELDS.filter(differs)
    if (dependencies.length > 0) fact([entry], { code: 'dependencies-changed', lane: 'medium', evidence: 'static', message: `${entry.path}: ${list(dependencies)} changed` })
    const gated = located.some((path) => gateManifests.includes(path))
    const other = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((key) => !DEPENDENCY_FIELDS.includes(key) && !(gated && key === 'scripts') && differs(key))
    if (other.length > 0 || !claimed.has(entry)) {
      fact([entry], { code: fallbackCode(entry), lane: 'medium', evidence: 'static', message: `${entry.path}: ${other.length > 0 ? `${list(other)} changed` : 'no field changed'}` })
    }
  }
  for (const entry of change.paths) {
    if (!claimed.has(entry) && touches(entry, (path) => LOCKFILES.has(posix.basename(path)))) fact([entry], { code: 'dependencies-changed', lane: 'medium', evidence: 'path', message: `${entry.path} ${entry.status}` })
  }
  const elsewhere = change.paths.filter((entry) => entry.outsideApp && !claimed.has(entry))
  if (elsewhere.length > 0) fact(elsewhere, { code: 'outside-app', lane: 'medium', evidence: 'path', message: `${elsewhere.length} ${elsewhere.length === 1 ? 'path' : 'paths'} outside the application root, which no reader here judges` })

  const migrationDir = (path: string): string | undefined => {
    const dir = posix.dirname(path)
    return dir !== '.' && (trees.base.has(`${dir}/migration.sql`) || trees.head.has(`${dir}/migration.sql`)) ? dir : undefined
  }
  const migrations = new Map<string, ChangedPath[]>()
  for (const entry of inApp) {
    if (claimed.has(entry)) continue
    for (const dir of new Set(Object.values(sides(entry)).map(migrationDir))) {
      if (dir !== undefined) migrations.set(dir, [...(migrations.get(dir) ?? []), entry])
    }
  }
  const addedByFolder = new Map<string, string[]>()
  for (const [dir, entries] of migrations) {
    if (trees.base.has(`${dir}/migration.sql`)) {
      fact(entries, { code: 'migration-destructive', lane: 'high', target: dir, evidence: 'path', message: `${dir}: an existing migration edited or deleted` })
    } else {
      addedByFolder.set(posix.dirname(dir), [...(addedByFolder.get(posix.dirname(dir)) ?? []), posix.basename(dir)])
    }
  }
  for (const [folder, names] of addedByFolder) {
    names.sort()
    const entriesOf = (name: string): ChangedPath[] => migrations.get(`${folder}/${name}`) ?? []
    let judged: ReturnType<typeof judgeMigrations>
    try {
      const dir = await reader.materialize('head', [...trees.head].filter((path) => path.startsWith(`${folder}/`)))
      judged = judgeMigrations(readMigrationSources(posix.join(dir, folder), names, folder), { exemptCreatedInRun: true })
    } catch (error) {
      unjudged.push({ reader: 'migration-guard', reason: (error as Error).message, lane: 'high', files: names.map((name) => `${folder}/${name}/migration.sql`) })
      for (const name of names) fact(entriesOf(name), { code: 'migration', lane: 'medium', target: `${folder}/${name}`, evidence: 'path', message: `${folder}/${name}: added, and not judged` })
      continue
    }
    const findings = [...judged.unacknowledged, ...judged.acknowledged.flatMap((entry) => entry.findings)]
    const folders = [...trees.head].flatMap((path) => (path.startsWith(`${folder}/`) && posix.basename(path) === 'migration.sql' && posix.dirname(posix.dirname(path)) === folder ? [posix.basename(posix.dirname(path))] : [])).sort()
    for (const name of names) {
      const destructive = findings.filter((finding) => finding.migration === name)
      if (destructive.length > 0) {
        const marker = judged.acknowledged.some((entry) => entry.migration === name) ? ' (acknowledged by its marker, which a person reads)' : ''
        fact(entriesOf(name), { code: 'migration-destructive', lane: 'high', target: `${folder}/${name}`, evidence: 'static', message: `${destructive.map(formatDestructiveFinding).join('; ')}${marker}` })
      } else {
        const previous = folders.filter((other) => other < name).at(-1)
        const subject: DeclarationSubject = { kind: 'migration', dir: `${folder}/${name}`, files: entriesOf(name).map((entry) => entry.path), ...(previous ? { previous: `${folder}/${previous}` } : {}) }
        fact(entriesOf(name), { code: 'migration', lane: 'medium', target: `${folder}/${name}`, evidence: 'static', message: `${folder}/${name}: added, nothing destructive` }, subject)
      }
    }
  }

  for (const entry of inApp) {
    if (claimed.has(entry) || !touches(entry, (path) => SCHEMA_FILE.test(path))) continue
    const { base, head } = sides(entry)
    const [beforeText, afterText] = [await read('base', base), await read('head', head)]
    const before = beforeText === null ? [] : parseSchemaSource(beforeText, base!, moduleOf(base!))
    const after = afterText === null ? [] : parseSchemaSource(afterText, head!, moduleOf(head!))
    if (before === undefined || after === undefined) {
      unjudged.push({ reader: 'schema', reason: `${entry.path} does not parse on one side, so its tables were not compared`, lane: 'medium', files: [entry.path] })
      fact([entry], { code: 'source-edited', lane: 'medium', evidence: 'path', message: `${entry.path} ${entry.status}` })
      continue
    }
    const beforeTables = new Map(before.map((table) => [table.identifier, table]))
    const afterTables = new Map(after.map((table) => [table.identifier, table]))
    for (const [identifier, table] of afterTables) {
      const previous = beforeTables.get(identifier)
      if (!previous) fact([entry], { code: 'schema-changed', lane: 'medium', target: describeTable(table), evidence: 'static', message: `table ${describeTable(table)} added (${table.columns.length} columns)` }, { kind: 'table', table, file: head!, tables: after })
      else if (JSON.stringify(previous) !== JSON.stringify(table)) {
        const differences = tableDifferences(previous, table)
        // What the reader did not follow is no table fact a policy may lower.
        if (differences.length === 0) fact([entry], { code: 'source-edited', lane: 'medium', target: describeTable(table), evidence: 'static', message: `table ${describeTable(table)}: a part the reader does not follow changed` })
        else fact([entry], { code: 'schema-changed', lane: 'medium', target: describeTable(table), evidence: 'static', message: `table ${describeTable(table)}: ${differences.join('; ')}` })
      }
    }
    for (const [identifier, table] of beforeTables) {
      if (!afterTables.has(identifier)) fact([entry], { code: 'schema-changed', lane: 'medium', target: describeTable(table), evidence: 'static', message: `table ${describeTable(table)} removed` })
    }
    if (!claimed.has(entry)) fact([entry], { code: 'source-edited', lane: 'medium', evidence: 'static', message: `${entry.path}: no table the reader sees changed` })
    else {
      // A table fact is lowerable, and code beside the tables must not ride it. An added table's own is kept apart:
      // the declaration matcher accounts for it only where it matched that table's whole statement.
      const [residueBefore, residueAfter] = [schemaResidue(beforeText, base, before), schemaResidue(afterText, head, after)]
      const added = new Set([...afterTables.keys()].filter((identifier) => !beforeTables.has(identifier)))
      const kept = (residue: SchemaResidue) => residue.filter((item) => item.table === undefined || !added.has(item.table)).map((item) => item.text).join('\n')
      if (residueBefore === undefined || residueAfter === undefined || kept(residueBefore) !== kept(residueAfter)) {
        fact([entry], { code: 'source-edited', lane: 'medium', evidence: 'static', message: `${entry.path}: a function inside its tables, or code beside them, changed` })
      } else {
        for (const identifier of added) {
          const own = residueAfter.filter((item) => item.table === identifier)
          if (own.length === 0) continue
          fact([entry], { code: 'source-edited', lane: 'medium', target: identifier, evidence: 'static', message: `${entry.path}: table ${identifier} holds code the column reader does not state (${own.length === 1 ? 'a function or a name' : `${own.length} functions or names`})` }, { kind: 'table-residue', file: head!, identifier })
        }
      }
    }
  }

  let existingIds: Promise<Set<string>> | undefined
  const idsAtBase = (): Promise<Set<string>> =>
    (existingIds ??= (async () => {
      const ids = new Set<string>()
      for (const file of (await reader.containing('base', ACCEPTANCE_NEEDLE)).filter(isTestFile)) {
        for (const id of acceptanceIds(await reader.read('base', file))) ids.add(id)
      }
      return ids
    })())
  for (const entry of inApp) {
    if (claimed.has(entry) || !touches(entry, isTestFile) || Object.values(sides(entry)).every(isAmbient)) continue
    const { base, head } = sides(entry)
    const wasTest = base !== undefined && isTestFile(base)
    const isTest = head !== undefined && isTestFile(head)
    const [beforeText, afterText] = [await read('base', base), await read('head', head)]
    const carried = wasTest ? acceptanceIds(beforeText) : []
    // A browser spec and a behaviour spec have a runner each, and neither collects the other's name.
    const runner = (path: string): string => /\.(browser|e2e)\.[^.]+$/.exec(path)?.[1] ?? 'test'
    if (wasTest && isTest && entry.status === 'renamed' && (carried.length > 0 || runner(base!) !== runner(head!))) {
      const why = carried.length > 0 ? `it carries ${list(carried)}, and a person checks a run still collects it` : 'another runner collects that name'
      fact([entry], { code: carried.length > 0 ? 'acceptance-changed' : 'test-removed', lane: 'high', evidence: 'static', message: `${base} renamed to ${head}: ${why}` })
    } else if (wasTest && !isTest) {
      const how = head === undefined ? 'deleted' : `renamed to ${head}, which no test run collects`
      if (carried.length > 0) fact([entry], { code: 'acceptance-changed', lane: 'high', evidence: 'static', message: `${base} ${how}; it carried ${list(carried)}` })
      else fact([entry], { code: 'test-removed', lane: 'high', evidence: 'path', message: `${base} ${how}` })
    } else if (wasTest && carried.length > 0 && beforeText !== afterText) {
      const lost = carried.filter((id) => !acceptanceIds(afterText).includes(id))
      fact([entry], { code: 'acceptance-changed', lane: 'high', evidence: 'static', message: `${entry.path}: an acceptance test edited${lost.length > 0 ? `; no longer carries ${list(lost)}` : ''}` })
    } else if (entry.status === 'added' && TESTS_DIR.test(entry.path)) {
      const existing = await idsAtBase()
      const repeated = acceptanceIds(afterText).filter((id) => existing.has(id))
      if (repeated.length > 0) fact([entry], { code: 'acceptance-added', lane: 'medium', evidence: 'static', message: `${entry.path}: a test added under ${list(repeated)}, which an existing test carries` })
      else fact([entry], { code: 'test-added', lane: 'low', evidence: 'static', message: `${entry.path}: a test added, carrying no existing acceptance id` })
    }
  }

  for (const entry of inApp) {
    if (claimed.has(entry) || !touches(entry, isPolicyFile)) continue
    const { base, head } = sides(entry)
    if (base === undefined) {
      fact([entry], { code: 'policy-added', lane: 'medium', evidence: 'path', message: `${entry.path} ${entry.status}` }, { kind: 'file', path: entry.path })
      continue
    }
    if (!isPolicyFile(base)) {
      // Existing source moved in, not a policy the change wrote: not the declarable `policy-added`.
      fact([entry], { code: 'source-renamed', lane: 'medium', evidence: 'path', message: `${base} renamed to ${entry.path}, where it is read as a policy` })
      continue
    }
    if (head === undefined || !isPolicyFile(head)) {
      fact([entry], { code: 'policy-removed', lane: 'high', evidence: 'path', message: `${base} ${head === undefined ? 'deleted' : `renamed to ${head}, where no policy is read`}` })
      continue
    }
    const abilities = async (side: ChangeSide, path: string): Promise<string[] | string> => {
      const text = await reader.read(side, path)
      const ast = text === null ? null : parseSourceFile(text, path)
      if (!ast) return `${path} does not parse at the ${side}`
      const declared = policyNames(ast)
      if (declared.length > 1) return `${path} declares ${declared.length} policies at the ${side} (${list(declared)}) and one is read per file`
      const result = readPolicyAbilities(ast, declared[0] ?? posix.basename(path).replace(/\.[^.]+$/, ''))
      if ('unreadable' in result) return `${path} at the ${side}: ${result.unreadable}`
      if (result.open) return `${path} at the ${side}: ${result.open}`
      const names = [...result.declared, ...result.fields]
      return result.exposes ? names.filter((name) => result.exposes!.includes(name)) : names
    }
    const [before, after] = [await abilities('base', base), await abilities('head', head)]
    if (typeof before === 'string' || typeof after === 'string') {
      const reason = typeof before === 'string' ? before : (after as string)
      unjudged.push({ reader: 'policy', reason: `${reason}, so a removed ability would not show`, lane: 'high', files: [entry.path] })
      fact([entry], { code: 'policy-changed', lane: 'medium', evidence: 'path', message: `${entry.path} ${entry.status}` })
      continue
    }
    const removed = before.filter((name) => !after.includes(name))
    if (removed.length > 0) fact([entry], { code: 'policy-removed', lane: 'high', evidence: 'static', message: `${entry.path}: abilities removed: ${list(removed)}` })
    else fact([entry], { code: 'policy-changed', lane: 'medium', evidence: 'static', message: `${entry.path} ${entry.status}; no ability removed` })
  }

  for (const entry of inApp) {
    const { base, head } = sides(entry)
    if (touches(entry, (path) => AUDIT_CONFIG_FILES.has(path))) {
      fact([entry], { code: 'audit-suppressed', lane: 'high', evidence: 'path', message: `${entry.path} ${entry.status}: it holds the audit's ignore list` })
      continue
    }
    if (head === undefined || !SOURCE_FILE.test(head) || isAmbient(head)) continue
    const suppressions = auditSuppressions(await reader.read('head', head))
    if (suppressions.length === 0) continue
    const existing = auditSuppressions(await read('base', base))
    const added = suppressions.filter((suppression) => {
      const at = existing.indexOf(suppression)
      if (at !== -1) existing.splice(at, 1)
      return at === -1
    })
    if (added.length > 0) fact([entry], { code: 'audit-suppressed', lane: 'high', evidence: 'static', message: `${entry.path}: a ${AUDIT_IGNORE_MARKER} the base did not have, on ${added.map((suppression) => `\`${suppression.split('\n')[1] || suppression.split('\n')[0]}\``).join(', ')}` })
  }

  for (const entry of inApp) {
    if (!claimed.has(entry) && touches(entry, (path) => path.startsWith('docs/lessons/'))) fact([entry], { code: 'lesson', lane: 'medium', evidence: 'path', message: `${entry.path} ${entry.status}: a rule the agents will follow` })
  }
  for (const ambient of AMBIENT) {
    const entries = inApp.filter((entry) => !claimed.has(entry) && Object.values(sides(entry)).every(ambient.test))
    if (entries.length > 0) fact(entries, { code: 'ambient', lane: 'low', target: ambient.target, evidence: 'path', message: `${entries.length} ${entries.length === 1 ? 'file' : 'files'}: ${ambient.target}` })
  }

  for (const entry of inApp) {
    if (claimed.has(entry)) continue
    const code = fallbackCode(entry)
    fact([entry], { code, lane: 'medium', evidence: 'path', message: `${entry.path} ${entry.status}${entry.oldPath ? ` from ${entry.oldPath}` : ''}` }, code === 'file-added' ? { kind: 'file', path: entry.path } : undefined)
  }

  // One run serves the audit and the security records: both read the same two exports.
  let auditPromise: Promise<ChangeAudits | undefined> | undefined
  const auditRun = (): Promise<ChangeAudits | undefined> => (auditPromise ??= options.audit ? options.audit() : Promise.resolve(undefined))
  // The audit scans `app`, `src`, `routes`, `config` and each whole module, loads what the routes import and reads the install.
  const auditedPaths = change.paths.filter((entry) => entry.outsideApp || touches(entry, (path) => !isAmbient(path) && !path.startsWith('tests/')))
  const surface = inApp.filter((entry) => touches(entry, (path) => SECURITY_SURFACE.test(path)))
  const records: ChangeLaneReport['records'] = { compared: false }
  // Read whenever both exports ran: a validator, a provider or the entry can weaken a route too.
  const pair = auditedPaths.length > 0 ? (await auditRun())?.records : undefined
  const files = surface.map((entry) => entry.path)
  const touched = change.paths.filter((entry) => !entry.outsideApp).map((entry) => entry.path)
  let compared: { base: SecurityRecords; head: SecurityRecords } | undefined
  let notCompared: { reason: string; lane: Lane } | undefined
  if (pair && !('unavailable' in pair)) {
    if (pair.base.recordVersion === pair.head.recordVersion) compared = pair
    else notCompared = { reason: `the two sides' records are of versions ${pair.base.recordVersion} and ${pair.head.recordVersion}`, lane: 'medium' }
  } else if (pair && 'unavailable' in pair && pair.side === 'head') {
    // The change made its own head unreadable: what it did to its routes cannot be ordered.
    notCompared = { reason: `${pair.unavailable}, while the base's were`, lane: 'high' }
  } else if (pair && 'unavailable' in pair && options.baseRecord) {
    // The base did not rebuild from this install: the record a push run stored for it stands in.
    const stored = options.baseRecord
    if ('unusable' in stored) notCompared = { reason: `${pair.unavailable}, and ${stored.unusable}${stored.fix ? ` (${stored.fix})` : ''}`, lane: 'medium' }
    else {
      const head = pair.head ?? (await options.headRecords?.()) ?? { unavailable: 'the head was not read alone', exported: false }
      if ('unavailable' in head) notCompared = { reason: `${head.unavailable}, while the stored base's were read`, lane: 'exported' in head && head.exported ? 'high' : 'medium' }
      else {
        compared = { base: stored.records, head }
        records.stored = { head: stored.head, cli: stored.cli, server: stored.server }
      }
    }
  } else if (pair && 'unavailable' in pair) {
    notCompared = { reason: pair.unavailable, lane: 'medium' }
  } else if (!pair) {
    notCompared = { reason: 'the two sides were not exported and introspected', lane: 'medium' }
  }
  if (compared) {
    records.compared = true
    const comparison = compareSecurityRecords(compared.base, compared.head)
    facts.push(...comparison.facts.map((fact) => ({ ...fact, files: files.length > 0 ? files : touched })))
    if (comparison.incomparable.length > 0) unjudged.push({ reader: 'security-records', reason: `routes whose records cannot be ordered against the base: ${comparison.incomparable.join('; ')}`, lane: 'high', files: files.length > 0 ? files : touched })
    // A skip the change brought in is the change's doing: a route it registers there is not on the list at all.
    const [baseSkipped, headSkipped] = [compared.base.skipped ?? [], compared.head.skipped ?? []]
    const added = headSkipped.filter((entry) => !baseSkipped.includes(entry))
    const shared = headSkipped.filter((entry) => baseSkipped.includes(entry))
    if (added.length > 0) unjudged.push({ reader: 'security-records', reason: `the head's introspection skipped ${added.join(', ')}, which the base's did not, so a route registered there was not compared`, lane: 'high', files: files.length > 0 ? files : touched })
    else if (shared.length > 0 && files.length > 0) unjudged.push({ reader: 'security-records', reason: `introspection skipped ${shared.join(', ')} on both sides, so a route registered there was not compared`, lane: 'medium', files })
  } else if (notCompared && (notCompared.lane === 'high' || surface.length > 0)) {
    // A base that cannot be read says nothing against the change; a head the change made unreadable does.
    unjudged.push({ reader: 'security-records', reason: `${notCompared.reason}, so authorization-removed and validation-removed were not judged`, lane: notCompared.lane, files: notCompared.lane === 'high' && files.length === 0 ? touched : files })
  }
  const audit = { compared: false, loadedCode: false }
  if (auditedPaths.length > 0) {
    const notJudged = (why: string): void => {
      unjudged.push({ reader: 'audit', reason: `${why}, so audit-fail, audit-warn-changed, csrf-exemption and sensitive-exposure were not judged`, lane: 'medium', files: auditedPaths.map((entry) => entry.path) })
    }
    const audits = await auditRun()
    if (!audits) notJudged('the audit was not run on the two sides')
    else if ('unavailable' in audits) {
      audit.loadedCode = audits.loadedCode === true
      notJudged(audits.unavailable)
    } else {
      audit.compared = audit.loadedCode = true
      facts.push(...(await auditFacts(change, reader, audits.base, audits.head)))
      const gaps = auditCoverageGaps(audits.base, audits.head)
      if (gaps.length > 0) unjudged.push({ reader: 'audit-coverage', reason: `the audit read less at the head than at the base: ${gaps.join('; ')}`, lane: 'medium' })
    }
  }
  // A lockfile another fact claimed first (a gate input under `scripts/`) still says what installs.
  for (const entry of change.paths) {
    if (touches(entry, (path) => LOCKFILES.has(posix.basename(path)))) dependencyEntries.add(entry)
  }
  const dependencies = [...new Set([...dependencyEntries].map((entry) => entry.path))]
  if (dependencies.length > 0) {
    const notJudged = (why: string, files: string[]): void => {
      unjudged.push({ reader: 'dependency-advisory', reason: `${why}, so an advisory the changed dependencies bring in was not judged`, lane: 'medium', files })
    }
    if (!options.advisories) notJudged('`bun audit` was not run on the two sides', dependencies)
    else {
      const located = [...new Map([...dependencyEntries].map((entry) => [fromRoot(entry, entry.path), {
        file: entry.path,
        fromRoot: fromRoot(entry, entry.path),
        ...(entry.oldPath ? { baseFromRoot: fromRoot(entry, entry.oldPath) } : {}),
      }])).values()]
      for (const result of await options.advisories(located)) {
        if ('unavailable' in result) {
          notJudged(result.unavailable, result.files)
          continue
        }
        const before = new Set(result.base)
        for (const key of result.head.filter((entry) => !before.has(entry))) {
          const target = key.slice('deps:'.length)
          facts.push({ code: 'dependency-advisory', lane: 'high', target, files: result.files, evidence: 'static', message: `an advisory the base's ${result.directory}bun.lock does not have, both sides read against today's advisories` })
        }
      }
    }
  }

  const plans = await readChangePlans(reader, trees.head)
  // A change that writes a plan record is high already, and must not cite what it wrote.
  const declared = plans.open.length > 0 && subjects.size > 0 && !facts.some((entry) => entry.code === 'plan-record')
    ? await (await import('./declarations')).applyPlanDeclarations(facts, subjects, plans.open, (path) => reader.read('head', path))
    : facts
  const policy = await loadBaseReviewPolicy(reader)
  const judged = policy.state === 'read' ? applyReviewPolicy(declared, change.paths, policy.policy) : declared
  if (policy.state === 'unreadable') {
    unjudged.push({ reader: 'review-policy', reason: `${REVIEW_POLICY_FILE} at the merge base was not applied, so a lane it raises would not show: ${policy.reason}`, lane: 'high', files: [REVIEW_POLICY_FILE] })
  }

  return {
    schemaVersion: 1,
    base: change.base,
    mergeBase: change.mergeBase,
    head: change.head,
    floor: highestLane([...judged.map((entry) => entry.lane), ...unjudged.map((entry) => entry.lane)]),
    facts: judged,
    unjudged,
    audit,
    records,
    plans: plans.listed,
    policy,
  }
}

/** What `schemaResidue()` keeps, each item with the table whose statement alone holds it. */
type SchemaResidue = Array<{ table?: string; text: string }>

/**
 * A schema file without its tables, its drizzle imports and an object listing only tables: what
 * `schema-changed` does not account for, compared per statement as syntax. Inside a table what no
 * column property states is kept: a function (but a foreign key's), a spread, a tagged template and
 * any other name.
 */
function schemaResidue(text: string | null, file: string | undefined, tables: readonly SchemaTable[]): SchemaResidue | undefined {
  if (text === null || file === undefined) return []
  const ast = parseSourceFile(text, file)
  if (!ast) return undefined
  const names = new Set(tables.map((table) => table.identifier))
  const framework = (statement: Statement): statement is ImportDeclaration => statement.type === 'ImportDeclaration' && /^(?:drizzle-orm|@guren\/orm)(?:\/|$)/.test(statement.source.value) && statement.specifiers.length > 0
  const builders = new Set(ast.program.body.filter(framework).flatMap((statement) => statement.specifiers.map((specifier) => specifier.local.name)))
  const listsTables = (init: unknown): boolean => {
    const object = objectLiteral(init as never)
    return object !== null && object.properties.every((property) => property.type === 'ObjectProperty' && property.shorthand && property.value.type === 'Identifier' && names.has(property.value.name))
  }
  const kept: SchemaResidue = []
  for (const statement of ast.program.body) {
    if (framework(statement)) continue
    const declaration = topLevelDeclaration(statement)
    if (!declaration?.declarations.every((declarator) => declarator.id.type === 'Identifier' && (names.has(declarator.id.name) || listsTables(declarator.init)))) {
      kept.push({ text: canonicalSyntax(statement) })
      continue
    }
    // One table's own residue is told apart only where the statement declares that table alone.
    const only = declaration.declarations.length === 1 && declaration.declarations[0]!.id.type === 'Identifier' && names.has(declaration.declarations[0]!.id.name) ? declaration.declarations[0]!.id.name : undefined
    const keep = (node: Parameters<typeof canonicalSyntax>[0]): void => void kept.push({ ...(only ? { table: only } : {}), text: canonicalSyntax(node) })
    walk(declaration.declarations.map((declarator) => declarator.init), (node, parent) => {
      // `.references(() => users.id)`: the foreign key the column reader states.
      const body = node.type === 'ArrowFunctionExpression' ? (node.body as { type?: string; object?: { type?: string; name?: string }; computed?: boolean }) : undefined
      if (body?.type === 'MemberExpression' && !body.computed && body.object?.type === 'Identifier' && names.has(String(body.object.name))) return false
      if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'SpreadElement' || node.type === 'TaggedTemplateExpression') {
        keep(node)
        return false
      }
      if (node.type !== 'Identifier' || builders.has(String(node.name)) || names.has(String(node.name))) return
      const named = parent as { type?: string; key?: unknown; property?: unknown; computed?: boolean } | null
      if (!named?.computed && ((named?.type === 'MemberExpression' && named.property === node) || (named?.type === 'ObjectProperty' && named.key === node))) return
      keep(node)
    })
  }
  return kept
}

/** The plans at the head with the standing each has there, read from the head's own records, and the open ones. */
async function readChangePlans(reader: ChangeReader, head: ReadonlySet<string>): Promise<{ listed: ChangePlan[]; open: OpenPlan[] }> {
  const inputs = [...head].filter(isPlanInput)
  if (!inputs.some((path) => isPlanFileName(posix.basename(path)))) return { listed: [], open: [] }
  const root = await reader.materialize('head', inputs)
  const [{ readPlanFile }, { readPlanApprovalStanding }, { readPlanClosedHash }, { planDigest }] = await Promise.all([
    import('../plan-render'), import('../plan/approvals'), import('../plan/open-plan'), import('../plan/identity'),
  ])
  const plans: ChangePlan[] = []
  const open: OpenPlan[] = []
  for (const path of (await discoverPlanFiles(root)).files) {
    const file = toPosixRelative(root, path)
    try {
      const { plan } = await readPlanFile(path, root)
      const standing = await readPlanApprovalStanding(path, plan)
      const hash = standing?.hash ?? planDigest(plan)
      if (standing === undefined) plans.push({ file, hash, standing: 'draft' })
      else if (standing.state !== 'approved') plans.push({ file, hash, standing: standing.state })
      else {
        const closed = await readPlanClosedHash(root, planSlug(path))
        const state = 'unreadable' in closed ? 'unreadable' : closed.hash === hash ? 'closed' : 'open'
        plans.push({ file, hash, standing: state })
        if (state === 'open') open.push({ file, plan })
      }
    } catch {
      plans.push({ file, hash: '', standing: 'unreadable' })
    }
  }
  return { listed: plans, open }
}
