/**
 * The audit facts of a change (RFC 0040 §3), from the audit of its two sides: a failure, a
 * sensitive column, a CSRF exemption, a security toggle or a suppression the base did not have,
 * and an escalating warning on a file the change touches.
 */
import { sep } from 'node:path'

import type { AuditFinding, AuditReport } from '../audit'
import { escalatesOnChange } from '../audit-taxonomy'
import type { ChangeFact } from './lane'
import type { ChangeReader, ChangeSide, ResolvedChange } from './resolve'

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
    key = key.split(finding.filePath).join(now).split(file).join(now)
    if (finding.line === undefined || !finding.key.endsWith(`:${finding.line}`)) return key
    const text = (await reader.read(side, file))?.split('\n')[finding.line - 1]?.trim()
    return text === undefined ? key : `${key.slice(0, -`:${finding.line}`.length)}\n${text}`
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
  const fact = (code: string, finding: AuditFinding): void => {
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
  for (const finding of head.findings) {
    if (finding.status === 'warn' && escalatesOnChange(finding.key) && finding.filePath !== undefined && touched.has(posixPath(finding.filePath))) fact('audit-warn-changed', finding)
  }
  return facts
}

const PARTIAL_KEYS = ['routes:load', 'routes:module-load:', 'introspection-unavailable', 'controller-unreadable:', 'controller-unparsed:', 'csrf-scan:', 'audit-config:load']

/** What an audit says it could not read: a rule that did not run finds nothing, which is not a pass. */
function partialSignals(report: AuditReport): string[] {
  const findings = report.findings
    .filter((finding) => finding.status !== 'pass' && (PARTIAL_KEYS.some((prefix) => finding.key.startsWith(prefix)) || (finding.key.startsWith('policy:') && finding.filePath === undefined)))
    .map((finding) => `${finding.key}: ${finding.message}`)
  const unread = (report.dataExposure?.unread ?? []).map((entry) => `a response value not followed at ${posixPath(entry.file)} (${entry.where}): ${entry.reason}`)
  return [...(report.routesAnalyzed ? [] : ['the routes did not load, so the route-level rules did not run']), ...findings, ...unread]
}

/** What the head's audit could not read that the base's could, each as the audit says it. */
export function auditCoverageGaps(base: AuditReport, head: AuditReport): string[] {
  const known = new Set(partialSignals(base))
  return partialSignals(head).filter((signal) => !known.has(signal))
}
