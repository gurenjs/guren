import { resolve } from 'node:path'

import { defineCommand } from '../define-command'
import { declarationNote, judgeChangeLane, type ChangeFact, type ChangeLaneReport, type Lane } from '../change/lane'
import { openChange, resolveChange } from '../change/resolve'
import { REVIEW_DOC_FILE, syncReviewDoc } from '../change/review-doc'
import { policyNote, REVIEW_POLICY_FILE } from '../change/review-policy'
import { changeAdvisories } from '../change/revision-advisories'
import { loadBaseRecord } from '../change/base-record'
import { auditChangeRevisions, readHeadRecords } from '../change/revision-audit'
import { changeRecord, collectChangeEvidence, EVIDENCE_DIR, firstLine, RECORD_VERSION, redactSecrets, renderEvidenceMarkdown, writeChangeEvidence } from '../change/evidence'
import { CliError } from '../cli-error'
import { markCommandFailed } from '../command-status'

const short = (sha: string): string => sha.slice(0, 12)

function factLine(fact: ChangeFact): string {
  return `  ${fact.code}${fact.target ? ` (${fact.target})` : ''}: ${fact.message}${declarationNote(fact)}${policyNote(fact)}`
}

export function renderChangeLane(report: ChangeLaneReport): string {
  const lines = [`Change ${short(report.mergeBase)}..${short(report.head)}: floor ${report.floor}`]
  if (report.mergeBase === report.head && report.base !== report.head) lines.push('  the head is an ancestor of the base, so no commit is ahead of it: were --base and --head swapped?')
  else if (report.base !== report.mergeBase) lines.push(`  read from the merge base of ${short(report.base)} and the head`)
  if (report.policy.state === 'read') lines.push(`  ${REVIEW_POLICY_FILE} applied as the merge base has it`)
  if (report.records.stored) lines.push(`  security records compared with the base record stored for ${short(report.records.stored.head)} (@guren/cli ${report.records.stored.cli ?? 'unknown'}, @guren/server ${report.records.stored.server ?? 'unknown'})`)
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
    ...(report.facts.some((fact) => fact.declaredBy) ? ['An approved plan declares targets, not their implementation: a fact lowered by a declaration was matched by name, path and what the scaffold writes, and its body was not read.'] : []),
    ...(report.facts.some((fact) => fact.declaredBy && fact.code === 'route-added') ? ["A declared route was read off its security record, its action's authorize() call and the routes entry as written: a call asked under a condition, or an entry whose alias does not run as written, reads the same."] : []),
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
    'base-record': { type: 'string', description: "The merge base's record.json from a push run of the Change workflow, compared with where the base does not rebuild from this install." },
    audit: { type: 'boolean', default: true, description: "Audit both sides of the change, which loads the application's code. Disable with --no-audit." },
    json: { type: 'boolean', description: 'Print the evidence as JSON.' },
    routes: { type: 'string', description: 'Path to routes entry file, as `guren gate --routes` takes it.' },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    if (!args.base || !args.head) throw new CliError('change:evidence needs both --base <sha> and --head <sha>: a change is the commits between two named commits.')
    const cwd = args.app ?? process.cwd()
    const [base, head, deps] = [String(args.base), String(args.head), args.deps !== false]
    const evidence = await collectChangeEvidence({
      cwd, base, head, deps, audit: args.audit !== false,
      ...(args.routes ? { routesFile: String(args.routes) } : {}),
      ...(args['base-record'] ? { baseRecord: resolve(String(args['base-record'])) } : {}),
    })
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
    'base-record': { type: 'string', description: "The merge base's record.json from a push run of the Change workflow, compared with where the base does not rebuild from this install." },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    if (!args.base || !args.head) throw new CliError('change:lane needs both --base <sha> and --head <sha>: a change is the commits between two named commits.')
    const cwd = args.app ?? process.cwd()
    const change = await resolveChange(cwd, String(args.base), String(args.head))
    const { reader, dispose } = openChange(cwd, change)
    try {
      const report = await judgeChangeLane(change, reader, {
        ...(args.audit === false ? {} : { audit: () => auditChangeRevisions(cwd, change), headRecords: () => readHeadRecords(cwd, change) }),
        ...(args.deps === false ? {} : { advisories: (files) => changeAdvisories(cwd, change, files) }),
        ...(args['base-record'] ? { baseRecord: await loadBaseRecord(resolve(String(args['base-record'])), { mergeBase: change.mergeBase, recordVersion: RECORD_VERSION, target: 'default', environment: process.env.NODE_ENV ?? null }) } : {}),
      })
      console.log(args.json ? JSON.stringify(report) : renderChangeLane(report))
    } finally {
      await dispose()
    }
  },
})

export const changeRecordsCommand = defineCommand({
  meta: { name: 'change:records', description: "Print each route's security record (RFC 0040 §3): its middleware with their capabilities, its contract schemas and the validator exports they are, and the authorize(), can() and validate calls of its action. Introspects the application (without its env files), so its code runs; exits 1 when it cannot be read." },
  args: {
    json: { type: 'boolean', description: 'Print the records as JSON, the form change:lane compares.' },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    const cwd = resolve(args.app ?? process.cwd())
    const { readSecurityRecords } = await import('../change/security-records-read')
    const records = await readSecurityRecords(cwd)
    if ('unreadable' in records) {
      console.error(`No security records: ${records.unreadable}`)
      markCommandFailed()
      return
    }
    if (args.json) {
      console.log(JSON.stringify(records))
      return
    }
    for (const route of records.routes) {
      const guards = route.middleware.map((entry) => entry.name ?? `(inline ${entry.kind})`).join(', ') || 'no middleware'
      const action = 'unread' in route.handler ? `action not read: ${route.handler.unread}`
        : [
          ...(route.handler.authenticates ? ['auth.userOrFail()'] : []),
          ...route.handler.authorizes.map((call) => `${call.member}('${call.ability}'${call.subject ? `, ${call.subject}` : ''})`),
          ...route.handler.validates.map((call) => `${call.member}(${call.schema || 'a schema written in place'})`),
          ...(route.handler.unseen ? ['a call the reader cannot follow, compared by digest'] : []),
        ].join(', ') || 'no authentication, authorize or validate call'
      const contracts = Object.entries(route.contracts).map(([key, contract]) => `${key} ${contract.exports.join(', ') || '(no validator export)'}`).join('; ')
      console.log(`${route.method} ${route.path}${route.action ? ` → ${route.action}` : ''}\n  middleware: ${guards}\n  contracts: ${contracts || 'none'}\n  action: ${action}`)
    }
    if (records.skipped) console.log(`Introspection skipped ${records.skipped.join(', ')}: a route registered there is not listed.`)
  },
})

export const changePolicyCommand = defineCommand({
  meta: { name: 'change:policy', description: "Regenerate the block of REVIEW.md, and of .cursor/BUGBOT.md for an app that reviews with Cursor, that lists what a reviewer must read (RFC 0040 §7), and each installed agent's lessons rule, from the application as registered; --check writes nothing and exits 1 on a stale or missing file." },
  args: {
    check: { type: 'boolean', description: 'Write nothing; exit 1 when REVIEW.md, .cursor/BUGBOT.md (for Cursor) or an agent\'s lessons rule is missing or stale.' },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    const cwd = resolve(args.app ?? process.cwd())
    const result = await syncReviewDoc(cwd, { check: args.check === true })
    if (result.state === 'unreadable') {
      console.error(`${REVIEW_DOC_FILE} was not ${args.check ? 'checked' : 'written'}: the block would describe an application this run could not read.\n${result.reasons.map((reason) => `  ${reason}`).join('\n')}`)
      markCommandFailed()
      return
    }
    const refused = result.files.filter((file) => file.state === 'refused')
    if (refused.length > 0) {
      throw new CliError(`Nothing was written: ${refused.map((file) => `${file.file} cannot be rewritten as generated:\n${(file.problems ?? []).map((problem) => `  ${problem}`).join('\n')}`).join('\n')}`)
    }
    for (const file of result.files) {
      console.log({
        written: `Wrote ${file.file}.`,
        removed: `Removed ${file.file}: no stable lesson names paths any more.`,
        unchanged: `${file.file} is current.`,
        stale: `${file.file} is stale: run \`guren change:policy\`.`,
        missing: `${file.file} does not exist: run \`guren change:policy\`${file.file === REVIEW_DOC_FILE ? ' (or `guren add review`)' : ''}.`,
        refused: '',
      }[file.state])
    }
    if (result.gaps.length > 0) console.log(`The graph did not read these whole, so the block may miss routes or policies:\n${result.gaps.map((gap) => `  ${gap}`).join('\n')}`)
    if (result.files.some((file) => file.state === 'stale' || file.state === 'missing')) markCommandFailed()
  },
})
