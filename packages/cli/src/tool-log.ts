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
import { readdir, readFile, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
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
  /**
   * Stops a `--tail`, which otherwise runs until the process is interrupted.
   *
   * A follow has no completion condition of its own, so a caller embedding this
   * command — a supervisor watching a trail for the duration of a deploy, a
   * harness that has seen what it was waiting for — has no way to end one
   * except by ending the process. The signal is that way out.
   *
   * It cuts the poll sleep short rather than only being read between polls: a
   * follow that took up to a further {@link FOLLOW_INTERVAL_MS} to notice would
   * make an abort feel like a hang on the one path that has no other output.
   * Nothing is flushed on the way out — records that arrived since the last
   * poll are still on disk, and the next reader starts from the file, not from
   * this command's memory.
   */
  signal?: AbortSignal
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
  const span = Number(match[1]) * units[match[2]]
  // A digit string long enough to overflow a double passes the pattern above
  // and arrives here as Infinity, whose cutoff is -Infinity — every record
  // newer than the beginning of time, which is to say no filter at all. The
  // shape was right and the answer would be silently wrong, so it is refused
  // like any other unusable duration.
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
 * The newest `limit` matching records across `files` (newest first), oldest first.
 *
 * Files are visited newest first and records accumulated until the limit is
 * reached, so a `-n` spanning a rollover is answered from two files without
 * reading the whole retention window. The limit is applied **after** filtering
 * — `--denied -n 50` means the last fifty denials, not the denials among the
 * last fifty records, which over a busy trail is reliably empty and reads as
 * "there were none".
 */
async function collectRecords(
  files: string[],
  filters: AuditFilters,
  limit: number,
): Promise<AgentAuditRecord[]> {
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

  // The two silences this command has to keep apart, decided in the order they
  // can be told apart in: no trail at all, then a trail holding nothing that
  // matches. `listRotationFiles` answers the first — `null` for a directory
  // that does not exist, an empty list for one holding none of ours — and only
  // here does either become something to say.
  const files = await listRotationFiles(basePath)
  if (files === null || files.length === 0) {
    printNoTrail(basePath, options.json, false)
    return
  }

  const records = await collectRecords(files, filters, limit)
  if (records.length === 0) {
    // A trail exists and holds nothing matching. Said out loud, because the
    // silence is otherwise identical to the one an unwired sink produces, and
    // this command has already gone to some length to keep those apart.
    if (!options.json) consola.info('The audit trail holds no records matching those filters.')
    return
  }

  for (const record of records) print(record, options.json)
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
function printNoTrail(basePath: string, json: boolean | undefined, following: boolean): void {
  consola.warn(`No agent audit trail found at ${dailyFilePath(basePath, new Date())}.`)
  if (json) return

  console.error(
    '\nThe audit sink is opt-in. Agent tool calls emit AgentToolInvoked and AgentToolDenied\n'
      + 'events whether or not anything records them, so until a sink is configured there is\n'
      + 'nothing on disk to read. Add one to the MCP plugin:\n'
      + `\n  mcpPlugin({ audit: { file: '${DEFAULT_AGENT_AUDIT_PATH}' } })\n`
      + (following
        // Said and then followed anyway. A sink wired a minute ago has no file
        // until the first tool call, and that call is exactly what someone
        // running --tail is waiting for; exiting because it has not happened
        // yet would refuse the command's own purpose.
        ? '\nIf it is already configured, waiting here for the first record.\n'
        : '\nIf it is already configured, either no tool has been called yet, or the trail is\n'
          + 'somewhere else — pass --file to point this command at it.'),
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

  // Escape codes only for a terminal. Without `--json` this listing is still
  // routinely piped — into `grep`, into a file kept with an incident — and a
  // colour code embedded in a stored audit line is noise a later reader has no
  // way to attribute.
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
 * Print the backlog, then follow the trail across midnight.
 *
 * Today's file is read through the very cursor that goes on to follow it, and
 * that is why this function reads its own backlog rather than taking the one
 * {@link collectRecords} would hand it. A snapshot followed by a `stat` is two
 * observations of a growing file, and a record appended between them belongs to
 * neither: the snapshot was taken before it arrived and the follow resumes past
 * it. Reading once and keeping the position that read reached leaves it nowhere
 * to fall. Only the *older* files, which nothing is appending to, go through
 * the ordinary read.
 *
 * The followed path is recomputed every poll from the same rule the writer
 * names files with, because the file being appended to changes name at UTC
 * midnight — following one path would go quiet then and read as an application
 * nobody is using any more.
 *
 * Runs until interrupted, or until `signal` aborts; a follow has no completion
 * condition of its own.
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
    // The sleep is where an iteration spends all but a moment of its time, so
    // aborting is answered there and confirmed here — one check per poll,
    // taken before any further reading, so a stopped follow prints nothing it
    // was not already going to.
    await sleep(FOLLOW_INTERVAL_MS, signal)
    if (signal?.aborted === true) return

    const current = dailyFilePath(basePath, new Date())
    if (current !== cursor.file) {
      // Everything the old file still holds, including the fragment held over
      // from the last poll of it. Nothing more is coming to that file, so a
      // complete record whose trailing newline had not arrived when it was
      // last read has to be taken now or lost.
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
 * One dated file being followed: how far into it we have read, the character
 * whose bytes a read split, and the line a read split.
 *
 * The three belong together — each is meaningless except relative to the same
 * position — so a rollover becomes one `new FileCursor(...)` rather than three
 * assignments that can be forgotten one at a time.
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
    // Decoded through a decoder held across polls, so a character whose bytes
    // straddle a read boundary is completed by the next read rather than
    // becoming replacement bytes. Decoding each read on its own loses the
    // record carrying that character — which is to say, an audit trail would
    // drop a call because one of its arguments was not written in ASCII.
    const text = this.partial + this.decoder.write(read.buffer)
    // An append is not atomic, so a poll can land mid-record. The bytes after
    // the last newline are held rather than parsed: `parseAuditRecord` would
    // correctly reject the fragment, and the record would then be lost for
    // good when its remainder arrived headless.
    const cut = text.lastIndexOf('\n')
    this.partial = text.slice(cut + 1)
    return parseAuditLines(text.slice(0, cut + 1))
  }

  /**
   * Everything left, parsed whether or not a closing newline ever arrived.
   *
   * Correct only at the end of a file's life. Holding a fragment back is right
   * on every ordinary poll, because its remainder is still on the way; after a
   * rollover nothing further is coming, and the same restraint would silently
   * discard a record that is already complete.
   */
  async drain(): Promise<AgentAuditRecord[]> {
    const read = await readFrom(this.file, this.offset)
    // The same restart check `pull` makes, for the same reason. A file
    // truncated between the last poll and this drain is read from its
    // beginning, so the fragment and the half-decoded character held over
    // describe bytes that are no longer there; prepending them corrupts the
    // first line of what remains. That line is a record, and this is the last
    // chance anything in this file has to be read.
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
 * The bytes a file holds past `offset`, undecoded.
 *
 * Bytes rather than a string because only the caller knows whether the read
 * ends at a character boundary; see {@link FileCursor.pull}.
 *
 * A file shorter than the offset was replaced or truncated under us — the
 * retention sweep and an operator with a text editor can both do it — so
 * reading resumes from the beginning, and says so, since every other piece of
 * position-dependent state the caller holds is invalid too.
 */
async function readFrom(
  file: string,
  offset: number,
): Promise<{ buffer: Buffer; offset: number; restarted: boolean } | null> {
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
