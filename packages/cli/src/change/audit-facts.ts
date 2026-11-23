/**
 * The audit facts of a change (RFC 0040 §3), from the audit of its two sides: a failure, a
 * sensitive column, a CSRF exemption, a security toggle, a suppression or a model rule's warning on
 * an edited model the base did not have, and an escalating warning on a file the change touches.
 */
import { sep } from 'node:path'

import type { AuditFinding, AuditReport } from '../audit'
import { escalatesOnChange } from '../audit-taxonomy'
import type { FactCode } from './fact-classes'
import type { ChangeFact } from './lane'
import type { ChangeReader, ChangeSide, ResolvedChange } from './resolve'

/** The model rules of `guren audit` whose warning an edit to the model can bring in: a request writing a column, or a column serialized. */
const MODEL_RULES = ['mass-assignment', 'owner-fillable', 'hidden-columns']

/** `filePath` is relative to the application root in the separators of the OS that ran the audit. */
const posixPath = (path: string): string => path.split(sep).join('/')

/**
 * What tells one finding from another across two revisions: its key, with its file as the head
 * names it. A key that ends in its line number moves with any edit above the line, so that
 * number gives way to the text of the line. A key with no line number stays whole: an exposure
 * names its model and column, and two columns of one sink share a line.
 */
async function identities(reader: ChangeReader, side: ChangeSide, findings: readonly AuditFinding[], renamed: ReadonlyMap<string, string>): Promise<string[]> {
  return Promise.all(findings.map(async (finding) => {
    let key = finding.key === 'csrf-exemption:plugin' ? `${finding.key}\n${finding.message}` : finding.key
    if (finding.filePath === undefined) return key
    const file = posixPath(finding.filePath)
    const now = side === 'base' ? (renamed.get(file) ?? file) : file
    // The file is part of the identity whatever the key holds: `mass-assignment:Post` names a class two modules may both have.
    key = `${key.split(finding.filePath).join(now).split(file).join(now)}\n${now}`
    if (finding.line === undefined || !finding.key.endsWith(`:${finding.line}`)) return key
    const text = (await reader.read(side, file))?.split('\n')[finding.line - 1]?.trim()
    return text === undefined ? key : `${key.replace(`:${finding.line}\n`, '\n')}\n${text}`
  }))
}

/** The head's findings that match no finding of the base, each base finding answering for one. */
function absentAtBase<T>(head: ReadonlyArray<{ finding: T; identity: string }>, base: readonly string[]): T[] {
  const remaining = [...base]
  return head.flatMap(({ finding, identity }) => {
    const at = remaining.indexOf(identity)
    if (at === -1) return [finding]
    remaining.splice(at, 1)
    return []
  })
}

export async function auditFacts(change: ResolvedChange, reader: ChangeReader, base: AuditReport, head: AuditReport): Promise<ChangeFact[]> {
  const renamed = new Map(change.paths.flatMap((entry) => (entry.oldPath !== undefined && !entry.outsideApp ? [[entry.oldPath, entry.path] as const] : [])))
  const touched = new Set(change.paths.filter((entry) => !entry.outsideApp && entry.status !== 'deleted').map((entry) => entry.path))
  const [baseIds, headIds] = [await identities(reader, 'base', base.findings, renamed), await identities(reader, 'head', head.findings, renamed)]
  const headFindings = head.findings.map((finding, index) => ({ finding, identity: headIds[index]! }))
  const baseWhere = (test: (finding: AuditFinding) => boolean): string[] => baseIds.filter((_, index) => test(base.findings[index]!))
  const added = (test: (finding: AuditFinding) => boolean, among: (finding: AuditFinding) => boolean): AuditFinding[] =>
    absentAtBase(headFindings.filter(({ finding }) => test(finding)), baseWhere(among))

  const facts: ChangeFact[] = []
  const claimed = new Set<AuditFinding>()
  const fact = (code: FactCode, finding: AuditFinding): void => {
    if (claimed.has(finding)) return
    claimed.add(finding)
    facts.push({
      code,
      lane: 'high',
      target: finding.key,
      files: finding.filePath === undefined ? [] : [posixPath(finding.filePath)],
      evidence: finding.evidence === 'manifest' ? 'registered' : 'static',
      message: `${finding.title}: ${finding.message}`,
    })
  }
  const reported = (finding: AuditFinding): boolean => finding.status !== 'pass'
  const startsWith = (prefix: string) => (finding: AuditFinding): boolean => finding.key.startsWith(prefix) && reported(finding)

  for (const finding of added((entry) => entry.status === 'ignored', (entry) => entry.status === 'ignored')) fact('audit-suppressed', finding)
  for (const finding of added(startsWith('exposure-sensitive-column:'), startsWith('exposure-sensitive-column:'))) fact('sensitive-exposure', finding)
  for (const finding of added(startsWith('csrf-exemption:'), startsWith('csrf-exemption:'))) fact('csrf-exemption', finding)
  for (const finding of added((entry) => entry.status === 'fail', (entry) => entry.status === 'fail')) fact('audit-fail', finding)
  for (const finding of added(startsWith('security-toggle:'), startsWith('security-toggle:'))) fact('audit-warn-changed', finding)
  // A column a model edit newly lets a request write, or newly serializes, is new even where the base warned on another;
  // one the edit takes out of a warning is not. Only for a file the change edits: a model it adds keeps its warnings.
  const edited = new Set(change.paths.filter((entry) => !entry.outsideApp && entry.status === 'modified').map((entry) => entry.path))
  const modelRule = (finding: AuditFinding): boolean => reported(finding) && MODEL_RULES.some((rule) => finding.key.startsWith(`${rule}:`))
  const baseRules = new Map<string, AuditFinding>()
  baseIds.forEach((identity, index) => { if (modelRule(base.findings[index]!)) baseRules.set(identity, base.findings[index]!) })
  for (const { finding, identity } of headFindings) {
    if (!modelRule(finding) || finding.filePath === undefined || !edited.has(posixPath(finding.filePath))) continue
    const before = baseRules.get(identity)
    if (!before || (finding.columns ?? []).some((column) => !(before.columns ?? []).includes(column))) fact('audit-warn-changed', finding)
  }
  for (const finding of head.findings) {
    if (finding.status === 'warn' && escalatesOnChange(finding.key) && finding.filePath !== undefined && touched.has(posixPath(finding.filePath))) fact('audit-warn-changed', finding)
  }
  return facts
}

const PARTIAL_KEYS = ['routes:load', 'routes:module-load:', 'csrf-scan:', 'audit-config:load']
// The rules name a reader that failed in their key: `controller-unparsed`, `ai-local-tools-unreadable`, `introspection-unavailable`.
const PARTIAL_RULE = /(?:unreadable|unparsed|unavailable|unverified)/

/** What an audit says it could not read: a rule that did not run finds nothing, which is not a pass. */
function partialSignals(report: AuditReport): string[] {
  const findings = report.findings
    .filter((finding) => finding.status !== 'pass' && (PARTIAL_KEYS.some((prefix) => finding.key.startsWith(prefix)) || PARTIAL_RULE.test(finding.key.split(':')[0]!) || (finding.key.startsWith('policy:') && finding.filePath === undefined)))
    .map((finding) => `${finding.key}: ${finding.message}`)
  const unread = (report.dataExposure?.unread ?? []).map((entry) => `a response value not followed at ${posixPath(entry.file)} (${entry.where}): ${entry.reason}`)
  return [...(report.routesAnalyzed ? [] : ['the routes did not load, so the route-level rules did not run']), ...findings, ...unread]
}

/** What the head's audit could not read that the base's could, each as the audit says it. */
export function auditCoverageGaps(base: AuditReport, head: AuditReport): string[] {
  const known = new Set(partialSignals(base))
  return partialSignals(head).filter((signal) => !known.has(signal))
}
