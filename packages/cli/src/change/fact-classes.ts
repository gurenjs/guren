/**
 * Every fact code a change can carry (RFC 0040 §3) and the lowest lane `guren.review.ts` may set
 * it to. `ChangeFact.code` is typed from this table, so a reader that emits a code missing here
 * does not compile. Imports nothing: the `@guren/cli/review` subpath reads its types.
 */
export type Lane = 'low' | 'medium' | 'high'

export type FactKind =
  /** The floor the rest stands on: never lowered. */
  | 'always-high'
  /** A plan's declaration may lower it, so the policy may too, to the lane a declaration gives. */
  | 'declarable'
  /** Low already. */
  | 'ambient'
  /** Medium whatever a plan or the policy says (§3: edits to existing source stay medium). */
  | 'fixed'
  /** Written by the policy itself. */
  | 'policy'

export const FACT_CLASSES = {
  'plan-record': { kind: 'always-high', lowest: 'high' },
  'gate-input': { kind: 'always-high', lowest: 'high' },
  'migration-destructive': { kind: 'always-high', lowest: 'high' },
  'acceptance-changed': { kind: 'always-high', lowest: 'high' },
  'test-removed': { kind: 'always-high', lowest: 'high' },
  'policy-removed': { kind: 'always-high', lowest: 'high' },
  'audit-suppressed': { kind: 'always-high', lowest: 'high' },
  'audit-fail': { kind: 'always-high', lowest: 'high' },
  'sensitive-exposure': { kind: 'always-high', lowest: 'high' },
  'csrf-exemption': { kind: 'always-high', lowest: 'high' },
  'audit-warn-changed': { kind: 'always-high', lowest: 'high' },
  // Not emitted until the route graph and the declaration matcher ship; named so a policy can raise them now.
  'route-added': { kind: 'declarable', lowest: 'low' },
  'route-changed': { kind: 'declarable', lowest: 'low' },
  'route-removed': { kind: 'declarable', lowest: 'low' },
  'agent-tool': { kind: 'declarable', lowest: 'low' },
  'migration': { kind: 'declarable', lowest: 'low' },
  'schema-changed': { kind: 'declarable', lowest: 'low' },
  'policy-added': { kind: 'declarable', lowest: 'low' },
  'file-added': { kind: 'declarable', lowest: 'low' },
  'policy-changed': { kind: 'declarable', lowest: 'medium' },
  'dependencies-changed': { kind: 'declarable', lowest: 'medium' },
  'ambient': { kind: 'ambient', lowest: 'low' },
  'test-added': { kind: 'ambient', lowest: 'low' },
  'acceptance-added': { kind: 'fixed', lowest: 'medium' },
  'source-edited': { kind: 'fixed', lowest: 'medium' },
  'source-removed': { kind: 'fixed', lowest: 'medium' },
  'source-renamed': { kind: 'fixed', lowest: 'medium' },
  'outside-app': { kind: 'fixed', lowest: 'medium' },
  'lesson': { kind: 'fixed', lowest: 'medium' },
  'review-path': { kind: 'policy', lowest: 'medium' },
} as const satisfies Record<string, { kind: FactKind; lowest: Lane }>

export type FactCode = keyof typeof FACT_CLASSES

/** The codes a policy's `facts` may name: every one but the policy's own. */
export type ReviewableFactCode = Exclude<FactCode, 'review-path'>

export const LANES: readonly Lane[] = ['low', 'medium', 'high']

export const laneRank = (lane: Lane): number => LANES.indexOf(lane)
