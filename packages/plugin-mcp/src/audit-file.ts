/**
 * The file half of the agent audit sink: records appended as JSONL, rotated
 * daily, retained for `days`.
 *
 * A separate module because it is the only part of this plugin that needs a
 * filesystem, and `plugin.ts` reaches it through a dynamic `import()` so an
 * application configuring no file sink never evaluates it — the same reason
 * the MCP SDK is dynamically imported there. (See `plugin.ts`'s `audit` option
 * for the limit of what that currently buys: `DailyFileChannel` is reachable
 * from `@guren/core`'s root barrel, so `node:fs` is in the graph regardless
 * today. The isolation is written the way it should hold, not the way the
 * barrel happens to make it hold.)
 *
 * Nothing is reimplemented here. `DailyFileChannel` already owns rotation, the
 * `days` retention sweep, directory creation, and a JSON line format; writing
 * a second appender beside it would be a second rotation rule that disagrees
 * with the first about which file today's records belong in.
 */
import { DailyFileChannel, type AgentAuditRecord } from '@guren/core'

/** Appends one record per line. Returns the sink `plugin.ts` calls per event. */
export function createFileAuditSink(
  filePath: string,
  days: number | undefined,
): (record: AgentAuditRecord) => void {
  const channel = new DailyFileChannel({
    driver: 'daily',
    path: filePath,
    format: 'json',
    // Explicit, and the most permissive level there is: the channel drops
    // entries below its own threshold, and an audit trail that silently
    // discarded records because a default sat above the level they were
    // written at would be the exact failure this feature exists to prevent.
    level: 'debug',
    days,
  })

  return (record) => {
    // The record's own instant, not a second clock read: the channel picks the
    // dated file from this timestamp, so passing anything else could file a
    // record on the far side of a midnight boundary from the one it reports.
    //
    // The record rides in `context`, which the channel's JSON format spreads
    // across the top level of the line. That wraps it in a log envelope
    // (`timestamp`, `level`, `message`) the record's own fields sit beside;
    // `parseAuditRecord` reads through that envelope, which is what lets this
    // sink reuse the channel rather than reimplement it.
    channel.log({
      level: 'info',
      message: 'agent.audit',
      timestamp: new Date(record.ts),
      context: { ...record },
    })
  }
}
