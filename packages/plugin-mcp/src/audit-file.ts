/**
 * The file half of the agent audit sink: JSONL appended through
 * `DailyFileChannel`, which already owns rotation, the `days` retention sweep,
 * directory creation and the line format — a second appender would be a second
 * rotation rule. A separate module so `plugin.ts` can reach it through a
 * dynamic `import()` and an application with no file sink never evaluates it.
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
    // The most permissive level there is: the channel drops entries below its
    // own threshold, and an audit trail must not silently discard records.
    level: 'debug',
    days,
  })

  return (record) => {
    // The record's own instant, not a second clock read: the channel picks the
    // dated file from this timestamp, so anything else could file a record on
    // the far side of a midnight boundary from the one it reports. The record
    // rides in `context`, which the JSON format spreads across the top level of
    // the line inside a log envelope `parseAuditRecord` reads back through.
    channel.log({
      level: 'info',
      message: 'agent.audit',
      timestamp: new Date(record.ts),
      context: { ...record },
    })
  }
}
