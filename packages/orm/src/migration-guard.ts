import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * The destructive-migration guard (RFC 0034): what a migration does that can
 * lose data or break the deploy still running, and whether its file
 * acknowledges that with `-- guren:allow-destructive`. Pure up to
 * `readMigrationSources()`, which is the only part that touches the disk.
 */

export type DestructiveKind =
  | 'drop-table'
  | 'drop-column'
  | 'alter-column-type'
  | 'table-rebuild'
  | 'rename'
  | 'truncate'
  | 'delete-all'
  | 'drop-schema'
  | 'unreadable'

export interface DestructiveStatement {
  kind: DestructiveKind
  /** 1-based line of the statement's first token in `migration.sql`. */
  line: number
  /** Normalized as written, schema-qualified when the SQL qualifies it. */
  table?: string
  column?: string
  /** One line describing what the statement does. */
  message: string
  /** A rebuild's `INSERT INTO __new_x(cols) SELECT cols FROM x`, when it copies each column to itself. */
  copiedColumns?: string[]
}

export interface MigrationAcknowledgement {
  line: number
  /** The text after `guren:allow-destructive:`, absent when none was given. */
  reason?: string
}

export interface MigrationScan {
  statements: DestructiveStatement[]
  acknowledged: MigrationAcknowledgement | null
  /** Tables a `CREATE TABLE` creates, with the line of each, in file order. */
  creates: Array<{ table: string; line: number }>
}

export const ALLOW_DESTRUCTIVE_MARKER = 'guren:allow-destructive'

/** One-run override of `destructiveMigrations: 'refuse'`, which `guren db:migrate --allow-destructive` sets. */
export const ALLOW_DESTRUCTIVE_ENV = 'GUREN_ALLOW_DESTRUCTIVE_MIGRATIONS'

type TokenKind = 'word' | 'ident' | 'string' | 'punct' | 'body'

interface Token {
  kind: TokenKind
  /** Words upper-cased; identifiers unquoted as written; a body's inner text. */
  value: string
  line: number
}

interface Lexed {
  tokens: Token[]
  comments: Array<{ text: string; line: number }>
  /** Where an unterminated string, identifier, comment or body opened. */
  unterminatedAt?: number
}

function lex(sql: string, firstLine = 1): Lexed {
  const tokens: Token[] = []
  const comments: Lexed['comments'] = []
  let line = firstLine
  let i = 0

  const advanceTo = (end: number): string => {
    const text = sql.slice(i, end)
    for (const char of text) if (char === '\n') line += 1
    i = end
    return text
  }

  while (i < sql.length) {
    const char = sql[i]!
    const startLine = line

    if (char === '\n' || char === ' ' || char === '\t' || char === '\r') {
      advanceTo(i + 1)
      continue
    }

    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      const text = advanceTo(end === -1 ? sql.length : end)
      comments.push({ text: text.slice(2), line: startLine })
      continue
    }

    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) return { tokens, comments, unterminatedAt: startLine }
      const text = advanceTo(end + 2)
      comments.push({ text: text.slice(2, -2), line: startLine })
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      let end = i + 1
      for (;;) {
        end = sql.indexOf(char, end)
        if (end === -1) return { tokens, comments, unterminatedAt: startLine }
        // A doubled quote is an escaped one in all three dialects.
        if (sql[end + 1] === char) {
          end += 2
          continue
        }
        break
      }
      const text = advanceTo(end + 1)
      const inner = text.slice(1, -1).replaceAll(char + char, char)
      tokens.push({ kind: char === "'" ? 'string' : 'ident', value: inner, line: startLine })
      continue
    }

    if (char === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0]
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length)
        if (end === -1) return { tokens, comments, unterminatedAt: startLine }
        const bodyStart = i + tag.length
        const bodyLine = startLine
        const inner = sql.slice(bodyStart, end)
        advanceTo(end + tag.length)
        tokens.push({ kind: 'body', value: inner, line: bodyLine })
        continue
      }
    }

    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i))?.[0]
    if (word) {
      advanceTo(i + word.length)
      tokens.push({ kind: 'word', value: word.toUpperCase(), line: startLine })
      continue
    }

    advanceTo(i + 1)
    tokens.push({ kind: 'punct', value: char, line: startLine })
  }

  return { tokens, comments }
}

function splitStatements(tokens: Token[]): Token[][] {
  const statements: Token[][] = []
  let current: Token[] = []
  for (const token of tokens) {
    if (token.kind === 'punct' && token.value === ';') {
      if (current.length > 0) statements.push(current)
      current = []
    } else {
      current.push(token)
    }
  }
  if (current.length > 0) statements.push(current)
  return statements
}

/** Splits at top-level commas, the separator between `ALTER TABLE` actions. */
function splitTopLevel(tokens: Token[]): Token[][] {
  const parts: Token[][] = []
  let depth = 0
  let current: Token[] = []
  for (const token of tokens) {
    if (token.kind === 'punct' && token.value === '(') depth += 1
    if (token.kind === 'punct' && token.value === ')') depth -= 1
    if (depth === 0 && token.kind === 'punct' && token.value === ',') {
      parts.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  parts.push(current)
  return parts
}

const isWord = (token: Token | undefined, ...values: string[]): boolean =>
  token?.kind === 'word' && values.includes(token.value)

function nameValue(token: Token): string {
  return token.kind === 'word' ? token.value.toLowerCase() : token.value
}

/** Reads `name` or `schema.name` at `start`; undefined when no name is there. */
function readName(tokens: Token[], start: number): { name: string; next: number } | undefined {
  const first = tokens[start]
  if (!first || (first.kind !== 'word' && first.kind !== 'ident')) return undefined
  let name = nameValue(first)
  let next = start + 1
  while (tokens[next]?.kind === 'punct' && tokens[next]!.value === '.' && tokens[next + 1]) {
    const part = tokens[next + 1]!
    if (part.kind !== 'word' && part.kind !== 'ident') break
    name = `${name}.${nameValue(part)}`
    next += 2
  }
  return { name, next }
}

function skipWords(tokens: Token[], start: number, ...words: string[]): number {
  let index = start
  while (isWord(tokens[index], ...words)) index += 1
  return index
}

const NON_COLUMN_DROPS = ['CONSTRAINT', 'INDEX', 'KEY', 'PRIMARY', 'FOREIGN', 'CHECK', 'PARTITION', 'DEFAULT']

interface RawFinding extends DestructiveStatement {
  /** For a rebuild's closing rename, which the rebuild finding replaces. */
  renameFrom?: string
  renameTo?: string
}

function scanAlterTable(statement: Token[], line: number): RawFinding[] {
  const tableStart = skipWords(statement, 2, 'IF', 'EXISTS', 'ONLY')
  const table = readName(statement, tableStart)
  if (!table) return []
  const findings: RawFinding[] = []

  for (const action of splitTopLevel(statement.slice(table.next))) {
    const [head] = action
    if (!head) continue

    if (isWord(head, 'DROP') && !isWord(action[1], ...NON_COLUMN_DROPS)) {
      const columnAt = skipWords(action, 1, 'COLUMN', 'IF', 'EXISTS')
      const column = readName(action, columnAt)?.name
      findings.push({ kind: 'drop-column', line, table: table.name, column, message: `drops column ${table.name}.${column ?? '?'}` })
      continue
    }

    if (isWord(head, 'ALTER')) {
      const columnAt = skipWords(action, 1, 'COLUMN')
      const column = readName(action, columnAt)
      if (!column) continue
      const rest = action.slice(column.next)
      const typeAt = rest.findIndex((token) => isWord(token, 'TYPE'))
      if (typeAt !== -1 && (typeAt === 0 || isWord(rest[typeAt - 1], 'DATA'))) {
        findings.push({ kind: 'alter-column-type', line, table: table.name, column: column.name, message: `changes the type of ${table.name}.${column.name}` })
      }
      continue
    }

    if (isWord(head, 'MODIFY')) {
      const column = readName(action, skipWords(action, 1, 'COLUMN'))?.name
      findings.push({ kind: 'alter-column-type', line, table: table.name, column, message: `changes the type of ${table.name}.${column ?? '?'}` })
      continue
    }

    if (isWord(head, 'CHANGE')) {
      const from = readName(action, skipWords(action, 1, 'COLUMN'))
      const to = from && readName(action, from.next)
      if (from && to && from.name !== to.name) {
        findings.push({ kind: 'rename', line, table: table.name, column: from.name, message: `renames column ${table.name}.${from.name} to ${to.name}` })
      }
      findings.push({ kind: 'alter-column-type', line, table: table.name, column: to?.name ?? from?.name, message: `changes the type of ${table.name}.${from?.name ?? '?'}` })
      continue
    }

    if (isWord(head, 'RENAME')) {
      if (isWord(action[1], 'INDEX', 'KEY', 'CONSTRAINT')) continue
      if (isWord(action[1], 'TO', 'AS')) {
        const to = readName(action, 2)?.name
        findings.push({ kind: 'rename', line, table: table.name, message: `renames table ${table.name} to ${to ?? '?'}`, renameFrom: table.name, renameTo: to })
        continue
      }
      const from = readName(action, skipWords(action, 1, 'COLUMN'))
      const to = from && isWord(action[from.next], 'TO') ? readName(action, from.next + 1)?.name : undefined
      findings.push({ kind: 'rename', line, table: table.name, column: from?.name, message: `renames column ${table.name}.${from?.name ?? '?'} to ${to ?? '?'}` })
    }
  }

  return findings
}

const STATEMENT_KEYWORDS = ['DROP', 'ALTER', 'RENAME', 'TRUNCATE', 'DELETE', 'CREATE']

function scanStatement(tokens: Token[]): { findings: RawFinding[]; creates?: string } {
  // From the first DDL/DML keyword, so a `BEGIN`, `IF … THEN` or `WITH …` in front hides nothing.
  const start = tokens.findIndex((token) => isWord(token, ...STATEMENT_KEYWORDS))
  if (start === -1) return { findings: [] }
  const statement = tokens.slice(start)
  const [first, second] = statement
  const line = first!.line

  if (isWord(first, 'DROP') && isWord(second, 'TABLE')) {
    const findings: RawFinding[] = []
    for (const part of splitTopLevel(statement.slice(skipWords(statement, 2, 'IF', 'EXISTS')))) {
      const table = readName(part, 0)?.name
      if (table) findings.push({ kind: 'drop-table', line, table, message: `drops table ${table}` })
    }
    return { findings }
  }

  if (isWord(first, 'DROP') && isWord(second, 'SCHEMA', 'DATABASE')) {
    const name = readName(statement, skipWords(statement, 2, 'IF', 'EXISTS'))?.name
    return { findings: [{ kind: 'drop-schema', line, message: `drops ${second!.value.toLowerCase()} ${name ?? '?'}` }] }
  }

  if (isWord(first, 'ALTER') && isWord(second, 'TABLE')) {
    return { findings: scanAlterTable(statement, line) }
  }

  if (isWord(first, 'RENAME') && isWord(second, 'TABLE')) {
    return {
      findings: splitTopLevel(statement.slice(2)).flatMap((part): RawFinding[] => {
        const from = readName(part, 0)
        if (!from) return []
        const to = isWord(part[from.next], 'TO') ? readName(part, from.next + 1)?.name : undefined
        return [{ kind: 'rename', line, table: from.name, message: `renames table ${from.name} to ${to ?? '?'}`, renameFrom: from.name, renameTo: to }]
      }),
    }
  }

  if (isWord(first, 'TRUNCATE')) {
    const table = readName(statement, skipWords(statement, 1, 'TABLE', 'ONLY'))?.name
    return { findings: [{ kind: 'truncate', line, table, message: `empties table ${table ?? '?'}` }] }
  }

  if (isWord(first, 'DELETE') && isWord(second, 'FROM')) {
    const table = readName(statement, skipWords(statement, 2, 'ONLY'))?.name
    const filtered = statement.some((token) => isWord(token, 'WHERE'))
    return filtered ? { findings: [] } : { findings: [{ kind: 'delete-all', line, table, message: `deletes every row of ${table ?? '?'}` }] }
  }

  if (isWord(first, 'CREATE')) {
    const tableAt = skipWords(statement, 1, 'TEMP', 'TEMPORARY', 'UNLOGGED', 'VIRTUAL')
    if (isWord(statement[tableAt], 'TABLE')) {
      // `IF NOT EXISTS` counts: drizzle-kit 0.x wrote every create that way, and it can only no-op over
      // a table the tracker never recorded creating (one made by push or by hand).
      const table = readName(statement, skipWords(statement, tableAt + 1, 'IF', 'NOT', 'EXISTS'))?.name
      return { findings: [], creates: table }
    }
  }

  return { findings: [] }
}

const REBUILD_PREFIX = '__new_'

function unqualified(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1)
}

/** `INSERT INTO a(c1, c2) SELECT c1, c2 FROM b` and nothing else, column for column; undefined otherwise. */
function readCopy(statement: Token[]): { into: string; from: string; columns: string[] } | undefined {
  if (!isWord(statement[0], 'INSERT') || !isWord(statement[1], 'INTO')) return undefined
  const into = readName(statement, 2)
  if (!into || statement[into.next]?.value !== '(') return undefined
  const names = (start: number, end: (token: Token | undefined) => boolean): { columns: string[]; next: number } | undefined => {
    const columns: string[] = []
    let index = start
    for (;;) {
      const name = readName(statement, index)
      if (!name || name.name.includes('.')) return undefined
      columns.push(name.name)
      index = name.next
      if (statement[index]?.value === ',') {
        index += 1
        continue
      }
      return end(statement[index]) ? { columns, next: index + 1 } : undefined
    }
  }
  const inserted = names(into.next + 1, (token) => token?.value === ')')
  if (!inserted || !isWord(statement[inserted.next], 'SELECT')) return undefined
  const selected = names(inserted.next + 1, (token) => isWord(token, 'FROM'))
  if (!selected) return undefined
  const from = readName(statement, selected.next)
  if (!from || from.next !== statement.length) return undefined
  if (inserted.columns.join() !== selected.columns.join()) return undefined
  return { into: into.name, from: from.name, columns: inserted.columns }
}

function scanTokens(lexed: Lexed): Omit<MigrationScan, 'acknowledged'> {
  const raw: RawFinding[] = []
  const creates: MigrationScan['creates'] = []
  const copies: Array<{ into: string; from: string; columns: string[] }> = []

  for (const statement of splitStatements(lexed.tokens)) {
    const result = scanStatement(statement)
    raw.push(...result.findings)
    const copy = readCopy(statement)
    if (copy) copies.push(copy)
    if (result.creates) creates.push({ table: result.creates, line: statement[0]!.line })
    // A dollar-quoted body (a `DO` block, a function) can run the same DDL.
    for (const token of statement) {
      if (token.kind !== 'body') continue
      const nested = scanTokens(lex(token.value, token.line))
      raw.push(...nested.statements)
    }
  }

  if (lexed.unterminatedAt !== undefined) {
    raw.push({ kind: 'unreadable', line: lexed.unterminatedAt, message: 'opens a string, identifier, comment or $$ body that never closes, so nothing after it can be read' })
  }

  // drizzle-kit's SQLite rebuild: create __new_x, copy, drop x, rename __new_x to x.
  const rebuilt = new Set(
    raw
      .filter((finding) => finding.kind === 'rename' && finding.renameFrom && finding.renameTo)
      .filter((finding) => unqualified(finding.renameFrom!) === `${REBUILD_PREFIX}${unqualified(finding.renameTo!)}`)
      .map((finding) => finding.renameTo!),
  )
  const statements: DestructiveStatement[] = []
  for (const { renameFrom, renameTo, ...finding } of raw) {
    if (renameTo && rebuilt.has(renameTo) && renameFrom && unqualified(renameFrom).startsWith(REBUILD_PREFIX)) continue
    if (finding.kind === 'drop-table' && finding.table && rebuilt.has(finding.table)) {
      const table = finding.table
      const copy = copies.find((entry) => entry.from === table && unqualified(entry.into) === `${REBUILD_PREFIX}${unqualified(table)}`)
      statements.push({
        ...finding,
        ...(copy ? { copiedColumns: copy.columns } : {}),
        kind: 'table-rebuild',
        message: `rebuilds table ${finding.table} (copies rows into ${REBUILD_PREFIX}${unqualified(finding.table)}, drops ${finding.table}, renames the copy)`,
      })
      continue
    }
    statements.push(finding)
  }

  return { statements: statements.sort((a, b) => a.line - b.line), creates }
}

function readAcknowledgement(comments: Lexed['comments']): MigrationAcknowledgement | null {
  for (const comment of comments) {
    const text = comment.text.trim()
    if (!text.startsWith(ALLOW_DESTRUCTIVE_MARKER)) continue
    const rest = text.slice(ALLOW_DESTRUCTIVE_MARKER.length)
    if (rest !== '' && !/^[\s:]/.test(rest)) continue
    const reason = rest.replace(/^\s*:?\s*/, '').trim()
    return { line: comment.line, reason: reason === '' ? undefined : reason }
  }
  return null
}

/** Every destructive statement in one migration file, and its acknowledgement. */
export function scanMigrationSql(sql: string): MigrationScan {
  const lexed = lex(sql)
  return { ...scanTokens(lexed), acknowledged: readAcknowledgement(lexed.comments) }
}

/** `table.column` → type, from a drizzle-kit 1.x `snapshot.json`; an ambiguous key is left out. */
export type ColumnTypes = ReadonlyMap<string, string>

export function readSnapshotColumnTypes(snapshot: unknown): ColumnTypes | undefined {
  const ddl = (snapshot as { ddl?: unknown } | null)?.ddl
  if (!Array.isArray(ddl)) return undefined
  const types = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const entry of ddl as Array<Record<string, unknown>>) {
    if (entry?.entityType !== 'columns') continue
    const { table, name, type } = entry
    if (typeof table !== 'string' || typeof name !== 'string' || typeof type !== 'string') continue
    const key = `${table}.${name}`.toLowerCase()
    if (types.has(key) && types.get(key) !== type) ambiguous.add(key)
    types.set(key, type)
  }
  for (const key of ambiguous) types.delete(key)
  return types
}

interface ParsedType {
  base: string
  args: number[]
  unsigned: boolean
}

function parseType(type: string): ParsedType | undefined {
  let rest = type.trim().toLowerCase().replace(/\s+/g, ' ')
  const unsigned = rest.endsWith(' unsigned')
  if (unsigned) rest = rest.slice(0, -' unsigned'.length)
  let args: number[] = []
  const open = rest.indexOf('(')
  if (open !== -1) {
    if (!rest.endsWith(')')) return undefined
    const inner = rest.slice(open + 1, -1)
    if (!/^[\d ,]*$/.test(inner)) return undefined
    args = inner === '' ? [] : inner.split(',').map((arg) => Number(arg.trim()))
    rest = rest.slice(0, open)
  }
  const base = rest.trim()
  if (!/^[a-z][a-z0-9 ]*$/.test(base) || args.some((arg) => !Number.isInteger(arg))) return undefined
  return { base, args, unsigned }
}

const INTEGER_RANK: Record<string, number> = {
  tinyint: 0,
  smallint: 1,
  int2: 1,
  mediumint: 2,
  integer: 3,
  int: 3,
  int4: 3,
  bigint: 4,
  int8: 4,
}
const VARYING = new Set(['varchar', 'character varying'])
const FIXED = new Set(['char', 'character'])
const TEXT_RANK: Record<string, number> = { tinytext: 0, text: 1, mediumtext: 2, longtext: 3 }
const NUMERIC = new Set(['numeric', 'decimal'])

/**
 * Whether `after` holds every value `before` holds: a closed list, so a pair
 * it does not name is not widening. Equal types (a MySQL `MODIFY` that only
 * changes nullability) count, since no value changes.
 */
export function isWideningTypeChange(before: string, after: string): boolean {
  const from = parseType(before)
  const to = parseType(after)
  if (!from || !to) return false
  if (from.base === to.base && from.unsigned === to.unsigned && from.args.join() === to.args.join()) return true
  if (from.unsigned !== to.unsigned) return false

  if (from.base in INTEGER_RANK && to.base in INTEGER_RANK && from.args.length === 0) {
    return INTEGER_RANK[to.base]! >= INTEGER_RANK[from.base]!
  }

  const fromText = VARYING.has(from.base) || FIXED.has(from.base)
  if (fromText && (to.base in TEXT_RANK)) return true
  if (fromText && VARYING.has(to.base)) {
    if (to.args.length === 0) return true
    return from.args.length === 1 && to.args[0]! >= from.args[0]!
  }
  if (from.base in TEXT_RANK && to.base in TEXT_RANK) return TEXT_RANK[to.base]! >= TEXT_RANK[from.base]!

  if (NUMERIC.has(from.base) && NUMERIC.has(to.base)) {
    if (to.args.length === 0) return true
    if (from.args.length === 0) return false
    const [fromPrecision, fromScale = 0] = from.args
    const [toPrecision, toScale = 0] = to.args
    return toScale >= fromScale && toPrecision! - toScale >= fromPrecision! - fromScale
  }

  if ((from.base === 'real' || from.base === 'float4') && (to.base === 'double precision' || to.base === 'float8')) return true

  return false
}

/**
 * A rebuild loses nothing when the previous snapshot names the table's columns,
 * the copy carries every one of them to itself, and each keeps or widens its
 * type in this migration's snapshot. drizzle-kit rebuilds a SQLite table for an
 * added default or foreign key, so without this every such edit would need sign-off.
 */
function isLosslessRebuild(statement: DestructiveStatement, columnTypes: MigrationSource['columnTypes']): boolean {
  const { before, after } = columnTypes ?? {}
  if (!statement.table || !statement.copiedColumns || !before || !after) return false
  const prefix = `${unqualified(statement.table)}.`.toLowerCase()
  const previous = [...before].filter(([key]) => key.startsWith(prefix))
  if (previous.length === 0) return false
  const copied = new Set(statement.copiedColumns.map((column) => column.toLowerCase()))
  return previous.every(([key, type]) => {
    const next = after.get(key)
    return copied.has(key.slice(prefix.length)) && next !== undefined && isWideningTypeChange(type, next)
  })
}

export interface MigrationSource {
  /** The migration folder's name, as the tracker records it. */
  name: string
  /** How a finding names the file: `db/migrations/<name>/migration.sql`. */
  file: string
  scan: MigrationScan
  /** Column types after this migration, and before it, when its snapshots read. */
  columnTypes?: { before?: ColumnTypes; after?: ColumnTypes }
}

export interface DestructiveFinding extends DestructiveStatement {
  migration: string
  file: string
}

export interface MigrationGuardReport {
  /** Findings in migrations that carry no marker; the ones a guard refuses on. */
  unacknowledged: DestructiveFinding[]
  /** Migrations whose findings the marker covers, with its reason. */
  acknowledged: Array<{ migration: string; file: string; reason?: string; findings: DestructiveFinding[] }>
}

export interface JudgeOptions {
  /**
   * Exempt a finding against a table an earlier statement of the run creates.
   * Sound only when `sources` are exactly the pending migrations: over a
   * superset (pending unknown), an applied `CREATE` would exempt a new `DROP`.
   */
  exemptCreatedInRun?: boolean
}

/**
 * Judges migrations in the order they would be applied. A finding against a
 * table an earlier statement of the run creates is dropped (a fresh database
 * loses nothing), and so is a type change the snapshots show widening.
 */
export function judgeMigrations(sources: readonly MigrationSource[], { exemptCreatedInRun = true }: JudgeOptions = {}): MigrationGuardReport {
  const created = new Map<string, { migration: number; line: number }>()
  const report: MigrationGuardReport = { unacknowledged: [], acknowledged: [] }

  sources.forEach((source, index) => {
    const createdEarlier = (table: string | undefined, line: number): boolean => {
      if (!exemptCreatedInRun) return false
      const at = table === undefined ? undefined : created.get(table)
      return at !== undefined && (at.migration < index || at.line < line)
    }
    for (const { table, line } of source.scan.creates) {
      if (!created.has(table)) created.set(table, { migration: index, line })
    }

    const findings = source.scan.statements
      .filter((statement) => statement.kind === 'unreadable' || statement.kind === 'drop-schema' || !createdEarlier(statement.table, statement.line))
      .filter((statement) => statement.kind !== 'table-rebuild' || !isLosslessRebuild(statement, source.columnTypes))
      .filter((statement) => {
        if (statement.kind !== 'alter-column-type' || !statement.table || !statement.column) return true
        const key = `${unqualified(statement.table)}.${statement.column}`.toLowerCase()
        const before = source.columnTypes?.before?.get(key)
        const after = source.columnTypes?.after?.get(key)
        return before === undefined || after === undefined || !isWideningTypeChange(before, after)
      })
      .map((statement): DestructiveFinding => ({ ...statement, migration: source.name, file: source.file }))

    if (findings.length === 0) return
    if (source.scan.acknowledged) {
      report.acknowledged.push({ migration: source.name, file: source.file, reason: source.scan.acknowledged.reason, findings })
    } else {
      report.unacknowledged.push(...findings)
    }
  })

  return report
}

function readSnapshot(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Reads `<folder>/<name>/migration.sql` for each name, plus the snapshots a
 * type change needs. Throws when a migration file cannot be read: a guard that
 * skipped it would pass exactly the file it could not judge.
 */
export function readMigrationSources(
  migrationsFolder: string,
  names: readonly string[],
  displayFolder = migrationsFolder,
): MigrationSource[] {
  let snapshotsById: Map<string, unknown> | undefined
  const snapshotById = (id: unknown): unknown => {
    if (typeof id !== 'string') return undefined
    if (!snapshotsById) {
      snapshotsById = new Map()
      for (const entry of existsSync(migrationsFolder) ? readdirSync(migrationsFolder, { withFileTypes: true }) : []) {
        if (!entry.isDirectory()) continue
        const snapshot = readSnapshot(resolve(migrationsFolder, entry.name, 'snapshot.json'))
        const snapshotId = (snapshot as { id?: unknown } | undefined)?.id
        if (typeof snapshotId === 'string') snapshotsById.set(snapshotId, snapshot)
      }
    }
    return snapshotsById.get(id)
  }

  return names.map((name) => {
    const path = resolve(migrationsFolder, name, 'migration.sql')
    let sql: string
    try {
      sql = readFileSync(path, 'utf8')
    } catch (error) {
      throw new Error(`Cannot read ${path} to check it for destructive statements: ${(error as Error).message}`)
    }
    const scan = scanMigrationSql(sql)
    const source: MigrationSource = { name, file: `${displayFolder.replace(/\/$/, '')}/${name}/migration.sql`, scan }
    if (scan.statements.some((statement) => statement.kind === 'alter-column-type' || statement.kind === 'table-rebuild')) {
      const snapshot = readSnapshot(resolve(migrationsFolder, name, 'snapshot.json'))
      const previousIds = (snapshot as { prevIds?: unknown } | undefined)?.prevIds
      const previous = Array.isArray(previousIds) && previousIds.length === 1 ? snapshotById(previousIds[0]) : undefined
      source.columnTypes = { after: readSnapshotColumnTypes(snapshot), before: readSnapshotColumnTypes(previous) }
    }
    return source
  })
}

/** One finding as `file:line: message`, the form every guard prints. */
export function formatDestructiveFinding(finding: DestructiveFinding): string {
  return `${finding.file}:${finding.line}: ${finding.message} (${finding.kind})`
}

/** What a factory does with a pending destructive statement no marker covers (RFC 0034). */
export type DestructiveMigrationMode = 'warn' | 'refuse'

export class DestructiveMigrationError extends Error {
  constructor(readonly findings: DestructiveFinding[], pendingKnown = true) {
    super(
      `Refusing to apply ${findings.length} destructive statement(s) that no migration acknowledges:\n` +
        (pendingKnown ? '' : `  (the migration tracker could not be read, so every local migration was judged, applied ones included)\n`) +
        findings.map((finding) => `  ${formatDestructiveFinding(finding)}`).join('\n') +
        `\nReview each one. To apply it, put \`-- ${ALLOW_DESTRUCTIVE_MARKER}: <reason>\` on the first line of its migration.sql, ` +
        `or set ${ALLOW_DESTRUCTIVE_ENV}=1 for one run.`,
    )
    this.name = 'DestructiveMigrationError'
  }
}

function displayFolder(folder: string): string {
  const relativePath = relative(process.cwd(), folder)
  return relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath) ? folder : relativePath.split(sep).join('/')
}

/**
 * The boot-path guard: judges the pending migrations before the migrator runs.
 * `refuse` throws unless `GUREN_ALLOW_DESTRUCTIVE_MIGRATIONS=1`; `warn`, and an
 * allowed `refuse`, print the findings and return.
 */
export function guardPendingMigrations(
  migrationsFolder: string,
  pending: readonly string[],
  mode: DestructiveMigrationMode,
  { pendingKnown = true }: { pendingKnown?: boolean } = {},
): void {
  if (pending.length === 0) return
  const sources = readMigrationSources(migrationsFolder, pending, displayFolder(migrationsFolder))
  const { unacknowledged } = judgeMigrations(sources, { exemptCreatedInRun: pendingKnown })
  if (unacknowledged.length === 0) return

  const allowed = process.env[ALLOW_DESTRUCTIVE_ENV] === '1'
  if (mode === 'refuse' && !allowed) throw new DestructiveMigrationError(unacknowledged, pendingKnown)

  const why = allowed
    ? `${ALLOW_DESTRUCTIVE_ENV}=1 is set`
    : "pass `destructiveMigrations: 'refuse'` to the database factory to stop at these instead"
  console.warn(
    `[guren/orm] Applying ${unacknowledged.length} destructive statement(s) that no migration acknowledges (${why}):\n` +
      unacknowledged.map((finding) => `[guren/orm]   ${formatDestructiveFinding(finding)}`).join('\n'),
  )
}
