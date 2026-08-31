/**
 * `guren tool:log` — read the agent audit trail back (RFC 0016 §5.2).
 *
 * The read half of the sink `@guren/plugin-mcp`'s `audit` option installs.
 * Unlike its `tool:` neighbours this command does **not** boot the
 * application: an audit trail is a record of calls that already happened, and
 * booting to read one would mean an operator investigating an incident cannot
 * look at the log unless the app still starts.
 *
 * Two rules it borrows rather than restates, because a reader that disagreed
 * with the writer about either would report an empty trail instead of an
 * error. Which files belong to a base path is `matchDailyFileDate`'s answer,
 * the same one `DailyFileChannel` names its files with; what a line means is
 * `parseAuditRecord`'s, the same one the record was built by. Neither is
 * re-derived here.
 *
 * **An empty result is a claim, and this command has to be careful making
 * it.** The sink is opt-in (see the RFC §5.2 amendment), so "no records" and
 * "never wired" look identical from here — and a command that printed an empty
 * list would let an operator conclude no agent touched their application when
 * nothing was ever watching. So an absent file prints the configuration line
 * instead of a list. For the same reason nothing here pre-checks with
 * `existsSync`: a permission error on a parent directory answers "does not
 * exist" to that question, and the command would go on to make exactly the
 * claim it must not. The read is attempted, and ENOENT is distinguished from
 * every other failure.
 */
import { consola } from 'consola'
import { readdir, readFile, open, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  DEFAULT_AGENT_AUDIT_PATH,
  dailyFilePath,
  matchDailyFileDate,
  parseAuditRecord,
  type AgentAuditRecord,
} from '@guren/core'

/** How many records `-n` shows when it is not given. */
const DEFAULT_LIMIT = 50

/** How often `--tail` looks for new bytes, in milliseconds. */
const FOLLOW_INTERVAL_MS = 500

/**
 * Surfaces `--surface` accepts.
 *
 * Spelled out so a typo is refused by name. The alternative — passing the
 * value straight into the filter — answers a misspelled surface with an empty
 * list, which on this command reads as "no agent calls" rather than "no such
 * surface".
 */
const SURFACES = ['mcp', 'dev-mcp', 'cli', 'webmcp'] as const

export interface ToolLogOptions {
  /** Base path of the trail; dated files sit beside it. */
  file?: string
  /** Application root the base path is resolved against. */
  appRoot?: string
  /** Follow the trail, including the rollover to tomorrow's file. */
  tail?: boolean
  /** Only this tool. */
  tool?: string
  /** Only this surface. */
  surface?: string
  /** Only denials. */
  denied?: boolean
  /** Only records newer than this duration ago (`30m`, `2h`, `7d`). */
  since?: string
  /** How many records to show. */
  limit?: number
  /** One raw record per line, for piping. */
  json?: boolean
}

/**
 * Read `--since` as a span of milliseconds.
 *
 * Refused rather than defaulted when it is not a duration: `--since yesterday`
 * silently meaning "no cutoff" would show more than the operator asked for,
 * and silently meaning "everything is too old" would show nothing while
 * looking like an answer.
 */
export function parseSinceDuration(raw: string): number {
  const match = /^(\d+)(s|m|h|d)$/u.exec(raw.trim())
  if (!match) {
    throw new Error(
      `--since must be a duration like 30m, 2h, or 7d — received "${raw}". `
        + 'Units are s (seconds), m (minutes), h (hours), d (days).',
    )
  }

  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return Number(match[1]) * units[match[2]]
}

/** The filters a record has to satisfy to be printed. */
export interface AuditFilters {
  tool?: string
  surface?: string
  denied?: boolean
  /** Epoch milliseconds; records at or after this are kept. */
  since?: number
}

/**
 * Whether one record passes the filters.
 *
 * A record whose `ts` will not parse fails a `--since` it would otherwise have
 * to be judged against — the question asked was "newer than this", and an
 * unreadable timestamp cannot answer it. With no `--since` the record is kept:
 * a broken clock field is no reason to hide what a tool did.
 */
export function matchesFilters(record: AgentAuditRecord, filters: AuditFilters): boolean {
  if (filters.tool !== undefined && record.tool !== filters.tool) return false
  if (filters.surface !== undefined && record.surface !== filters.surface) return false
  if (filters.denied === true && record.outcome !== 'denied') return false
  if (filters.since !== undefined) {
    const at = Date.parse(record.ts)
    if (Number.isNaN(at) || at < filters.since) return false
  }
  return true
}

/** Every line of `text` that is a record, in the order it was written. */
export function parseAuditLines(text: string): AgentAuditRecord[] {
  const records: AgentAuditRecord[] = []
  for (const line of text.split('\n')) {
    const record = parseAuditRecord(line)
    if (record) records.push(record)
  }
  return records
}

/**
 * The dated files of one base path, newest first.
 *
 * `null` when the directory does not exist — which is a different answer from
 * "exists and holds none of ours", and only the caller can decide what to say
 * about either. Every other failure throws: a directory that cannot be *read*
 * must not be reported as a directory that holds nothing.
 */
async function listRotationFiles(basePath: string): Promise<string[] | null> {
  const dir = dirname(basePath)

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return null
    throw new Error(
      `Could not read the audit log directory ${dir}: ${errorMessage(error)}. `
        + 'Fix the permissions or pass --file to point at a readable path.',
    )
  }

  return entries
    .map((entry) => ({ entry, stamp: matchDailyFileDate(basePath, entry) }))
    .filter((candidate): candidate is { entry: string; stamp: string } => candidate.stamp !== null)
    // Stamps are `YYYY-MM-DD`, so they sort lexically the way they sort
    // chronologically — no Date round trip, and no time-zone question.
    .sort((a, b) => b.stamp.localeCompare(a.stamp))
    .map((candidate) => resolve(dir, candidate.entry))
}

/**
 * The newest `limit` records satisfying `filters`, oldest first.
 *
 * Files are visited newest first and records accumulated until the limit is
 * reached, so a `-n` spanning a rollover is answered from two files without
 * reading the whole retention window. The limit is applied **after** filtering
 * — `--denied -n 50` means the last fifty denials, not the denials among the
 * last fifty records, which over a busy trail is reliably empty and reads as
 * "there were none".
 *
 * `null` distinguishes "no trail here at all" from an empty array, which means
 * "a trail, holding nothing that matches".
 */
export async function readAuditRecords(
  basePath: string,
  filters: AuditFilters,
  limit: number,
): Promise<AgentAuditRecord[] | null> {
  const files = await listRotationFiles(basePath)
  if (files === null || files.length === 0) return null

  let collected: AgentAuditRecord[] = []
  for (const file of files) {
    const text = await readAuditFile(file)
    // Vanished between the listing and the read: the writer's own retention
    // sweep deletes expired files on rotation, so this is a normal race and
    // not a fault to report.
    if (text === null) continue

    collected = parseAuditLines(text).filter((record) => matchesFilters(record, filters)).concat(collected)
    if (collected.length >= limit) break
  }

  return collected.slice(-limit)
}

/** One file's text, or `null` if it is gone. Any other failure throws. */
async function readAuditFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return null
    throw new Error(`Could not read the audit log ${file}: ${errorMessage(error)}.`)
  }
}

export async function runToolLog(options: ToolLogOptions): Promise<void> {
  const basePath = resolve(options.appRoot ?? process.cwd(), options.file ?? DEFAULT_AGENT_AUDIT_PATH)

  if (options.surface !== undefined && !SURFACES.includes(options.surface as (typeof SURFACES)[number])) {
    throw new Error(`Unknown --surface "${options.surface}". The surfaces an audit record carries are: ${SURFACES.join(', ')}.`)
  }

  const filters: AuditFilters = {
    tool: options.tool,
    surface: options.surface,
    denied: options.denied,
    since: options.since === undefined ? undefined : Date.now() - parseSinceDuration(options.since),
  }
  const limit = options.limit ?? DEFAULT_LIMIT

  const records = await readAuditRecords(basePath, filters, limit)
  if (records === null) {
    printNoTrail(basePath, options.json)
    return
  }

  for (const record of records) print(record, options.json)

  if (options.tail) await followAuditLog(basePath, filters, options.json)
}

/**
 * What to say when there is no trail at all.
 *
 * Not an empty list, and not an assertion that the sink is unconfigured
 * either — from here the two are indistinguishable, and claiming the wrong one
 * sends the reader looking in the wrong place. The message names both
 * possibilities and gives the configuration line for the one that needs
 * fixing.
 *
 * On stderr, via consola, so a `--json` run stays pipeable: a caller
 * redirecting stdout into a parser gets zero records, which is the truthful
 * machine answer, and still sees the explanation.
 */
function printNoTrail(basePath: string, json?: boolean): void {
  consola.warn(`No agent audit trail found at ${dailyFilePath(basePath, new Date())}.`)
  if (json) return

  console.error(
    '\nThe audit sink is opt-in. Agent tool calls emit AgentToolInvoked and AgentToolDenied\n'
      + 'events whether or not anything records them, so until a sink is configured there is\n'
      + 'nothing on disk to read. Add one to the MCP plugin:\n'
      + `\n  mcpPlugin({ audit: { file: '${DEFAULT_AGENT_AUDIT_PATH}' } })\n`
      + '\nIf it is already configured, either no tool has been called yet, or the trail is\n'
      + 'somewhere else — pass --file to point this command at it.',
  )
}

function print(record: AgentAuditRecord, json?: boolean): void {
  if (json) {
    // One record per line and nothing beside it: the callers who pass this
    // flag pipe stdout into a parser, and a decorated line makes the whole
    // stream unreadable to them.
    console.log(JSON.stringify(record))
    return
  }

  const outcome = record.outcome === 'denied'
    ? `\x1b[31mdenied\x1b[0m  ${record.reason}`
    : `invoked ${record.status} (${record.durationMs}ms)`
  const principal = record.principal ? `${record.principal.kind}:${record.principal.id}` : 'anonymous'
  const args = Object.keys(record.arguments).length > 0 ? `  ${JSON.stringify(record.arguments)}` : ''

  console.log(`${record.ts}  ${outcome}  \x1b[1m${record.tool}\x1b[0m  ${record.surface}  ${principal}${args}`)
}

/**
 * Follow the trail, across midnight.
 *
 * Two things this cannot do the simple way. The file being appended to changes
 * name at UTC midnight, so the followed path is recomputed every poll from the
 * same rule the writer names it with — watching one path would go quiet at
 * midnight and look like an application that stopped being used. And an append
 * is not atomic, so a poll can land mid-record: the bytes after the last
 * newline are held over rather than parsed, because {@link parseAuditRecord}
 * would correctly reject that fragment and the record would then be lost for
 * good when its remainder arrived headless.
 *
 * Runs until interrupted; there is no completion condition for a follow.
 */
async function followAuditLog(basePath: string, filters: AuditFilters, json?: boolean): Promise<void> {
  let followed = dailyFilePath(basePath, new Date())
  let offset = await fileSize(followed)
  let partial = ''

  for (;;) {
    await sleep(FOLLOW_INTERVAL_MS)

    const current = dailyFilePath(basePath, new Date())
    if (current !== followed) {
      // Drain what the old file received before the rollover, then start the
      // new one from its beginning — otherwise the last records of a day are
      // dropped by the switch that was supposed to keep following them.
      offset = await drain(followed, offset, partial, filters, json)
      followed = current
      offset = 0
      partial = ''
    }

    const read = await readFrom(followed, offset)
    if (read === null) continue

    offset = read.offset
    const text = partial + read.text
    const lastNewline = text.lastIndexOf('\n')
    partial = text.slice(lastNewline + 1)

    for (const record of parseAuditLines(text.slice(0, lastNewline + 1))) {
      if (matchesFilters(record, filters)) print(record, json)
    }
  }
}

/** Print whatever the file gained since `offset`, and report the new offset. */
async function drain(
  file: string,
  offset: number,
  partial: string,
  filters: AuditFilters,
  json?: boolean,
): Promise<number> {
  const read = await readFrom(file, offset)
  if (read === null) return offset

  for (const record of parseAuditLines(partial + read.text)) {
    if (matchesFilters(record, filters)) print(record, json)
  }
  return read.offset
}

/**
 * The bytes a file holds past `offset`.
 *
 * A file shorter than the offset was replaced or truncated under us — the
 * retention sweep and an operator with a text editor can both do it — so
 * reading resumes from the beginning rather than from a position that no
 * longer means anything.
 */
async function readFrom(file: string, offset: number): Promise<{ text: string; offset: number } | null> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch (error) {
    // Not yet created: normal, both before the first record of a new day and
    // before the first record ever.
    if (isErrnoCode(error, 'ENOENT')) return null
    throw new Error(`Could not follow the audit log ${file}: ${errorMessage(error)}.`)
  }

  try {
    const { size } = await handle.stat()
    const from = size < offset ? 0 : offset
    if (size === from) return null

    const buffer = Buffer.alloc(size - from)
    await handle.read(buffer, 0, buffer.length, from)
    return { text: buffer.toString('utf8'), offset: size }
  } finally {
    await handle.close()
  }
}

/** A file's current length, or 0 if it is not there yet. */
async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return 0
    throw new Error(`Could not read the audit log ${file}: ${errorMessage(error)}.`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
