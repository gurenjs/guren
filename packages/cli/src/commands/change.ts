import { defineCommand } from '../define-command'
import { judgeChangeLane, type ChangeFact, type ChangeLaneReport, type Lane } from '../change/lane'
import { openChange, resolveChange } from '../change/resolve'
import { CliError } from '../cli-error'

const short = (sha: string): string => sha.slice(0, 12)

function factLine(fact: ChangeFact): string {
  return `  ${fact.code}${fact.target ? ` (${fact.target})` : ''}: ${fact.message}`
}

export function renderChangeLane(report: ChangeLaneReport): string {
  const lines = [`Change ${short(report.mergeBase)}..${short(report.head)}: floor ${report.floor}`]
  if (report.base !== report.mergeBase) lines.push(`  read from the merge base of ${short(report.base)} and the head`)
  if (report.facts.length === 0) lines.push('', 'No path changed.')
  for (const lane of ['high', 'medium', 'low'] satisfies Lane[]) {
    const facts = report.facts.filter((fact) => fact.lane === lane)
    if (facts.length > 0) lines.push('', lane, ...facts.map(factLine))
  }
  if (report.unjudged.length > 0) {
    lines.push('', 'Not judged', ...report.unjudged.map((entry) => `  ${entry.reader} (${entry.lane}): ${entry.reason}`))
  }
  if (report.plans.length > 0) {
    lines.push('', 'Plans at the head', ...report.plans.map((plan) => `  ${plan.file}: ${plan.standing}${plan.hash ? ` at ${short(plan.hash)}` : ''}`))
  }
  return lines.join('\n')
}

export const changeLaneCommand = defineCommand({
  meta: { name: 'change:lane', description: 'Print the facts of a change and the review lane they set as a floor (RFC 0040). Reads git objects; writes nothing.' },
  args: {
    base: { type: 'string', description: 'The commit the change is measured against, by SHA; the merge base with --head is what is read.' },
    head: { type: 'string', description: 'The last commit of the change, by SHA.' },
    json: { type: 'boolean', description: 'Print the report as JSON.' },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    if (!args.base || !args.head) throw new CliError('change:lane needs both --base <sha> and --head <sha>: a change is the commits between two named commits.')
    const cwd = args.app ?? process.cwd()
    const change = await resolveChange(cwd, String(args.base), String(args.head))
    const { reader, dispose } = openChange(cwd, change)
    try {
      const report = await judgeChangeLane(change, reader)
      console.log(args.json ? JSON.stringify(report) : renderChangeLane(report))
    } finally {
      await dispose()
    }
  },
})
