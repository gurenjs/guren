/**
 * One planned property's verdict (RFC 0030 §6), and the constructors every reader of `plan:status`
 * builds one with: `status.ts` and `field-status.ts` both import them, so the shape has one home.
 */

export type PlanPropertyVerdict = 'match' | 'differ' | 'unknown'

export interface PlanPropertyStatus {
  property: string
  verdict: PlanPropertyVerdict
  planned?: string
  /** What the reader found, on `match` and `differ`. */
  actual?: string
  /** Why the property could not be compared, on `unknown`. */
  reason?: string
  /** A match on existence alone (a key a schema declares, an ability a policy names), which `restsOnReach()` does not count. */
  existence?: true
}

export const match = (property: string, planned: string, actual = planned): PlanPropertyStatus => ({ property, verdict: 'match', planned, actual })
export const differ = (property: string, planned: string, actual: string): PlanPropertyStatus => ({ property, verdict: 'differ', planned, actual })
export const unknown = (property: string, planned: string, reason: string): PlanPropertyStatus => ({ property, verdict: 'unknown', planned, reason })

/** A `match` that says only that the planned name exists, not that it holds the planned shape or rule. */
export const existenceMatch = (property: string, planned: string): PlanPropertyStatus => ({ ...match(property, planned), existence: true })
