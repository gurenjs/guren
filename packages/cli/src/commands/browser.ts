import { defineCommand } from '../define-command'
import { markCommandFailed } from '../command-status'
import { runBrowserMap } from '../browser-map-files'

export const browserMapCommand = defineCommand({
  meta: { name: 'browser:map', description: 'Write the browser verification feature map under docs/browser/ from the application graph (RFC 0033).' },
  args: {
    check: { type: 'boolean', description: 'Exit 1 when a generated block differs from what a run would write; write nothing.' },
    json: { type: 'boolean', description: 'Print the map model as JSON.' },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    const run = await runBrowserMap({ cwd: args.app ?? process.cwd(), write: !args.check })
    const { map } = run
    const failed = args.check ? run.changed.length > 0 : !map.complete || map.unreadablePlans.length > 0
    if (failed) markCommandFailed()
    if (args.json) {
      console.log(JSON.stringify({ ...map, changed: run.changed, orphans: run.orphans }))
      return
    }
    const lines: string[] = []
    if (!map.complete) lines.push(`The feature set may be incomplete: ${map.gaps.map((gap) => gap.section).join(', ')}. Each document says why.`)
    for (const entry of map.unreadablePlans) lines.push(`Plan not read: ${entry.plan}: ${entry.reason}`)
    lines.push(`${map.features.length} feature(s): ${map.features.map((feature) => feature.name).join(', ') || 'none'}`)
    if (map.unassigned.length > 0) lines.push(`${map.unassigned.length} route(s) in no feature, ${map.unreached.length} page(s) no route renders; see the index.`)
    if (run.orphans.length > 0) lines.push(`Kept with no feature: ${run.orphans.join(', ')}`)
    if (args.check) lines.push(run.changed.length > 0 ? `Out of date: ${run.changed.join(', ')}. Run guren browser:map.` : 'Up to date.')
    else lines.push(run.changed.length > 0 ? `Wrote ${run.changed.join(', ')}.` : 'Up to date; nothing written.')
    console.log(lines.join('\n'))
  },
})
