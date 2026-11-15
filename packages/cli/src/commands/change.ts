import { resolve } from 'node:path'

import { defineCommand } from '../define-command'
import { judgeChangeLane, type ChangeFact, type ChangeLaneReport, type Lane } from '../change/lane'
import { openChange, resolveChange } from '../change/resolve'
import { syncReviewDoc } from '../change/review-doc'
import { policyNote, REVIEW_POLICY_FILE } from '../change/review-policy'
import { changeAdvisories } from '../change/revision-advisories'
import { auditChangeRevisions } from '../change/revision-audit'
import { changeRecord, collectChangeEvidence, EVIDENCE_DIR, firstLine, redactSecrets, renderEvidenceMarkdown, writeChangeEvidence } from '../change/evidence'
import { CliError } from '../cli-error'
import { markCommandFailed } from '../command-status'

const short = (sha: string): string => sha.slice(0, 12)

function factLine(fact: ChangeFact): string {
  return `  ${fact.code}${fact.target ? ` (${fact.target})` : ''}: ${fact.message}${policyNote(fact)}`
}

export function renderChangeLane(report: ChangeLaneReport): string {
  const lines = [`Change ${short(report.mergeBase)}..${short(report.head)}: floor ${report.floor}`]
  if (report.mergeBase === report.head && report.base !== report.head) lines.push('  the head is an ancestor of the base, so no commit is ahead of it: were --base and --head swapped?')
  else if (report.base !== report.mergeBase) lines.push(`  read from the merge base of ${short(report.base)} and the head`)
  if (report.policy.state === 'read') lines.push(`  ${REVIEW_POLICY_FILE} applied as the merge base has it`)
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
    ...(report.policy.state === 'read' ? [`${REVIEW_POLICY_FILE} was read from the merge base, where a person merged it; an edit to it in this change applies only once merged.`] : []),
    ...(report.audit.loadedCode ? ["The audit loaded the application's code at the commits it exported, under this shell's environment, so it is no evidence about a change that attacks the runner."] : []),
  ]
}

export const changeEvidenceCommand = defineCommand({
  meta: { name: 'change:evidence', description: "Run the gate as `guren gate --deps` does and write the change's evidence, record and job summary (RFC 0040 §4). Fails exactly when the gate fails." },
  args: {
    base: { type: 'string', description: 'The commit the change is measured against, by SHA.' },
    head: { type: 'string', description: 'The last commit of the change, by SHA; the checkout should be at it.' },
    output: { type: 'string', alias: 'o', description: `Directory for evidence.json, record.json and evidence.md (default ${EVIDENCE_DIR}, which ignores itself).` },
    // Positive on purpose, so citty's negation lands on this key; `default: true` prints `--no-deps`.
    deps: { type: 'boolean', default: true, description: "Scan dependencies in the gate's audit stage, as `guren gate --deps` does (needs registry access). Disable with --no-deps." },
    audit: { type: 'boolean', default: true, description: "Audit both sides of the change, which loads the application's code. Disable with --no-audit." },
    json: { type: 'boolean', description: 'Print the evidence as JSON.' },
    routes: { type: 'string', description: 'Path to routes entry file, as `guren gate --routes` takes it.' },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    if (!args.base || !args.head) throw new CliError('change:evidence needs both --base <sha> and --head <sha>: a change is the commits between two named commits.')
    const cwd = args.app ?? process.cwd()
    const [base, head, deps] = [String(args.base), String(args.head), args.deps !== false]
    const evidence = await collectChangeEvidence({ cwd, base, head, deps, audit: args.audit !== false, ...(args.routes ? { routesFile: String(args.routes) } : {}) })
    // `-o` is from where the command runs, as a workflow step names it; the default is the application's own.
    const target = args.output ? resolve(String(args.output)) : resolve(cwd, EVIDENCE_DIR)
    let written: string | undefined
    try {
      written = await writeChangeEvidence(cwd, target, evidence, await changeRecord(cwd, base, head, evidence, deps))
    } catch (error) {
      // Nothing but the gate fails this command: a file it could not write is said, never an exit code.
      console.error(redactSecrets(`The evidence could not be written to ${target}: ${firstLine(error)}`))
    }
    if (args.json) console.log(redactSecrets(JSON.stringify(evidence)))
    else console.log(redactSecrets(`${renderEvidenceMarkdown(evidence)}${written ? `\nWritten to ${written}` : ''}`))
    if (!evidence.gate.ok) markCommandFailed()
  },
})

export const changeLaneCommand = defineCommand({
  meta: { name: 'change:lane', description: "Print the facts of a change and the review lane they set as a floor (RFC 0040). Reads git objects and, to audit both commits, loads the application's code; writes nothing in the repository." },
  args: {
    base: { type: 'string', description: 'The commit the change is measured against, by SHA; the merge base with --head is what is read.' },
    head: { type: 'string', description: 'The last commit of the change, by SHA.' },
    json: { type: 'boolean', description: 'Print the report as JSON.' },
    // Positive on purpose, so citty's negation lands on this key; `default: true` prints `--no-audit`.
    audit: { type: 'boolean', default: true, description: "Audit both sides of the change, which runs the application's code as `guren audit` does. Disable with --no-audit." },
    deps: { type: 'boolean', default: true, description: "Run `bun audit` on both sides' lockfiles when the change touches dependencies (needs registry access). Disable with --no-deps." },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    if (!args.base || !args.head) throw new CliError('change:lane needs both --base <sha> and --head <sha>: a change is the commits between two named commits.')
    const cwd = args.app ?? process.cwd()
    const change = await resolveChange(cwd, String(args.base), String(args.head))
    const { reader, dispose } = openChange(cwd, change)
    try {
      const report = await judgeChangeLane(change, reader, {
        ...(args.audit === false ? {} : { audit: () => auditChangeRevisions(cwd, change) }),
        ...(args.deps === false ? {} : { advisories: (files) => changeAdvisories(cwd, change, files) }),
      })
      console.log(args.json ? JSON.stringify(report) : renderChangeLane(report))
    } finally {
      await dispose()
    }
  },
})

export const changePolicyCommand = defineCommand({
  meta: { name: 'change:policy', description: "Regenerate the block of REVIEW.md that lists what a reviewer must read (RFC 0040 §7), from the application as registered; --check writes nothing and exits 1 on a stale or missing block." },
  args: {
    check: { type: 'boolean', description: 'Write nothing; exit 1 when REVIEW.md is missing or its block is stale.' },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    const cwd = resolve(args.app ?? process.cwd())
    const result = await syncReviewDoc(cwd, { check: args.check === true })
    if (result.state === 'refused') {
      throw new CliError(`${result.file} has guren:review markers that cannot be rewritten safely, so nothing was written:\n${result.problems.map((problem) => `  ${problem}`).join('\n')}`)
    }
    if (result.state === 'unreadable') {
      console.error(`${result.file} was not ${args.check ? 'checked' : 'written'}: the block would describe an application this run could not read.\n${result.reasons.map((reason) => `  ${reason}`).join('\n')}`)
      markCommandFailed()
      return
    }
    const said = {
      written: `Wrote ${result.file}.`,
      unchanged: `${result.file} is current.`,
      stale: `${result.file} is stale: run \`guren change:policy\`.`,
      missing: `${result.file} does not exist: run \`guren change:policy\` (or \`guren add review\`).`,
    }[result.state]
    console.log(said)
    if (result.gaps.length > 0) console.log(`The graph did not read these whole, so the block may miss routes or policies:\n${result.gaps.map((gap) => `  ${gap}`).join('\n')}`)
    if (result.state === 'stale' || result.state === 'missing') markCommandFailed()
  },
})
