/**
 * Change facts and the lane floor (RFC 0040 §3), the half read from the two revisions alone:
 * paths, migrations, the schema, acceptance tests, policies and manifests, and the audit of both
 * sides when the caller supplies it. What was not read is in `unjudged`, never an absent fact.
 */
import { posix } from 'node:path'

import type { File } from '@babel/types'

import { formatDestructiveFinding, judgeMigrations, readMigrationSources } from '@guren/orm/internal/migration-guard'

import { parseSourceFile } from '../parse-cache'
import { bracketedTokens, isAcceptanceId } from '../plan/acceptance-status'
import { topLevelDeclaration } from '../ast-walk'
import { TEST_FILE_PATTERN, toPosixRelative } from '../discovery'
import { extractClassDeclaration } from '../model-parser'
import { isPlanRevisionsDirName, planSlug } from '../plan/beside'
import { readPolicyAbilities } from '../plan/policy-abilities'
import { discoverPlanFiles, isPlanFileName, isPlanInput } from '../plan-check'
import { parseSchemaSource, type SchemaTable } from '../schema-parser'
import { auditCoverageGaps, auditFacts } from './audit-facts'
import type { ChangedPath, ChangeReader, ChangeSide, ResolvedChange } from './resolve'
import type { ChangeAudits } from './revision-audit'

export type Lane = 'low' | 'medium' | 'high'

export interface ChangeFact {
  code: string
  /** The floor this fact sets. */
  lane: Lane
  /** A table, a migration, a plan section: what the fact is about, when it is narrower than its files. */
  target?: string
  files: string[]
  evidence: 'registered' | 'static' | 'path'
  /** The plan element whose declaration matched. Never set until the declaration matcher ships. */
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
  /** Whether both sides were audited and compared; the run then loaded the code of both commits. */
  audited: boolean
  plans: ChangePlan[]
}

const LANES: readonly Lane[] = ['low', 'medium', 'high']

export function highestLane(lanes: Iterable<Lane>): Lane {
  let highest = 0
  for (const lane of lanes) highest = Math.max(highest, LANES.indexOf(lane))
  return LANES[highest]!
}

// `bunfig.toml` is not in the RFC's list: it names the preload and root `bun test` runs under.
const GATE_FILES = new Set([
  '.oxlintrc.json', 'tsconfig.json', 'bunfig.toml', 'guren.arch.ts', 'guren.review.ts', 'playwright.browser.config.ts', 'e2e.browser.config.ts',
  '.claude/settings.json', '.claude/settings.local.json', '.codex/hooks.json', '.cursor/hooks.json',
])
const GATE_PREFIXES = ['scripts/', 'bin/', '.github/', '.claude/hooks/', '.codex/hooks/', '.codex/rules/', '.cursor/hooks/']
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
  if (differences.length === 0) differences.push('a part the reader does not follow changed')
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
}

/**
 * Judges a resolved change from its two revisions. Every changed path ends in at least one fact,
 * and the floor is the highest lane among the facts and the readers that could not read.
 */
export async function judgeChangeLane(change: ResolvedChange, reader: ChangeReader, options: JudgeChangeLaneOptions = {}): Promise<ChangeLaneReport> {
  const facts: ChangeFact[] = []
  const unjudged: ChangeUnjudged[] = []
  const claimed = new Set<ChangedPath>()
  const fact = (entries: readonly ChangedPath[], value: Omit<ChangeFact, 'files'>): void => {
    facts.push({ ...value, files: entries.map((entry) => entry.path) })
    for (const entry of entries) claimed.add(entry)
  }
  const read = (side: ChangeSide, path: string | undefined): Promise<string | null> => (path === undefined ? Promise.resolve(null) : reader.read(side, path))
  const inApp = change.paths.filter((entry) => !entry.outsideApp)
  const touches = (entry: ChangedPath, test: (path: string) => boolean): boolean => Object.values(sides(entry)).some(test)

  const isGatePath = (path: string): boolean => GATE_FILES.has(path) || GATE_PREFIXES.some((prefix) => path.startsWith(prefix))
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

  const fallbackCode = (entry: ChangedPath): string => (entry.outsideApp ? 'outside-app' : entry.status === 'added' ? 'file-added' : entry.status === 'deleted' ? 'source-removed' : entry.status === 'renamed' ? 'source-renamed' : 'source-edited')
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
    for (const name of names) {
      const destructive = findings.filter((finding) => finding.migration === name)
      if (destructive.length > 0) {
        const marker = judged.acknowledged.some((entry) => entry.migration === name) ? ' (acknowledged by its marker, which a person reads)' : ''
        fact(entriesOf(name), { code: 'migration-destructive', lane: 'high', target: `${folder}/${name}`, evidence: 'static', message: `${destructive.map(formatDestructiveFinding).join('; ')}${marker}` })
      } else {
        fact(entriesOf(name), { code: 'migration', lane: 'medium', target: `${folder}/${name}`, evidence: 'static', message: `${folder}/${name}: added, nothing destructive` })
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
      if (!previous) fact([entry], { code: 'schema-changed', lane: 'medium', target: describeTable(table), evidence: 'static', message: `table ${describeTable(table)} added (${table.columns.length} columns)` })
      else if (JSON.stringify(previous) !== JSON.stringify(table)) fact([entry], { code: 'schema-changed', lane: 'medium', target: describeTable(table), evidence: 'static', message: `table ${describeTable(table)}: ${tableDifferences(previous, table).join('; ')}` })
    }
    for (const [identifier, table] of beforeTables) {
      if (!afterTables.has(identifier)) fact([entry], { code: 'schema-changed', lane: 'medium', target: describeTable(table), evidence: 'static', message: `table ${describeTable(table)} removed` })
    }
    if (!claimed.has(entry)) fact([entry], { code: 'source-edited', lane: 'medium', evidence: 'static', message: `${entry.path}: no table the reader sees changed` })
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
      if (repeated.length > 0) fact([entry], { code: 'file-added', lane: 'medium', evidence: 'static', message: `${entry.path}: a test added under ${list(repeated)}, which an existing test carries` })
      else fact([entry], { code: 'test-added', lane: 'low', evidence: 'static', message: `${entry.path}: a test added, carrying no existing acceptance id` })
    }
  }

  for (const entry of inApp) {
    if (claimed.has(entry) || !touches(entry, isPolicyFile)) continue
    const { base, head } = sides(entry)
    if (base === undefined || !isPolicyFile(base)) {
      fact([entry], { code: 'policy-added', lane: 'medium', evidence: 'path', message: `${entry.path} ${entry.status}` })
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
    fact([entry], { code: fallbackCode(entry), lane: 'medium', evidence: 'path', message: `${entry.path} ${entry.status}${entry.oldPath ? ` from ${entry.oldPath}` : ''}` })
  }

  const surface = inApp.filter((entry) => touches(entry, (path) => SECURITY_SURFACE.test(path)))
  if (surface.length > 0) {
    unjudged.push({ reader: 'security-records', reason: 'per-route security records are not computed by this version, so authorization-removed and validation-removed were not judged', lane: 'medium', files: surface.map((entry) => entry.path) })
  }
  // The audit scans every source directory but a `.test.` file, loads what the routes import and reads the install.
  const audited = change.paths.filter((entry) => entry.outsideApp || touches(entry, (path) => !isAmbient(path) && !TESTS_DIR.test(path)))
  let compared = false
  if (audited.length > 0) {
    const notJudged = (why: string): void => {
      unjudged.push({ reader: 'audit', reason: `${why}, so audit-fail, audit-warn-changed, csrf-exemption and sensitive-exposure were not judged`, lane: 'medium', files: audited.map((entry) => entry.path) })
    }
    const audits = await options.audit?.()
    if (!audits) notJudged('the audit was not run on the two sides')
    else if ('unavailable' in audits) notJudged(audits.unavailable)
    else {
      compared = true
      facts.push(...(await auditFacts(change, reader, audits.base, audits.head)))
      const gaps = auditCoverageGaps(audits.base, audits.head)
      if (gaps.length > 0) unjudged.push({ reader: 'audit-coverage', reason: `the audit read less at the head than at the base: ${gaps.join('; ')}`, lane: 'medium' })
    }
  }
  const dependencies = facts.filter((entry) => entry.code === 'dependencies-changed').flatMap((entry) => entry.files)
  if (dependencies.length > 0) {
    unjudged.push({ reader: 'dependency-advisory', reason: 'the advisories of the changed dependencies were not compared with the base by this version', lane: 'medium', files: [...new Set(dependencies)] })
  }

  return {
    schemaVersion: 1,
    base: change.base,
    mergeBase: change.mergeBase,
    head: change.head,
    floor: highestLane([...facts.map((entry) => entry.lane), ...unjudged.map((entry) => entry.lane)]),
    facts,
    unjudged,
    audited: compared,
    plans: await readChangePlans(reader, trees.head),
  }
}

/** The plans at the head with the standing each has there, read from the head's own records. */
async function readChangePlans(reader: ChangeReader, head: ReadonlySet<string>): Promise<ChangePlan[]> {
  const inputs = [...head].filter(isPlanInput)
  if (!inputs.some((path) => isPlanFileName(posix.basename(path)))) return []
  const root = await reader.materialize('head', inputs)
  const [{ readPlanFile }, { readPlanApprovalStanding }, { readPlanClosedHash }, { planDigest }] = await Promise.all([
    import('../plan-render'), import('../plan/approvals'), import('../plan/open-plan'), import('../plan/identity'),
  ])
  const plans: ChangePlan[] = []
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
        plans.push({ file, hash, standing: 'unreadable' in closed ? 'unreadable' : closed.hash === hash ? 'closed' : 'open' })
      }
    } catch {
      plans.push({ file, hash: '', standing: 'unreadable' })
    }
  }
  return plans
}
