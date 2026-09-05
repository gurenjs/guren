/**
 * `guren tool:log` — read the agent audit trail back (RFC 0016 §5.2).
 *
 * The read half of the sink `@guren/plugin-mcp`'s `audit` option installs. Unlike its `tool:`
 * neighbours it does **not** boot the application: an operator investigating an incident
 * must be able to read the log whether or not the app still starts. Which files belong to a
 * base path is `matchDailyFileDate`'s answer, what a line means is `parseAuditRecord`'s.
 * **An empty result is a claim**: the sink is opt-in, so an absent file prints the configuration
 * line, and nothing pre-checks with `existsSync`, whose "does not exist" hides a permission error.
 */
import { consola } from 'consola'
import { readdir, readFile, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  DEFAULT_AGENT_AUDIT_PATH,
  dailyFilePath,
  matchDailyFileDate,
  parseAuditRecord,
  type AgentAuditRecord,
  type AgentSurface,
} from '@guren/core'

/** How many records `-n` shows when it is not given. */
const DEFAULT_LIMIT = 50

/** How often `--tail` looks for new bytes, in milliseconds. */
const FOLLOW_INTERVAL_MS = 500

/**
 * Surfaces `--surface` accepts, spelled out so a typo is refused by name: passing the
 * value straight into the filter would answer a misspelling with an empty list, which
 * reads here as "no agent calls". Keys of a total map, not an array: `satisfies
 * readonly AgentSurface[]` admits a short list, so a new surface would be refused as
 * a typo while its records sat in the trail.
 */
const SURFACES = Object.keys({
  'mcp': true,
  'dev-mcp': true,
  'cli': true,
  'webmcp': true,
  'durable': true,
} satisfies Record<AgentSurface, true>) as readonly AgentSurface[]

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
  /**
   * Stops a `--tail`, which otherwise runs until the process is interrupted — the only
   * way out for a caller embedding this command. It cuts the poll sleep short rather than
   * being read between polls, so an abort does not feel like a hang for up to a further
   * {@link FOLLOW_INTERVAL_MS}. Nothing is flushed: unread records are still on disk.
   */
  signal?: AbortSignal
}

/**
 * Read `--since` as a span of milliseconds. Refused rather than defaulted: `--since
 * yesterday` silently meaning "no cutoff" shows more than was asked for, and silently
 * meaning "everything is too old" shows nothing while looking like an answer.
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
  const span = Number(match[1]) * units[match[2]]
  // A digit string long enough to overflow a double passes the pattern and arrives as
  // Infinity, whose cutoff is -Infinity — no filter at all, silently.
  if (!Number.isFinite(span)) {
    throw new Error(`--since "${raw}" is too large to be a duration.`)
  }
  return span
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
 * Whether one record passes the filters. A record whose `ts` will not parse fails a
 * `--since` — an unreadable timestamp cannot answer "newer than this" — but with no
 * `--since` it is kept: a broken clock field is no reason to hide what a tool did.
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
 * The dated files of one base path, newest first. `null` when the directory does not
 * exist, which is a different answer from "exists and holds none of ours". Every other
 * failure throws: a directory that cannot be *read* must not be reported as empty.
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
    // Stamps are `YYYY-MM-DD`, so lexical order is chronological order — no Date round
    // trip, and no time-zone question.
    .sort((a, b) => b.stamp.localeCompare(a.stamp))
    .map((candidate) => resolve(dir, candidate.entry))
}

/**
 * The newest `limit` matching records across `files` (newest first), returned oldest
 * first. Files are visited newest first so a `-n` spanning a rollover reads two files
 * rather than the whole retention window. The limit applies **after** filtering:
 * `--denied -n 50` means the last fifty denials, not the denials among the last fifty
 * records, which over a busy trail is reliably empty and reads as "there were none".
 */
async function collectRecords(
  files: string[],
  filters: AuditFilters,
  limit: number,
): Promise<AgentAuditRecord[]> {
  let collected: AgentAuditRecord[] = []
  for (const file of files) {
    const text = await readAuditFile(file)
    // Vanished between the listing and the read: the writer's retention sweep deletes
    // expired files on rotation, so this is a normal race.
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

  // Widened to `string` to ask the question, rather than asserting the value
  // into the union the question is about.
  if (options.surface !== undefined && !(SURFACES as readonly string[]).includes(options.surface)) {
    throw new Error(
      `Unknown --surface "${options.surface}". `
        + `The surfaces an audit record carries are: ${SURFACES.join(', ')}.`,
    )
  }

  const filters: AuditFilters = {
    tool: options.tool,
    surface: options.surface,
    denied: options.denied,
    since: options.since === undefined ? undefined : Date.now() - parseSinceDuration(options.since),
  }
  const limit = options.limit ?? DEFAULT_LIMIT

  if (options.tail) {
    await tailAuditLog(basePath, filters, limit, options.json, options.signal)
    return
  }

  // The two silences this command keeps apart, in the order they can be told apart: no
  // trail at all (`listRotationFiles` answers `null`), then a trail matching nothing.
  const files = await listRotationFiles(basePath)
  if (files === null || files.length === 0) {
    printNoTrail(basePath, options.json, false)
    return
  }

  const records = await collectRecords(files, filters, limit)
  if (records.length === 0) {
    // Said out loud: the silence is otherwise identical to an unwired sink's.
    if (!options.json) consola.info('The audit trail holds no records matching those filters.')
    return
  }

  for (const record of records) print(record, options.json)
}

/**
 * What to say when there is no trail at all: neither an empty list nor a claim that the
 * sink is unconfigured, since from here the two are indistinguishable — the message names
 * both possibilities. On stderr via consola, so a `--json` run stays pipeable.
 */
function printNoTrail(basePath: string, json: boolean | undefined, following: boolean): void {
  consola.warn(`No agent audit trail found at ${dailyFilePath(basePath, new Date())}.`)
  if (json) return

  console.error(
    '\nThe audit sink is opt-in. Agent tool calls emit AgentToolInvoked and AgentToolDenied\n'
      + 'events whether or not anything records them, so until a sink is configured there is\n'
      + 'nothing on disk to read. Add one to the MCP plugin:\n'
      + `\n  mcpPlugin({ audit: { file: '${DEFAULT_AGENT_AUDIT_PATH}' } })\n`
      + (following
        // Said and then followed anyway: a sink wired a minute ago has no file until the
        // first tool call, which is exactly what a `--tail` is waiting for.
        ? '\nIf it is already configured, waiting here for the first record.\n'
        : '\nIf it is already configured, either no tool has been called yet, or the trail is\n'
          + 'somewhere else — pass --file to point this command at it.'),
  )
}

function print(record: AgentAuditRecord, json?: boolean): void {
  if (json) {
    // One record per line and nothing beside it: callers passing this flag pipe stdout
    // into a parser.
    console.log(JSON.stringify(record))
    return
  }

  // Escape codes only for a terminal: without `--json` this listing is still routinely
  // piped into `grep` or a file kept with an incident.
  const paint = process.stdout.isTTY === true
    ? (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`
    : (_code: string, text: string) => text

  const outcome = record.outcome === 'denied'
    ? `${paint('31', 'denied')}  ${record.reason}`
    : `invoked ${record.status} (${record.durationMs}ms)`
  const principal = record.principal ? `${record.principal.kind}:${record.principal.id}` : 'anonymous'
  const args = Object.keys(record.arguments).length > 0 ? `  ${JSON.stringify(record.arguments)}` : ''

  console.log(`${record.ts}  ${outcome}  ${paint('1', record.tool)}  ${record.surface}  ${principal}${args}`)
}

/**
 * Print the backlog, then follow the trail across midnight. Today's file is read through
 * the very cursor that goes on to follow it, so no record falls between a snapshot and a
 * `stat` of a growing file; only the older files, which nothing appends to, go through the
 * ordinary read. The followed path is recomputed every poll, since the file being appended
 * to changes name at UTC midnight — following one path would go quiet then.
 */
async function tailAuditLog(
  basePath: string,
  filters: AuditFilters,
  limit: number,
  json?: boolean,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = new FileCursor(dailyFilePath(basePath, new Date()))
  const todayRecords = await cursor.pull()

  const files = await listRotationFiles(basePath)
  const older = (files ?? []).filter((file) => file !== cursor.file)
  const backlog = await collectRecords(older, filters, limit)

  if (files === null || files.length === 0) printNoTrail(basePath, json, true)

  const matchedToday = todayRecords.filter((record) => matchesFilters(record, filters))
  for (const record of backlog.concat(matchedToday).slice(-limit)) print(record, json)

  for (;;) {
    // The sleep is where an iteration spends nearly all its time, so aborting is answered
    // there and confirmed here, before any further reading.
    await sleep(FOLLOW_INTERVAL_MS, signal)
    if (signal?.aborted === true) return

    const current = dailyFilePath(basePath, new Date())
    if (current !== cursor.file) {
      // Everything the old file still holds, fragment included: nothing more is coming to
      // it, so a record whose trailing newline arrived late must be taken now or lost.
      printAll(await cursor.drain(), filters, json)
      cursor = new FileCursor(current)
    }

    printAll(await cursor.pull(), filters, json)
  }
}

function printAll(records: AgentAuditRecord[], filters: AuditFilters, json?: boolean): void {
  for (const record of records) {
    if (matchesFilters(record, filters)) print(record, json)
  }
}

/**
 * One dated file being followed: how far into it we have read, the character whose bytes
 * a read split, and the line a read split. Each is meaningless except relative to the
 * same position, so a rollover is one `new FileCursor(...)` rather than three assignments.
 */
class FileCursor {
  private decoder = new StringDecoder('utf8')
  private partial = ''
  private offset = 0

  constructor(readonly file: string) {}

  /** Whatever the file has gained since the last pull, in the order written. */
  async pull(): Promise<AgentAuditRecord[]> {
    const read = await readFrom(this.file, this.offset)
    if (read === null) return []
    if (read.restarted) this.reset()

    this.offset = read.offset
    // The decoder is held across polls, so a character whose bytes straddle a read
    // boundary is completed by the next read rather than becoming replacement bytes —
    // otherwise the trail drops a call because an argument was not ASCII.
    const text = this.partial + this.decoder.write(read.buffer)
    // An append is not atomic, so a poll can land mid-record. Bytes after the last
    // newline are held rather than parsed, or the record is lost when its remainder
    // arrives headless.
    const cut = text.lastIndexOf('\n')
    this.partial = text.slice(cut + 1)
    return parseAuditLines(text.slice(0, cut + 1))
  }

  /**
   * Everything left, parsed whether or not a closing newline arrived. Correct only at the
   * end of a file's life: after a rollover nothing further is coming, and holding the
   * fragment back would discard a record that is already complete.
   */
  async drain(): Promise<AgentAuditRecord[]> {
    const read = await readFrom(this.file, this.offset)
    // The same restart check `pull` makes: a file truncated since the last poll is read
    // from its beginning, so the held-over fragment describes bytes that are gone and
    // would corrupt the first line of what remains.
    if (read?.restarted === true) this.reset()

    const text = this.partial + (read === null ? '' : this.decoder.write(read.buffer))
    this.reset()
    return parseAuditLines(text)
  }

  private reset(): void {
    this.decoder = new StringDecoder('utf8')
    this.partial = ''
    this.offset = 0
  }
}

/**
 * The bytes a file holds past `offset`, undecoded — bytes rather than a string because
 * only the caller knows whether the read ends at a character boundary (see
 * {@link FileCursor.pull}). A file shorter than the offset was replaced or truncated, so
 * reading resumes from the beginning and says so: the caller's position state is invalid too.
 */
async function readFrom(
  file: string,
  offset: number,
): Promise<{ buffer: Buffer; offset: number; restarted: boolean } | null> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch (error) {
    // Not yet created: normal before the first record of a new day, and before the first
    // record ever.
    if (isErrnoCode(error, 'ENOENT')) return null
    throw new Error(`Could not follow the audit log ${file}: ${errorMessage(error)}.`)
  }

  try {
    const { size } = await handle.stat()
    const restarted = size < offset
    const from = restarted ? 0 : offset
    if (size === from) return null

    const buffer = Buffer.alloc(size - from)
    await handle.read(buffer, 0, buffer.length, from)
    return { buffer, offset: size, restarted }
  } finally {
    await handle.close()
  }
}

/** Resolves after `ms`, or as soon as `signal` aborts, whichever comes first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal?.aborted === true) {
      done()
      return
    }

    const onAbort = (): void => {
      clearTimeout(timer)
      done()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      done()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
