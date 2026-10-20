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
  | 'drop-partition'
  | 'drop-cascade'
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
  /** A rebuild's `INSERT INTO __new_x(cols) SELECT cols FROM x`, when it copies each column to itself and nothing else touches the copy. */
  copiedColumns?: string[]
  /** A type change's target type as the SQL spells it, when it converts by a plain cast to that type and nothing else. */
  targetType?: string
  /** A rebuild's copy, each column's type as its `CREATE TABLE __new_x` spells it: what runs, whatever the snapshot says. */
  copiedColumnTypes?: Record<string, string>
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
  /** Tables a `REFERENCES` in the SQL names with `ON DELETE CASCADE`, `SET NULL` or `SET DEFAULT`. */
  cascadeTargets: string[]
}

/** How a migration's SQL is lexed: strings, comments and quoting differ by dialect. */
export type MigrationDialect = 'postgres' | 'mysql' | 'sqlite'

export interface ScanOptions {
  /** Unknown: the SQL is read as each dialect would read it, and every reading's findings count. */
  dialect?: MigrationDialect
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
  /** Comment text MySQL executes: a versioned comment (slash-star-bang), and `--x`, which MySQL reads as SQL. */
  executable: Array<{ text: string; line: number }>
  /** Where an unterminated string, identifier, comment or body opened. */
  unterminatedAt?: number
}

interface LexRules {
  /** MySQL's default: a backslash escapes the next character in `'…'` and `"…"`. */
  backslashEscapes: boolean
  /** PostgreSQL's `E'…'`, the one string there a backslash escapes in. */
  escapeStrings: boolean
  /** MySQL's `#` line comment, and the comment text it executes. */
  mysqlComments: boolean
  /** PostgreSQL's `$tag$…$tag$`; elsewhere `$` is an identifier character or a parameter. */
  dollarQuotes: boolean
}

const LEX_RULES: Record<MigrationDialect, LexRules> = {
  postgres: { backslashEscapes: false, escapeStrings: true, mysqlComments: false, dollarQuotes: true },
  mysql: { backslashEscapes: true, escapeStrings: false, mysqlComments: true, dollarQuotes: false },
  sqlite: { backslashEscapes: false, escapeStrings: false, mysqlComments: false, dollarQuotes: false },
}

const DIALECTS = Object.keys(LEX_RULES) as MigrationDialect[]

function lex(sql: string, rules: LexRules, firstLine = 1): Lexed {
  const tokens: Token[] = []
  const comments: Lexed['comments'] = []
  const executable: Lexed['executable'] = []
  let line = firstLine
  let i = 0

  const advanceTo = (end: number): string => {
    const text = sql.slice(i, end)
    for (const char of text) if (char === '\n') line += 1
    i = end
    return text
  }

  /** The index of the quote closing the one at `open`, or -1. A doubled quote is an escaped one in every dialect. */
  const closingQuote = (open: number, quote: string, backslash: boolean): number => {
    for (let end = open + 1; end < sql.length; end += 1) {
      if (backslash && sql[end] === '\\') {
        end += 1
        continue
      }
      if (sql[end] !== quote) continue
      if (sql[end + 1] === quote) {
        end += 1
        continue
      }
      return end
    }
    return -1
  }

  while (i < sql.length) {
    const char = sql[i]!
    const startLine = line

    if (char === '\n' || char === ' ' || char === '\t' || char === '\r') {
      advanceTo(i + 1)
      continue
    }

    if ((char === '-' && sql[i + 1] === '-') || (char === '#' && rules.mysqlComments)) {
      const end = sql.indexOf('\n', i)
      const text = advanceTo(end === -1 ? sql.length : end)
      const body = text.slice(char === '#' ? 1 : 2)
      comments.push({ text: body, line: startLine })
      // MySQL starts a comment only at `-- ` followed by whitespace; `--1; DROP …` is SQL there.
      if (rules.mysqlComments && char === '-' && body !== '' && !/^\s/.test(body)) executable.push({ text: body, line: startLine })
      continue
    }

    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) return { tokens, comments, executable, unterminatedAt: startLine }
      const text = advanceTo(end + 2)
      const inner = text.slice(2, -2)
      comments.push({ text: inner, line: startLine })
      const versioned = rules.mysqlComments ? /^M?!\d*/.exec(inner)?.[0] : undefined
      if (versioned) executable.push({ text: inner.slice(versioned.length), line: startLine })
      continue
    }

    const escapeString = rules.escapeStrings && (char === 'E' || char === 'e') && sql[i + 1] === "'"
    if (char === "'" || char === '"' || char === '`' || escapeString) {
      const open = escapeString ? i + 1 : i
      const quote = sql[open]!
      const end = closingQuote(open, quote, escapeString || (rules.backslashEscapes && quote !== '`'))
      if (end === -1) return { tokens, comments, executable, unterminatedAt: startLine }
      const inner = sql.slice(open + 1, end).replaceAll(quote + quote, quote)
      advanceTo(end + 1)
      tokens.push({ kind: quote === "'" ? 'string' : 'ident', value: inner, line: startLine })
      continue
    }

    // SQLite (and SQL Server) quote identifiers in brackets too.
    if (char === '[') {
      const end = sql.indexOf(']', i + 1)
      if (end === -1) return { tokens, comments, executable, unterminatedAt: startLine }
      const text = advanceTo(end + 1)
      tokens.push({ kind: 'ident', value: text.slice(1, -1), line: startLine })
      continue
    }

    if (char === '$' && rules.dollarQuotes) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0]
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length)
        if (end === -1) return { tokens, comments, executable, unterminatedAt: startLine }
        const inner = sql.slice(i + tag.length, end)
        advanceTo(end + tag.length)
        tokens.push({ kind: 'body', value: inner, line: startLine })
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

  return { tokens, comments, executable }
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
  if (!first || first.kind === 'punct' || first.kind === 'body') return undefined
  let name = nameValue(first)
  let next = start + 1
  while (tokens[next]?.kind === 'punct' && tokens[next]!.value === '.' && tokens[next + 1]) {
    const part = tokens[next + 1]!
    if (part.kind === 'punct' || part.kind === 'body') break
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

const NON_COLUMN_DROPS = ['CONSTRAINT', 'INDEX', 'KEY', 'PRIMARY', 'FOREIGN', 'CHECK', 'DEFAULT', 'PARTITION']

interface RawFinding extends DestructiveStatement {
  /** For a rebuild's closing rename, which the rebuild finding replaces. */
  renameFrom?: string
  renameTo?: string
}

/** A type as the SQL spells it: words spaced, punctuation and digits joined, so `varchar ( 50 )` reads `varchar(50)`. */
function spellType(tokens: Token[]): string {
  let text = ''
  let previousWord = false
  for (const token of tokens) {
    const word = token.kind === 'word' || token.kind === 'ident'
    if (word && previousWord) text += ' '
    text += token.kind === 'word' ? token.value.toLowerCase() : token.value
    previousWord = word
  }
  return text
}

const MODIFY_TYPE_END = [
  'NOT', 'NULL', 'DEFAULT', 'COMMENT', 'AFTER', 'FIRST', 'COLLATE', 'CHARACTER', 'CHARSET', 'AUTO_INCREMENT',
  'ON', 'PRIMARY', 'UNIQUE', 'KEY', 'REFERENCES', 'CHECK', 'GENERATED', 'AS', 'VISIBLE', 'INVISIBLE', 'SRID', 'CONSTRAINT',
]

/**
 * The target type of a MySQL `MODIFY`/`CHANGE` definition, or undefined when it
 * also changes a character set or collation, which can lose characters whatever the type.
 */
function mysqlTargetType(definition: Token[]): string | undefined {
  if (definition.some((token) => isWord(token, 'CHARACTER', 'CHARSET', 'COLLATE'))) return undefined
  const end = definition.findIndex((token) => isWord(token, ...MODIFY_TYPE_END))
  const type = spellType(end === -1 ? definition : definition.slice(0, end))
  return type === '' ? undefined : type
}

/**
 * The target type of a PostgreSQL `[SET DATA] TYPE t [USING …]`, kept only when
 * the `USING` is absent or the plain cast drizzle-kit writes (`"col"::t`): any
 * other expression rewrites values, which no snapshot can vouch for.
 */
function postgresTargetType(afterType: Token[], column: string): string | undefined {
  const usingAt = afterType.findIndex((token) => isWord(token, 'USING'))
  if (afterType.some((token) => isWord(token, 'COLLATE'))) return undefined
  const type = spellType(usingAt === -1 ? afterType : afterType.slice(0, usingAt))
  if (type === '') return undefined
  if (usingAt === -1) return type
  const using = afterType.slice(usingAt + 1)
  const cast = readName(using, 0)
  if (!cast || cast.name !== column || using[cast.next]?.value !== ':' || using[cast.next + 1]?.value !== ':') return undefined
  return spellType(using.slice(cast.next + 2)) === type ? type : undefined
}

function scanAlterTable(statement: Token[], line: number): RawFinding[] {
  const tableStart = skipWords(statement, 2, 'IF', 'EXISTS', 'ONLY')
  const table = readName(statement, tableStart)
  if (!table) {
    return [{ kind: 'unreadable', line, message: 'alters a table whose name cannot be read, so what it does to it cannot be judged' }]
  }
  const findings: RawFinding[] = []

  for (const action of splitTopLevel(statement.slice(table.next))) {
    const [head] = action
    if (!head) continue

    // MySQL: a partition's rows go with it.
    if (isWord(head, 'DROP', 'TRUNCATE') && isWord(action[1], 'PARTITION')) {
      const partitions = splitTopLevel(action.slice(2)).map((part) => readName(part, 0)?.name ?? '?').join(', ')
      findings.push(isWord(head, 'DROP')
        ? { kind: 'drop-partition', line, table: table.name, message: `drops partition ${partitions} of ${table.name} with its rows` }
        : { kind: 'truncate', line, table: table.name, message: `empties partition ${partitions} of ${table.name}` })
      continue
    }

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
        const targetType = postgresTargetType(rest.slice(typeAt + 1), column.name)
        findings.push({
          kind: 'alter-column-type', line, table: table.name, column: column.name,
          message: `changes the type of ${table.name}.${column.name}`, ...(targetType ? { targetType } : {}),
        })
      }
      continue
    }

    if (isWord(head, 'MODIFY')) {
      const column = readName(action, skipWords(action, 1, 'COLUMN'))
      const targetType = column && mysqlTargetType(action.slice(column.next))
      findings.push({
        kind: 'alter-column-type', line, table: table.name, column: column?.name,
        message: `changes the type of ${table.name}.${column?.name ?? '?'}`, ...(targetType ? { targetType } : {}),
      })
      continue
    }

    if (isWord(head, 'CHANGE')) {
      const from = readName(action, skipWords(action, 1, 'COLUMN'))
      const to = from && readName(action, from.next)
      if (!from || !to || from.name !== to.name) {
        findings.push({ kind: 'rename', line, table: table.name, column: from?.name, message: `renames column ${table.name}.${from?.name ?? '?'} to ${to?.name ?? '?'}` })
      }
      const targetType = to && mysqlTargetType(action.slice(to.next))
      findings.push({
        kind: 'alter-column-type', line, table: table.name, column: to?.name ?? from?.name,
        message: `changes the type of ${table.name}.${from?.name ?? '?'}`, ...(targetType ? { targetType } : {}),
      })
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

/** Paren depth of each token, `(` and `)` counted at the depth outside them. */
function depths(tokens: Token[]): number[] {
  let depth = 0
  return tokens.map((token) => {
    if (token.kind === 'punct' && token.value === ')') depth -= 1
    const at = depth
    if (token.kind === 'punct' && token.value === '(') depth += 1
    return at
  })
}

/**
 * Every `DELETE … FROM` in a statement, a CTE's included, judged on the `WHERE`
 * at its own depth, so a subquery's filter is not its filter. A `DELETE` not
 * followed by `FROM` (directly, after MySQL's modifiers, or after MySQL's
 * multi-table target list) is a trigger event or a privilege, not a delete.
 */
function scanDeletes(tokens: Token[]): RawFinding[] {
  const depth = depths(tokens)
  const findings: RawFinding[] = []
  tokens.forEach((token, at) => {
    if (!isWord(token, 'DELETE')) return
    let index = skipWords(tokens, at + 1, 'LOW_PRIORITY', 'QUICK', 'IGNORE')
    let table: string | undefined
    if (isWord(tokens[index], 'FROM')) {
      table = readName(tokens, skipWords(tokens, index + 1, 'ONLY'))?.name
    } else {
      const targets: string[] = []
      for (;;) {
        const name = readName(tokens, index)
        if (!name) return
        targets.push(name.name)
        index = name.next
        if (tokens[index]?.value === ',') index += 1
        else break
      }
      if (!isWord(tokens[index], 'FROM')) return
      table = targets[0]
    }
    for (let next = at + 1; next < tokens.length && depth[next]! >= depth[at]!; next += 1) {
      if (depth[next] === depth[at] && isWord(tokens[next], 'WHERE')) return
    }
    findings.push({ kind: 'delete-all', line: token.line, table, message: `deletes every row of ${table ?? '?'}` })
  })
  return findings
}

const STATEMENT_KEYWORDS = ['DROP', 'ALTER', 'RENAME', 'TRUNCATE', 'CREATE']

/** What `DROP` names before the object, for the message; `DROP TABLE`/`SCHEMA`/`DATABASE` are read apart. */
const DROPPED_OBJECT_WORDS = ['MATERIALIZED', 'FOREIGN', 'TABLE', 'VIEW', 'TYPE', 'DOMAIN', 'EXTENSION', 'SEQUENCE', 'FUNCTION', 'PROCEDURE', 'COLUMN']

/** A column's type in `CREATE TABLE x (…)` as the SQL spells it, for each column it can read. */
function readColumnTypes(statement: Token[], open: number): Record<string, string> | undefined {
  if (statement[open]?.value !== '(') return undefined
  const depth = depths(statement)
  const close = statement.findIndex((token, at) => at > open && token.value === ')' && depth[at] === depth[open])
  if (close === -1) return undefined
  const types: Record<string, string> = {}
  for (const part of splitTopLevel(statement.slice(open + 1, close))) {
    if (part.length === 0 || isWord(part[0], 'CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK')) continue
    const column = readName(part, 0)
    if (!column) continue
    const rest = part.slice(column.next)
    const end = rest.findIndex((token) => isWord(token, ...MODIFY_TYPE_END))
    types[column.name] = spellType(end === -1 ? rest : rest.slice(0, end))
  }
  return types
}

interface StatementScan {
  findings: RawFinding[]
  creates?: string
  /** A `CREATE TABLE`'s column types, read for the rebuild copy. */
  columnTypes?: Record<string, string>
}

/** The statement read from its first DDL keyword, so a `BEGIN` or `IF … THEN` in front hides nothing. */
function scanDdl(tokens: Token[]): StatementScan {
  const start = tokens.findIndex((token) => isWord(token, ...STATEMENT_KEYWORDS))
  if (start === -1) return { findings: [] }
  const statement = tokens.slice(start)
  const [first, second] = statement
  const line = first!.line

  if (isWord(first, 'DROP') && isWord(second, 'TABLE')) {
    return {
      findings: splitTopLevel(statement.slice(skipWords(statement, 2, 'IF', 'EXISTS'))).map((part) => {
        const table = readName(part, 0)?.name
        return { kind: 'drop-table', line, table, message: `drops table ${table ?? '?'}` }
      }),
    }
  }

  if (isWord(first, 'DROP') && isWord(second, 'SCHEMA', 'DATABASE')) {
    const name = readName(statement, skipWords(statement, 2, 'IF', 'EXISTS'))?.name
    return { findings: [{ kind: 'drop-schema', line, message: `drops ${second!.value.toLowerCase()} ${name ?? '?'}` }] }
  }

  // PostgreSQL's DROP OWNED drops every object a role owns, its tables included.
  if (isWord(first, 'DROP') && isWord(second, 'OWNED')) {
    return { findings: [{ kind: 'drop-cascade', line, message: 'drops every object a role owns (DROP OWNED), tables included' }] }
  }

  // A type, domain or extension dropped with CASCADE takes every column of that type with it.
  if (isWord(first, 'DROP') && statement.some((token) => isWord(token, 'CASCADE'))) {
    const nameAt = skipWords(statement, 1, ...DROPPED_OBJECT_WORDS)
    const what = spellType(statement.slice(1, nameAt))
    const name = readName(statement, skipWords(statement, nameAt, 'IF', 'EXISTS'))?.name
    return { findings: [{ kind: 'drop-cascade', line, message: `drops ${what || 'an object'} ${name ?? '?'} with CASCADE, which also drops every column and object depending on it` }] }
  }

  if (isWord(first, 'ALTER') && isWord(second, 'TABLE')) return { findings: scanAlterTable(statement, line) }

  if (isWord(first, 'RENAME') && isWord(second, 'TABLE')) {
    return {
      findings: splitTopLevel(statement.slice(2)).map((part): RawFinding => {
        const from = readName(part, 0)
        const to = from && isWord(part[from.next], 'TO') ? readName(part, from.next + 1)?.name : undefined
        return { kind: 'rename', line, table: from?.name, message: `renames table ${from?.name ?? '?'} to ${to ?? '?'}`, renameFrom: from?.name, renameTo: to }
      }),
    }
  }

  if (isWord(first, 'TRUNCATE')) {
    return {
      findings: splitTopLevel(statement.slice(skipWords(statement, 1, 'TABLE'))).map((part): RawFinding => {
        const table = readName(part, skipWords(part, 0, 'ONLY'))?.name
        return { kind: 'truncate', line, table, message: `empties table ${table ?? '?'}` }
      }),
    }
  }

  if (isWord(first, 'CREATE')) {
    const tableAt = skipWords(statement, 1, 'TEMP', 'TEMPORARY', 'UNLOGGED', 'VIRTUAL')
    if (isWord(statement[tableAt], 'TABLE')) {
      // `IF NOT EXISTS` counts: drizzle-kit 0.x wrote every create that way, and it can only no-op over
      // a table the tracker never recorded creating (one made by push or by hand).
      const table = readName(statement, skipWords(statement, tableAt + 1, 'IF', 'NOT', 'EXISTS'))
      return { findings: [], creates: table?.name, columnTypes: table && readColumnTypes(statement, table.next) }
    }
    // A procedure, function, trigger or event carries statements after its header; read them too.
    return { findings: scanDdl(statement.slice(1)).findings }
  }

  return { findings: [] }
}

function scanStatement(tokens: Token[]): StatementScan {
  const ddl = scanDdl(tokens)
  return { ...ddl, findings: [...ddl.findings, ...scanDeletes(tokens)] }
}

/** Whether the statement's string literals are SQL it runs: a PostgreSQL function or `DO` body written as a string. */
function stringsAreBodies(tokens: Token[]): boolean {
  if (isWord(tokens[0], 'DO')) return true
  if (!isWord(tokens[0], 'CREATE')) return false
  const kindAt = skipWords(tokens, 1, 'OR', 'REPLACE')
  return isWord(tokens[kindAt], 'FUNCTION', 'PROCEDURE')
}

/**
 * SQL a statement builds or runs from a value: `EXECUTE 'literal'` and
 * `PREPARE s FROM 'literal'` are read as SQL, anything else (a concatenation,
 * `format()`, a variable) cannot be, and is a finding.
 */
function scanDynamicSql(tokens: Token[]): { findings: RawFinding[]; sql: Token[] } {
  const findings: RawFinding[] = []
  const sql: Token[] = []
  const ends = (token: Token | undefined) => token === undefined || token.value === ';' || isWord(token, 'USING', 'INTO')
  tokens.forEach((token, at) => {
    let source: number | undefined
    if (isWord(token, 'EXECUTE') && !isWord(tokens[at + 1], 'FUNCTION', 'PROCEDURE', 'ON') && tokens[at + 1]?.value !== ',' && !isWord(tokens[at - 1], 'GRANT', 'REVOKE')) {
      source = at + 1
    } else if (isWord(token, 'PREPARE')) {
      const name = readName(tokens, at + 1)
      if (name && isWord(tokens[name.next], 'FROM')) source = name.next + 1
    }
    if (source === undefined) return
    const literal = tokens[source]
    if (literal?.kind === 'string' && ends(tokens[source + 1])) {
      sql.push(literal)
      return
    }
    findings.push({ kind: 'unreadable', line: token.line, message: 'runs SQL built at run time, which cannot be read before it runs' })
  })
  return { findings, sql }
}

/** Tables a `REFERENCES` names with an `ON DELETE` that deletes or rewrites the referencing rows. */
function cascadeTargets(tokens: Token[]): string[] {
  const targets: string[] = []
  tokens.forEach((token, at) => {
    if (!isWord(token, 'REFERENCES')) return
    const target = readName(tokens, at + 1)
    if (!target) return
    for (let next = target.next; next < tokens.length && !isWord(tokens[next], 'REFERENCES'); next += 1) {
      if (isWord(tokens[next], 'ON') && isWord(tokens[next + 1], 'DELETE') && isWord(tokens[next + 2], 'CASCADE', 'SET')) {
        targets.push(target.name)
        return
      }
    }
  })
  return targets
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

function mentions(statement: Token[], table: string): boolean {
  const name = unqualified(table)
  return statement.some((token) => (token.kind === 'word' || token.kind === 'ident' || token.kind === 'string') && nameValue(token) === name)
}

interface IndexedFinding extends RawFinding {
  /** Which top-level statement it came from; undefined for one found in a body or an executable comment. */
  statement?: number
}

function scanTokens(lexed: Lexed, rules: LexRules): Omit<MigrationScan, 'acknowledged'> {
  const raw: IndexedFinding[] = []
  const creates: MigrationScan['creates'] = []
  const cascades: string[] = []
  const copies: Array<{ into: string; from: string; columns: string[]; statement: number }> = []
  const copyTypes = new Map<string, Record<string, string>>()
  const statements = splitStatements(lexed.tokens)
  const scanNested = (text: string, line: number) => {
    const nested = scanTokens(lex(text, rules, line), rules)
    raw.push(...nested.statements)
    cascades.push(...nested.cascadeTargets)
  }

  statements.forEach((statement, index) => {
    const result = scanStatement(statement)
    raw.push(...result.findings.map((finding) => ({ ...finding, statement: index })))
    const copy = readCopy(statement)
    if (copy) copies.push({ ...copy, statement: index })
    if (result.creates) {
      creates.push({ table: result.creates, line: statement[0]!.line })
      if (result.columnTypes && unqualified(result.creates).startsWith(REBUILD_PREFIX)) copyTypes.set(result.creates, result.columnTypes)
    }
    cascades.push(...cascadeTargets(statement))
    const dynamic = scanDynamicSql(statement)
    raw.push(...dynamic.findings)
    const bodies = stringsAreBodies(statement)
    // A dollar-quoted body (a `DO` block, a function), a function body written as a string, and an `EXECUTE`d literal can run the same DDL.
    for (const token of statement) {
      if (token.kind === 'body' || (bodies && token.kind === 'string') || dynamic.sql.includes(token)) scanNested(token.value, token.line)
    }
  })
  for (const { text, line } of lexed.executable) scanNested(text, line)

  if (lexed.unterminatedAt !== undefined) {
    raw.push({ kind: 'unreadable', line: lexed.unterminatedAt, message: 'opens a string, identifier, comment or $$ body that never closes, so nothing after it can be read' })
  }

  // drizzle-kit's SQLite rebuild: create __new_x, copy, drop x, rename __new_x to x.
  const renames = raw.filter((finding) => finding.kind === 'rename' && finding.renameFrom && finding.renameTo
    && unqualified(finding.renameFrom) === `${REBUILD_PREFIX}${unqualified(finding.renameTo)}`)
  const rebuilt = new Set(renames.map((finding) => finding.renameTo!))

  /**
   * The copy counts only while nothing but the rebuild's own statements touches
   * the copy, and nothing touches the original between the copy and the drop:
   * a `DELETE FROM __new_x` in between would empty the table that survives.
   */
  const intactCopy = (drop: IndexedFinding): { into: string; columns: string[] } | undefined => {
    const table = drop.table!
    const copyName = `${REBUILD_PREFIX}${unqualified(table)}`
    const copy = copies.find((entry) => entry.from === table && unqualified(entry.into) === copyName)
    const rename = renames.find((finding) => finding.renameTo === table)
    if (!copy || drop.statement === undefined || rename?.statement === undefined) return undefined
    const own = new Set([copy.statement, drop.statement, rename.statement])
    const touched = statements.some((statement, index) => {
      if (own.has(index)) return false
      const createsCopy = isWord(statement[0], 'CREATE') && creates.some((entry) => entry.line === statement[0]!.line && unqualified(entry.table) === copyName)
      if (createsCopy && index < copy.statement) return false
      if (mentions(statement, copyName)) return true
      return index > copy.statement && index < drop.statement! && mentions(statement, table)
    })
    return touched ? undefined : copy
  }

  const out: DestructiveStatement[] = []
  for (const { renameFrom, renameTo, statement: at, ...finding } of raw) {
    if (renameTo && rebuilt.has(renameTo) && renameFrom && unqualified(renameFrom).startsWith(REBUILD_PREFIX)) continue
    if (finding.kind === 'drop-table' && finding.table && rebuilt.has(finding.table)) {
      const copy = intactCopy({ ...finding, statement: at })
      const types = copy && copyTypes.get(copy.into)
      out.push({
        ...finding,
        ...(copy ? { copiedColumns: copy.columns } : {}),
        ...(types ? { copiedColumnTypes: types } : {}),
        kind: 'table-rebuild',
        message: `rebuilds table ${finding.table} (copies rows into ${REBUILD_PREFIX}${unqualified(finding.table)}, drops ${finding.table}, renames the copy)`,
      })
      continue
    }
    out.push(finding)
  }

  return { statements: out.sort((a, b) => a.line - b.line), creates, cascadeTargets: [...new Set(cascades)] }
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

function scanWith(sql: string, dialect: MigrationDialect): MigrationScan {
  const rules = LEX_RULES[dialect]
  const lexed = lex(sql, rules)
  return { ...scanTokens(lexed, rules), acknowledged: readAcknowledgement(lexed.comments) }
}

/**
 * Every destructive statement in one migration file, and its acknowledgement.
 * With no dialect, each dialect's reading is taken and merged so that none can
 * hide a statement: every finding counts, while a create and the marker count
 * only when every reading has them.
 */
export function scanMigrationSql(sql: string, { dialect }: ScanOptions = {}): MigrationScan {
  if (dialect) return scanWith(sql, dialect)
  const readings = DIALECTS.map((each) => scanWith(sql, each))
  const merged = new Map<string, DestructiveStatement>()
  for (const statement of readings.flatMap((reading) => reading.statements)) {
    const key = [statement.kind, statement.line, statement.table, statement.column].join('\u0000')
    const kept = merged.get(key)
    if (!kept) {
      merged.set(key, statement)
      continue
    }
    // Exemption evidence counts only when every reading saw the same.
    const { copiedColumns, copiedColumnTypes, targetType, ...rest } = kept
    const evidence = (each: DestructiveStatement) => JSON.stringify([each.copiedColumns, each.copiedColumnTypes, each.targetType])
    if (evidence(kept) !== evidence(statement)) merged.set(key, rest)
  }
  const statements = [...merged.values()]
  const createKey = (entry: { table: string; line: number }) => `${entry.table}\u0000${entry.line}`
  const [first, ...rest] = readings
  return {
    statements: statements.sort((a, b) => a.line - b.line),
    creates: first!.creates.filter((entry) => rest.every((reading) => reading.creates.some((other) => createKey(other) === createKey(entry)))),
    cascadeTargets: [...new Set(readings.flatMap((reading) => reading.cascadeTargets))],
    acknowledged: readings.every((reading) => reading.acknowledged) ? first!.acknowledged : null,
  }
}

/**
 * Column types from a drizzle-kit 1.x `snapshot.json`, keyed by schema, table and
 * column exactly as the snapshot names them (no case folding), so `archive.posts`
 * never borrows `public.posts`'s evidence. Read through `columnType()`.
 */
export type ColumnTypes = ReadonlyMap<string, string>

const KEY_SEPARATOR = '\u0000'

export function readSnapshotColumnTypes(snapshot: unknown): ColumnTypes | undefined {
  const ddl = (snapshot as { ddl?: unknown } | null)?.ddl
  if (!Array.isArray(ddl)) return undefined
  const types = new Map<string, string>()
  for (const entry of ddl as Array<Record<string, unknown>>) {
    if (entry?.entityType !== 'columns') continue
    const { schema, table, name, type } = entry
    if (typeof table !== 'string' || typeof name !== 'string' || typeof type !== 'string') continue
    types.set([typeof schema === 'string' ? schema : '', table, name].join(KEY_SEPARATOR), type)
  }
  return types
}

export function readSnapshotForeignKeys(snapshot: unknown): ForeignKeyReference[] | undefined {
  const ddl = (snapshot as { ddl?: unknown } | null)?.ddl
  if (!Array.isArray(ddl)) return undefined
  return (ddl as Array<Record<string, unknown>>).flatMap((entry) => {
    const { table, tableTo, onDelete } = entry ?? {}
    if (entry?.entityType !== 'fks' || typeof table !== 'string' || typeof tableTo !== 'string') return []
    // An action the snapshot does not spell is read as one that deletes.
    return [{ table, tableTo, onDelete: typeof onDelete === 'string' ? onDelete : 'CASCADE' }]
  })
}

/** drizzle-kit's `dialect`, folded onto how the SQL is lexed; undefined for one it does not name. */
export function readSnapshotDialect(snapshot: unknown): MigrationDialect | undefined {
  const dialect = (snapshot as { dialect?: unknown } | null)?.dialect
  if (dialect === 'postgres' || dialect === 'postgresql' || dialect === 'gel') return 'postgres'
  if (dialect === 'mysql' || dialect === 'singlestore') return 'mysql'
  if (dialect === 'sqlite' || dialect === 'turso') return 'sqlite'
  return undefined
}

/** The table's key prefixes to try: its own schema when the SQL qualifies it, else PostgreSQL's `public` or no schema. */
function tablePrefixes(table: string): string[] {
  const dot = table.lastIndexOf('.')
  if (dot !== -1) return [[table.slice(0, dot), table.slice(dot + 1), ''].join(KEY_SEPARATOR)]
  return [['public', table, ''].join(KEY_SEPARATOR), ['', table, ''].join(KEY_SEPARATOR)]
}

function columnType(types: ColumnTypes | undefined, table: string, column: string): string | undefined {
  for (const prefix of tablePrefixes(table)) {
    const type = types?.get(prefix + column)
    if (type !== undefined) return type
  }
  return undefined
}

function tableColumns(types: ColumnTypes, table: string): Array<[column: string, type: string]> {
  for (const prefix of tablePrefixes(table)) {
    const columns = [...types].filter(([key]) => key.startsWith(prefix)).map(([key, type]): [string, string] => [key.slice(prefix.length), type])
    if (columns.length > 0) return columns
  }
  return []
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
/** Holds any varchar: MySQL caps a varchar at 65,535 bytes, which `text` holds; `tinytext` holds 255. */
const HOLDS_ANY_VARCHAR = new Set(['text', 'mediumtext', 'longtext'])
const NUMERIC = new Set(['numeric', 'decimal'])

/**
 * Whether `after` holds every value `before` holds: a closed list, so a pair
 * it does not name is not widening. Equal types (a MySQL `MODIFY` that only
 * changes nullability) count, since no value changes.
 */
export function isWideningTypeChange(before: string, after: string, dialect?: MigrationDialect): boolean {
  const from = parseType(before)
  const to = parseType(after)
  if (!from || !to) return false
  if (from.base === to.base && from.unsigned === to.unsigned && from.args.join() === to.args.join()) return true
  if (from.unsigned !== to.unsigned) return false

  if (from.base in INTEGER_RANK && to.base in INTEGER_RANK && from.args.length === 0) {
    return INTEGER_RANK[to.base]! >= INTEGER_RANK[from.base]!
  }

  const fromText = VARYING.has(from.base) || FIXED.has(from.base)
  if (fromText && HOLDS_ANY_VARCHAR.has(to.base)) return true
  if (fromText && VARYING.has(to.base)) {
    if (to.args.length === 0) return true
    return from.args.length === 1 && to.args[0]! >= from.args[0]!
  }
  if (from.base in TEXT_RANK && to.base in TEXT_RANK) return TEXT_RANK[to.base]! >= TEXT_RANK[from.base]!

  if (NUMERIC.has(from.base) && NUMERIC.has(to.base)) {
    // PostgreSQL's bare numeric holds any value; MySQL's bare DECIMAL is DECIMAL(10,0), which an unknown dialect is read as.
    const unbounded = dialect === 'postgres'
    if (to.args.length === 0 && unbounded) return true
    if (from.args.length === 0 && unbounded) return false
    const [fromPrecision, fromScale = 0] = from.args.length === 0 ? [10] : from.args
    const [toPrecision, toScale = 0] = to.args.length === 0 ? [10] : to.args
    return toScale >= fromScale && toPrecision! - toScale >= fromPrecision! - fromScale
  }

  if ((from.base === 'real' || from.base === 'float4') && (to.base === 'double precision' || to.base === 'float8')) return true

  return false
}

const DELETING_ACTIONS = new Set(['CASCADE', 'SET NULL', 'SET DEFAULT'])

/**
 * Lossless: every column the previous snapshot names is copied to itself, keeping or widening its type in
 * the copy's own `CREATE TABLE` (a `--custom` migration repeats its predecessor's snapshot, which vouches for nothing),
 * and, where foreign keys stay on (D1 ignores `PRAGMA foreign_keys=OFF`), no `ON DELETE` fires on the `DROP TABLE`.
 * drizzle-kit rebuilds a SQLite table for an added default or foreign key, so without this each such edit needs sign-off.
 */
function isLosslessRebuild(statement: DestructiveStatement, source: MigrationSource, foreignKeysEnforced: boolean): boolean {
  const before = source.columnTypes?.before
  const { table, copiedColumns, copiedColumnTypes } = statement
  if (!table || !copiedColumns || !copiedColumnTypes || !before) return false
  const previous = tableColumns(before, table)
  if (previous.length === 0) return false
  const copied = new Set(copiedColumns)
  const kept = previous.every(([column, type]) => {
    const next = copiedColumnTypes[column]
    return copied.has(column) && next !== undefined && isWideningTypeChange(type, next, source.dialect)
  })
  if (!kept || !foreignKeysEnforced) return kept
  const name = unqualified(table)
  if (source.scan.cascadeTargets.some((target) => unqualified(target) === name)) return false
  const references = [...(source.foreignKeys?.before ?? []), ...(source.foreignKeys?.after ?? [])]
  return !references.some((reference) => reference.tableTo === name && DELETING_ACTIONS.has(reference.onDelete.toUpperCase()))
}

/** Two spellings of one type, compared after `parseType()` normalizes case, spacing and arguments. */
function sameType(a: string, b: string): boolean {
  const left = parseType(a)
  const right = parseType(b)
  return left !== undefined && right !== undefined && left.base === right.base && left.unsigned === right.unsigned && left.args.join() === right.args.join()
}

/**
 * A type change is exempt only when the SQL itself converts to the type this
 * migration's snapshot records, by a plain cast, and the snapshots show that
 * type holding every value of the previous one. A custom migration repeats its
 * predecessor's snapshot, so its SQL target never matches a changed type.
 */
function isWideningChange(statement: DestructiveStatement, { columnTypes, dialect }: MigrationSource): boolean {
  if (!statement.table || !statement.column || !statement.targetType) return false
  const before = columnType(columnTypes?.before, statement.table, statement.column)
  const after = columnType(columnTypes?.after, statement.table, statement.column)
  return before !== undefined && after !== undefined && sameType(statement.targetType, after) && isWideningTypeChange(before, after, dialect)
}

export interface MigrationSource {
  /** The migration folder's name, as the tracker records it. */
  name: string
  /** How a finding names the file: `db/migrations/<name>/migration.sql`. */
  file: string
  scan: MigrationScan
  /** Column types after this migration, and before it, when its snapshots read. */
  columnTypes?: { before?: ColumnTypes; after?: ColumnTypes }
  /** Foreign keys after this migration, and before it, when its snapshots read. */
  foreignKeys?: { before?: ForeignKeyReference[]; after?: ForeignKeyReference[] }
  /** The dialect the SQL was read in, when the driver or the snapshot names one. */
  dialect?: MigrationDialect
}

export interface ForeignKeyReference {
  /** The referencing table. */
  table: string
  tableTo: string
  /** As the snapshot spells it: `CASCADE`, `SET NULL`, `NO ACTION`, … */
  onDelete: string
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
  /**
   * Whether a rebuild's `DROP TABLE` fires the `ON DELETE` of the tables
   * referencing it. Only a runner that turns foreign keys off around the
   * migration (bun:sqlite's) may say no; Cloudflare D1 keeps them on.
   */
  foreignKeysEnforced?: boolean
}

/**
 * Judges migrations in the order they would be applied. A finding against a
 * table an earlier statement of the run creates is dropped (a fresh database
 * loses nothing), and so is a type change the snapshots show widening.
 */
export function judgeMigrations(
  sources: readonly MigrationSource[],
  { exemptCreatedInRun = true, foreignKeysEnforced = true }: JudgeOptions = {},
): MigrationGuardReport {
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
      .filter((statement) => statement.kind === 'unreadable' || statement.kind === 'drop-schema' || statement.kind === 'drop-cascade' || !createdEarlier(statement.table, statement.line))
      .filter((statement) => statement.kind !== 'table-rebuild' || !isLosslessRebuild(statement, source, foreignKeysEnforced))
      .filter((statement) => statement.kind !== 'alter-column-type' || !isWideningChange(statement, source))
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
  { dialect }: ScanOptions = {},
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
    const snapshot = readSnapshot(resolve(migrationsFolder, name, 'snapshot.json'))
    const sourceDialect = dialect ?? readSnapshotDialect(snapshot)
    const scan = scanMigrationSql(sql, { dialect: sourceDialect })
    const source: MigrationSource = {
      name,
      file: `${displayFolder.replace(/\/$/, '')}/${name}/migration.sql`,
      scan,
      ...(sourceDialect ? { dialect: sourceDialect } : {}),
    }
    if (scan.statements.some((statement) => statement.kind === 'alter-column-type' || statement.kind === 'table-rebuild')) {
      const previousIds = (snapshot as { prevIds?: unknown } | undefined)?.prevIds
      const previous = Array.isArray(previousIds) && previousIds.length === 1 ? snapshotById(previousIds[0]) : undefined
      source.columnTypes = { after: readSnapshotColumnTypes(snapshot), before: readSnapshotColumnTypes(previous) }
      source.foreignKeys = { after: readSnapshotForeignKeys(snapshot), before: readSnapshotForeignKeys(previous) }
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
  /** `trackerError`: why the tracker could not be read, kept as the `cause` so a connection failure is not hidden behind the findings. */
  constructor(readonly findings: DestructiveFinding[], pendingKnown = true, trackerError?: unknown) {
    super(
      `Refusing to apply ${findings.length} destructive statement(s) that no migration acknowledges:\n` +
        (pendingKnown ? '' : `  (${describeTrackerError(trackerError)}, so every local migration was judged, applied ones included)\n`) +
        findings.map((finding) => `  ${formatDestructiveFinding(finding)}`).join('\n') +
        `\nReview each one. To apply it, put \`-- ${ALLOW_DESTRUCTIVE_MARKER}: <reason>\` on the first line of its migration.sql, ` +
        `or set ${ALLOW_DESTRUCTIVE_ENV}=1 for one run.`,
    )
    this.name = 'DestructiveMigrationError'
    if (trackerError !== undefined) this.cause = trackerError
  }
}

function describeTrackerError(error: unknown): string {
  if (error === undefined) return 'the migration tracker could not be read'
  return `the migration tracker could not be read: ${error instanceof Error ? error.message : String(error)}`
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
  { pendingKnown = true, trackerError, dialect, foreignKeysEnforced }: {
    pendingKnown?: boolean
    /** Why the tracker could not be read, when `pendingKnown` is false. */
    trackerError?: unknown
    dialect?: MigrationDialect
    foreignKeysEnforced?: boolean
  } = {},
): void {
  if (pending.length === 0) return
  const sources = readMigrationSources(migrationsFolder, pending, displayFolder(migrationsFolder), { dialect })
  const { unacknowledged } = judgeMigrations(sources, { exemptCreatedInRun: pendingKnown, foreignKeysEnforced })
  if (unacknowledged.length === 0) return

  const allowed = process.env[ALLOW_DESTRUCTIVE_ENV] === '1'
  if (mode === 'refuse' && !allowed) throw new DestructiveMigrationError(unacknowledged, pendingKnown, trackerError)

  const why = allowed
    ? `${ALLOW_DESTRUCTIVE_ENV}=1 is set`
    : "pass `destructiveMigrations: 'refuse'` to the database factory to stop at these instead"
  console.warn(
    `[guren/orm] Applying ${unacknowledged.length} destructive statement(s) that no migration acknowledges (${why}):\n` +
      (pendingKnown ? '' : `[guren/orm]   (${describeTrackerError(trackerError)}, so every local migration was judged)\n`) +
      unacknowledged.map((finding) => `[guren/orm]   ${formatDestructiveFinding(finding)}`).join('\n'),
  )
}
