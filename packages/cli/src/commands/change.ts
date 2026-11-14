import { defineCommand } from '../define-command'
import { judgeChangeLane, type ChangeFact, type ChangeLaneReport, type Lane } from '../change/lane'
import { openChange, resolveChange } from '../change/resolve'
import { auditChangeRevisions } from '../change/revision-audit'
import { CliError } from '../cli-error'

const short = (sha: string): string => sha.slice(0, 12)

function factLine(fact: ChangeFact): string {
  return `  ${fact.code}${fact.target ? ` (${fact.target})` : ''}: ${fact.message}`
}

export function renderChangeLane(report: ChangeLaneReport): string {
  const lines = [`Change ${short(report.mergeBase)}..${short(report.head)}: floor ${report.floor}`]
  if (report.mergeBase === report.head && report.base !== report.head) lines.push('  the head is an ancestor of the base, so no commit is ahead of it: were --base and --head swapped?')
  else if (report.base !== report.mergeBase) lines.push(`  read from the merge base of ${short(report.base)} and the head`)
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
  lines.push('', 'What this rests on without checking', ...trustBoundary(report).map((line) => `  ${line}`))
  return lines.join('\n')
}

/** RFC 0040 §13, built from what this run did: it never names a check the run skipped. */
function trustBoundary(report: ChangeLaneReport): string[] {
  return [
    'The floor guards against mistakes. It does not stop an author who writes code to defeat it.',
    'Facts are lower bounds: a fact that did not appear has not proved the code unchanged.',
    ...(report.audited ? ["The audit loaded the code of both commits under this shell's environment, so it is no evidence about a change that attacks the runner."] : []),
  ]
}

export const changeLaneCommand = defineCommand({
  meta: { name: 'change:lane', description: "Print the facts of a change and the review lane they set as a floor (RFC 0040). Reads git objects and, to audit both commits, loads the application's code; writes nothing in the repository." },
  args: {
    base: { type: 'string', description: 'The commit the change is measured against, by SHA; the merge base with --head is what is read.' },
    head: { type: 'string', description: 'The last commit of the change, by SHA.' },
    json: { type: 'boolean', description: 'Print the report as JSON.' },
    // Positive on purpose, so citty's negation lands on this key; `default: true` prints `--no-audit`.
    audit: { type: 'boolean', default: true, description: "Audit both sides of the change, which runs the application's code as `guren audit` does. Disable with --no-audit." },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    if (!args.base || !args.head) throw new CliError('change:lane needs both --base <sha> and --head <sha>: a change is the commits between two named commits.')
    const cwd = args.app ?? process.cwd()
    const change = await resolveChange(cwd, String(args.base), String(args.head))
    const { reader, dispose } = openChange(cwd, change)
    try {
      const report = await judgeChangeLane(change, reader, args.audit === false ? {} : { audit: () => auditChangeRevisions(cwd, change, reader) })
      console.log(args.json ? JSON.stringify(report) : renderChangeLane(report))
    } finally {
      await dispose()
    }
  },
})
