import { defineReviewPolicy } from '@guren/cli/review'

// `guren change:lane` reads this from the merge base as data and never runs it: write every value in place.
// Add `review: { reviewer: 'claude-code-review' }` (or 'bugbot') to name the reviewer a low change waits on.
export default defineReviewPolicy({
  approvals: { low: 0, medium: 1, high: 2 },
  identities: 'auto',
  merge: { low: 'person' },
})
