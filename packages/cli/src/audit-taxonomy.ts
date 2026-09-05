/**
 * Standard security classifications for audit findings (RFC 0007). Versioned,
 * because OWASP Top 10 2021 and 2025 number their categories differently.
 */

export interface AuditClassification {
  standard: 'OWASP Top 10' | 'OWASP API Security' | 'CWE'
  /** Standard edition ('2021', '2023'); absent for CWE ids. */
  version?: string
  id: string
  name?: string
}

function owasp(id: string, name: string): AuditClassification {
  return { standard: 'OWASP Top 10', version: '2021', id, name }
}

function owaspApi(id: string, name: string): AuditClassification {
  return { standard: 'OWASP API Security', version: '2023', id, name }
}

function cwe(id: string, name: string): AuditClassification {
  return { standard: 'CWE', id, name }
}

/**
 * Rule classifications, keyed by finding-key prefix (`authz:`, `secret:`, …).
 * Infrastructure findings (routes:load, audit-config:*) carry none. CWE pairings
 * follow the official OWASP Top 10 2021 CWE mapping where one exists.
 */
const RULE_CLASSIFICATIONS: Record<string, AuditClassification[]> = {
  validation: [owasp('A03', 'Injection'), cwe('CWE-20', 'Improper Input Validation')],
  authz: [
    owasp('A01', 'Broken Access Control'),
    cwe('CWE-306', 'Missing Authentication for Critical Function'),
  ],
  secret: [
    owasp('A07', 'Identification and Authentication Failures'),
    cwe('CWE-798', 'Use of Hard-coded Credentials'),
  ],
  'raw-sql': [owasp('A03', 'Injection'), cwe('CWE-89', 'SQL Injection')],
  'request-host-url': [
    owasp('A07', 'Identification and Authentication Failures'),
    cwe('CWE-640', 'Weak Password Recovery Mechanism for Forgotten Password'),
  ],
  'security-toggle': [
    owasp('A05', 'Security Misconfiguration'),
    cwe('CWE-693', 'Protection Mechanism Failure'),
  ],
  'csrf-exemption': [
    owasp('A01', 'Broken Access Control'),
    cwe('CWE-352', 'Cross-Site Request Forgery'),
  ],
  'mass-assignment': [
    owaspApi('API3', 'Broken Object Property Level Authorization'),
    cwe('CWE-915', 'Improperly Controlled Modification of Dynamically-Determined Object Attributes'),
  ],
  'force-write-request-data': [
    owaspApi('API3', 'Broken Object Property Level Authorization'),
    cwe('CWE-915', 'Improperly Controlled Modification of Dynamically-Determined Object Attributes'),
  ],
  'hidden-columns': [
    owaspApi('API3', 'Broken Object Property Level Authorization'),
    cwe('CWE-200', 'Exposure of Sensitive Information to an Unauthorized Actor'),
  ],
  /**
   * Agent-tool annotations that contradict the action behind them (RFC 0016).
   * Its own prefix rather than a shared `agent:` bucket: `classifyFindingKey`
   * slices at the first `:`, so one prefix carries one classification.
   */
  'agent-annotation': [
    owaspApi('API9', 'Improper Inventory Management'),
    cwe('CWE-684', 'Incorrect Provision of Specified Functionality'),
  ],
  deps: [
    owasp('A06', 'Vulnerable and Outdated Components'),
    cwe('CWE-1395', 'Dependency on Vulnerable Third-Party Component'),
  ],
}

export function classifyFindingKey(key: string): AuditClassification[] | undefined {
  const prefix = key.slice(0, key.indexOf(':'))
  return RULE_CLASSIFICATIONS[prefix]
}

/**
 * The id shown in console output — the first non-CWE classification, since
 * `[A01]` reads better than a CWE number in a terminal line.
 */
export function primaryClassificationId(
  classifications: AuditClassification[] | undefined,
): string | undefined {
  return classifications?.find((c) => c.standard !== 'CWE')?.id
}
