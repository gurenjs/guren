import { resolve } from 'node:path'

import { defineCommand } from '../define-command'
import { markCommandFailed } from '../command-status'
import { runBrowserMap } from '../browser-map-files'
import { startBrowserServe } from '../browser-serve'
import { runBrowserDoctor, type DoctorReport } from '../browser-doctor'
import { beginRun, closeStep, openStep, readRun, writeDoctorEvidence, type RecordDeps } from '../browser-record'
import { loadApplicationGraph } from '../application-graph-load'
import { runGit } from '../changed-files'
import { readJsonWithinLimit, recoverStdinDash } from '../plan/feedback'
import { fetchRuntimeErrors } from '../runtime-errors'
import { CliError } from '../cli-error'

export const browserMapCommand = defineCommand({
  meta: { name: 'browser:map', description: 'Write the browser verification feature map under docs/browser/ from the application graph, and the generated specs once guren add browser-tests has run (RFC 0033).' },
  args: {
    check: { type: 'boolean', description: 'Write nothing; exit 1 when a generated block differs from what a run would write, as well as on an incomplete map.' },
    json: { type: 'boolean', description: 'Print the map model as JSON.' },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    const run = await runBrowserMap({ cwd: args.app ?? process.cwd(), write: !args.check })
    const { map } = run
    const stale = [...run.changed, ...run.removed]
    const failed = !map.complete || map.unreadablePlans.length > 0 || (args.check === true && stale.length > 0)
    if (failed) markCommandFailed()
    if (args.json) {
      console.log(JSON.stringify({ ...map, changed: run.changed, orphans: run.orphans, removed: run.removed, ...(run.specsHeld ? { specsHeld: run.specsHeld } : {}), ...(run.accessibilityOff ? { accessibilityOff: run.accessibilityOff } : {}) }))
      return
    }
    const lines: string[] = []
    if (!map.complete) lines.push(`The feature set may be incomplete: ${map.gaps.map((gap) => gap.section).join(', ')}. The index says why.`)
    for (const entry of map.unreadablePlans) lines.push(`Plan not read: ${entry.plan}: ${entry.reason}`)
    lines.push(`${map.features.length} feature(s): ${map.features.map((feature) => feature.name).join(', ') || 'none'}`)
    if (map.unassigned.length > 0) lines.push(`${map.unassigned.length} route(s) in no feature, ${map.unreached.length} page(s) no route renders; see the index.`)
    if (run.orphans.length > 0) lines.push(`Kept with no feature: ${run.orphans.join(', ')}`)
    if (args.check) lines.push(stale.length > 0 ? `Out of date: ${stale.join(', ')}. Run guren browser:map.` : run.specsHeld ? 'The documents are up to date.' : 'Up to date.')
    else {
      lines.push(run.changed.length > 0 ? `Wrote ${run.changed.join(', ')}.` : 'Up to date; nothing written.')
      if (run.removed.length > 0) lines.push(`Removed generated specs nothing produces any more: ${run.removed.join(', ')}.`)
    }
    if (run.specsHeld) lines.push(`The generated specs were left as they are: ${run.specsHeld}.`)
    if (run.accessibilityOff) lines.push(`Accessibility checks are off: ${run.accessibilityOff}. Run guren add browser-tests again to add them.`)
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
    evidence: { type: 'string', description: 'Also write the report as doctor.json into this browser:record run.' },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    const cwd = resolve(args.app ?? process.cwd())
    // Before the doctor runs, so a mistyped run fails at once rather than after the whole check.
    if (args.evidence) await readRun(cwd, args.evidence)
    let report: DoctorReport
    try {
      report = await runBrowserDoctor({ cwd, url: args.url })
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error))
    }
    if (report.result !== 'pass') markCommandFailed()
    console.log(args.json ? JSON.stringify(report) : doctorLines(report).join('\n'))
    if (args.evidence) await writeDoctorEvidence(cwd, args.evidence, report)
  },
})

function recordDeps(cwd: string): RecordDeps {
  return {
    readErrors: fetchRuntimeErrors,
    graphSnapshot: async () => {
      try {
        return (await loadApplicationGraph({ cwd, introspect: true })).snapshot.id
      } catch {
        return null
      }
    },
    commit: async () => {
      const rev = await runGit(cwd, ['rev-parse', 'HEAD'])
      const status = await runGit(cwd, ['status', '--porcelain', '--', '.'])
      return rev?.[0] && status ? { rev: rev[0], dirty: status.length > 0 } : null
    },
    now: () => new Date(),
  }
}

export const browserRecordCommand = defineCommand({
  meta: { name: 'browser:record', description: 'Write the evidence of a browser verification run: begin a run, open a step, close it with what was observed (RFC 0033).' },
  args: {
    run: { type: 'positional', required: false, description: 'The run browser:record --begin printed.' },
    begin: { type: 'boolean', description: 'Start a run against --url for --feature.' },
    url: { type: 'string', description: 'With --begin: the loopback origin under test.' },
    feature: { type: 'string', description: 'With --begin: the feature the run verifies.' },
    step: { type: 'string', description: 'An acceptance id or charter slug.' },
    open: { type: 'boolean', description: 'Take the runtime-error head for --step.' },
    close: { type: 'boolean', description: 'Record --step from --input.' },
    input: { type: 'string', description: 'With --close: a JSON file, or - for standard input.' },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args, rawArgs }) {
    const cwd = resolve(args.app ?? process.cwd())
    const deps = recordDeps(cwd)
    if (args.begin) {
      if (!args.url || !args.feature) throw new CliError('browser:record --begin needs --url and --feature.')
      const run = await beginRun(cwd, { url: args.url, feature: args.feature }, deps)
      console.log(JSON.stringify({ run: run.run }))
      return
    }
    if (!args.run || !args.step || args.open === args.close) {
      throw new CliError('Use browser:record --begin --url <origin> --feature <name>, or browser:record <run> --step <id> with exactly one of --open and --close.')
    }
    if (args.open) {
      await openStep(cwd, args.run, args.step, deps)
      console.log(JSON.stringify({ run: args.run, step: args.step, open: true }))
      return
    }
    const input = recoverStdinDash(args.input, 'input', rawArgs)
    if (!input) throw new CliError('browser:record --close needs --input <file|->.')
    const { document } = await readJsonWithinLimit(input, { cwd, what: 'step input' })
    const step = await closeStep(cwd, args.run, args.step, document, deps)
    if (step.result !== 'pass') markCommandFailed()
    console.log(JSON.stringify(step))
  },
})
