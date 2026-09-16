/**
 * The file audit sink, behind a dynamic `import()` so an app with its own `sink`
 * never evaluates the filesystem channel. The line shape is the one
 * `parseAuditRecord` reads back; keep it identical to `@guren/plugin-mcp`'s
 * `src/audit-file.ts`, or `guren tool:log` reads one plugin's trail and not the other's.
 */
import { DailyFileChannel, type AgentAuditRecord } from '@guren/core'

export function createFileAuditSink(
  filePath: string,
  days: number | undefined,
): (record: AgentAuditRecord) => void {
  const channel = new DailyFileChannel({
    driver: 'daily',
    path: filePath,
    format: 'json',
    // The channel drops entries below its own level; an audit trail drops none.
    level: 'debug',
    days,
  })

  return (record) => {
    // The record's own instant picks the dated file, so a record cannot land
    // on the far side of midnight from the time it reports.
    channel.log({
      level: 'info',
      message: 'agent.audit',
      timestamp: new Date(record.ts),
      context: { ...record },
    })
  }
}
