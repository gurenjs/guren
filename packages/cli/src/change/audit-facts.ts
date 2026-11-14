/**
 * The audit facts of a change (RFC 0040 §3), from the audit of its two sides: a failure, a
 * sensitive column, a CSRF exemption, a security toggle or a suppression the base did not have,
 * and an escalating warning on a file the change touches.
 */
import type { AuditFinding, AuditReport } from '../audit'
import { escalatesOnChange } from '../audit-taxonomy'
import type { ChangeFact } from './lane'
import type { ChangeReader, ChangeSide, ResolvedChange } from './resolve'

const rule = (key: string): string => (key.includes(':') ? key.slice(0, key.indexOf(':')) : key)

/**
 * What tells one finding from another across two revisions. A line-anchored key names its line
 * number, which an unrelated edit above it moves, so such a finding is known by its rule, its
 * file as the head names it, and the text of the line.
 */
async function identities(reader: ChangeReader, side: ChangeSide, findings: readonly AuditFinding[], renamed: ReadonlyMap<string, string>): Promise<string[]> {
  return Promise.all(findings.map(async (finding) => {
    if (finding.filePath === undefined || finding.line === undefined) return finding.key === 'csrf-exemption:plugin' ? `${finding.key}\n${finding.message}` : finding.key
    const text = (await reader.read(side, finding.filePath))?.split('\n')[finding.line - 1]?.trim()
    const file = side === 'base' ? (renamed.get(finding.filePath) ?? finding.filePath) : finding.filePath
    return text === undefined ? finding.key : `${rule(finding.key)}\n${file}\n${text}`
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
      files: finding.filePath === undefined ? [] : [finding.filePath],
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
    if (finding.status === 'warn' && escalatesOnChange(finding.key) && finding.filePath !== undefined && touched.has(finding.filePath)) fact('audit-warn-changed', finding)
  }
  return facts
}
