import { defineCommand } from '../define-command'
import { markCommandFailed } from '../command-status'
import { runBrowserMap } from '../browser-map-files'
import { startBrowserServe } from '../browser-serve'
import { runBrowserDoctor, type DoctorReport } from '../browser-doctor'
import { CliError } from '../cli-error'

export const browserMapCommand = defineCommand({
  meta: { name: 'browser:map', description: 'Write the browser verification feature map under docs/browser/ from the application graph (RFC 0033).' },
  args: {
    check: { type: 'boolean', description: 'Write nothing; exit 1 when a generated block differs from what a run would write, as well as on an incomplete map.' },
    json: { type: 'boolean', description: 'Print the map model as JSON.' },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    const run = await runBrowserMap({ cwd: args.app ?? process.cwd(), write: !args.check })
    const { map } = run
    const failed = !map.complete || map.unreadablePlans.length > 0 || (args.check === true && run.changed.length > 0)
    if (failed) markCommandFailed()
    if (args.json) {
      console.log(JSON.stringify({ ...map, changed: run.changed, orphans: run.orphans }))
      return
    }
    const lines: string[] = []
    if (!map.complete) lines.push(`The feature set may be incomplete: ${map.gaps.map((gap) => gap.section).join(', ')}. The index says why.`)
    for (const entry of map.unreadablePlans) lines.push(`Plan not read: ${entry.plan}: ${entry.reason}`)
    lines.push(`${map.features.length} feature(s): ${map.features.map((feature) => feature.name).join(', ') || 'none'}`)
    if (map.unassigned.length > 0) lines.push(`${map.unassigned.length} route(s) in no feature, ${map.unreached.length} page(s) no route renders; see the index.`)
    if (run.orphans.length > 0) lines.push(`Kept with no feature: ${run.orphans.join(', ')}`)
    if (args.check) lines.push(run.changed.length > 0 ? `Out of date: ${run.changed.join(', ')}. Run guren browser:map.` : 'Up to date.')
    else lines.push(run.changed.length > 0 ? `Wrote ${run.changed.join(', ')}.` : 'Up to date; nothing written.')
    console.log(lines.join('\n'))
  },
})

function integerArg(value: string | undefined, flag: string, max: number, unit: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new CliError(`${flag} must be ${unit} from 1 to ${max}, got ${value}.`)
  return parsed
}

export const browserServeCommand = defineCommand({
  meta: { name: 'browser:serve', description: 'Start the app for a browser verification session, refusing a database it cannot show is local (RFC 0033).' },
  args: {
    port: { type: 'string', description: 'Port to bind on 127.0.0.1 (default: a free one).' },
    'database-url': { type: 'string', description: "DATABASE_URL for the started app only; checked like the app's own." },
    timeout: { type: 'string', description: 'Seconds to wait for the app to answer (default 60).' },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    const handle = await startBrowserServe({
      cwd: args.app ?? process.cwd(),
      port: integerArg(args.port, '--port', 65_535, 'a port'),
      databaseUrl: args['database-url'],
      readyTimeoutMs: (integerArg(args.timeout, '--timeout', 3_600, 'seconds') ?? 60) * 1000,
    })
    console.log(JSON.stringify(handle.ready))
    if (!(await handle.ended)) markCommandFailed()
  },
})

function doctorLines(report: DoctorReport): string[] {
  const window = report.window.status === 'conclusive' ? 'conclusive' : `${report.window.status} (${report.window.reason})`
  const lines = [`Map: ${report.map.complete ? 'complete' : `incomplete (${report.map.gaps.map((gap) => gap.section).join(', ')})`}   Runtime errors: ${window}`, '']
  for (const check of report.features) {
    const route = check.route ? `${check.route.method} ${check.route.path}` : ''
    const detail = check.status === 'pass' ? `${check.httpStatus} ${check.component}` : check.location ? `${check.httpStatus} -> ${check.location}` : check.reason ?? ''
    lines.push(`  ${check.feature.padEnd(14)} ${check.status.padEnd(10)} ${route.padEnd(24)} ${detail}`)
    for (const event of check.events) lines.push(`      ${event.status} ${event.method} ${event.route?.pattern ?? '(no route)'}${event.frames[0] ? ` at ${event.frames[0].file}:${event.frames[0].line ?? '?'}` : ''}`)
  }
  for (const event of report.uncorrelated) lines.push(`  uncorrelated   ${event.status} ${event.method} ${event.route?.pattern ?? '(no route)'}`)
  lines.push('', `Result: ${report.result}${report.reasons.length > 0 ? `. ${report.reasons.join(' ')}` : ''}`)
  return lines
}

export const browserDoctorCommand = defineCommand({
  meta: { name: 'browser:doctor', description: 'Check that a running app serves every mapped landmark without a server error (RFC 0033).' },
  args: {
    url: { type: 'string', required: true, description: 'Loopback origin of the running app, as browser:serve prints it.' },
    json: { type: 'boolean', description: 'Print the report as JSON.' },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    let report: DoctorReport
    try {
      report = await runBrowserDoctor({ cwd: args.app ?? process.cwd(), url: args.url })
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error))
    }
    if (report.result !== 'pass') markCommandFailed()
    console.log(args.json ? JSON.stringify(report) : doctorLines(report).join('\n'))
  },
})
