/**
 * `guren.review.ts` (RFC 0040 §3), published as `@guren/cli/review`. The file is read as data,
 * never run: `change:lane` reads the object literal from the merge base's git objects, so every
 * value has to be written in place, with no spread, variable or call inside it.
 */
import type { Lane, ReviewableFactCode } from '../change/fact-classes'

export type { Lane, ReviewableFactCode } from '../change/fact-classes'

export type ReviewGlobs = string | string[]

/** A reviewer the lane job reads by its check run (§8). */
export type ReviewReviewer = 'claude-code-review' | 'bugbot' | { check: string; app: string; conclusion: string }

export interface ReviewPolicy {
  /** Approvals each lane needs where someone other than the author can approve. */
  approvals?: Partial<Record<Lane, number>>
  /** Globs relative to the application root; a changed path matching one sets the floor to at least that lane. */
  paths?: { high?: ReviewGlobs; medium?: ReviewGlobs }
  /** A fact's lane. Raising is always allowed; lowering only a declarable fact, to the lane a declaration gives. */
  facts?: Partial<Record<ReviewableFactCode, Lane>>
  review?: { reviewer: ReviewReviewer; timeoutMinutes?: number }
  identities?: 'auto' | 'several' | 'one-owner'
  merge?: { low?: 'lane-job' | 'person' }
}

// Not generic: an inferred type parameter skips the excess-property check that catches a misspelt key.
export function defineReviewPolicy(policy: ReviewPolicy): ReviewPolicy {
  return policy
}
