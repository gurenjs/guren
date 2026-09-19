import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const TEST_BASELINE = { rev: '6445bc71', contextHash: { 'model.post': 'ab12' } }

/** A fresh object per call, so a test may mutate what it gets. */
export function loadCommentsPlan(): Record<string, unknown> {
  const text = readFileSync(join(import.meta.dir, 'fixtures/plan/comments.plan.json'), 'utf8')
  return JSON.parse(text) as Record<string, unknown>
}
