/**
 * `guren add review` (RFC 0040 §7, §8): the Change workflow that runs `change:evidence` on every
 * pull request and push to main, a pull request template that asks for the issue, the plan and a
 * `lane:` label, and two issue templates. Each file is written once; `--force` replaces it.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { loadScaffoldTemplate } from './scaffold-templates'
import { writeRoot, writeScaffoldFiles, type ScaffoldFileEntry, type WriterOptions } from './utils'

/** Shipped as `github/`, since a packed tarball is not trusted to keep a dot-directory. */
const REVIEW_FILES = [
  'workflows/change.yml',
  'pull_request_template.md',
  'ISSUE_TEMPLATE/feature.md',
  'ISSUE_TEMPLATE/defect.md',
] as const

export const REVIEW_LANE_LABELS = [
  { name: 'lane:low', color: '2da44e', description: 'Nothing a person had to read' },
  { name: 'lane:medium', color: 'bf8700', description: 'One person reads it' },
  { name: 'lane:high', color: 'cf222e', description: 'A careful read, or a second person' },
] as const

/** The scaffolded CI's gate step, which the Change workflow now runs as well. */
const SCAFFOLDED_GATE_STEP = /^\s*run:\s*bunx guren gate\b/m

export interface AddReviewResult {
  created: string[]
  /** `.github/workflows/ci.yml` still runs the bare gate, so it runs twice per change. */
  duplicateGate: boolean
}

export function reviewFileEntries(): ScaffoldFileEntry[] {
  return REVIEW_FILES.map((file) => ({ path: `.github/${file}`, contents: loadScaffoldTemplate(`review/github/${file}`) }))
}

export async function addReview(options: WriterOptions = {}): Promise<AddReviewResult> {
  const cwd = writeRoot(options)
  const created = await writeScaffoldFiles(reviewFileEntries(), { ...options, skipExisting: !options.force })
  const ci = await readFile(join(cwd, '.github/workflows/ci.yml'), 'utf8').catch(() => '')
  return { created, duplicateGate: SCAFFOLDED_GATE_STEP.test(ci) }
}
