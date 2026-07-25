import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { WriterOptions } from './utils'
import { safeModuleName, slugifyProse, writeFileSafe } from './utils'

const ADR_DIR = 'docs/adr'

/**
 * Matches the `NNNN-slug.md` files `make:adr` produces; anything else in the
 * directory is ignored when numbering. The extension match is case-insensitive
 * on purpose: on a case-insensitive filesystem (APFS, NTFS) a `0001-x.MD` that
 * numbering skipped would still collide with the `0001-x.md` we then try to
 * write, so such a file has to participate in the sequence.
 */
const ADR_FILE_RE = /^(\d{4})-.*\.md$/iu

/**
 * `make:adr` takes no extra options beyond the shared writer ones: `force`
 * overwrites, and `root` (wired from `--module <name>` by `toWriterOptions`
 * in bin.ts) targets `modules/<name>/docs/adr/` instead of `docs/adr/`.
 */
export type MakeAdrOptions = WriterOptions

function adrTemplate(title: string, lastReviewed: string): string {
  return `---
kind: adr
status: draft
entities: []
related: []
last_reviewed: ${lastReviewed}
---

# ${title}

## Context

<!-- What is the issue we're seeing that motivates this decision? -->

## Decision

<!-- What is the change we're making? -->

## Consequences

<!-- What becomes easier or harder because of this change? -->
`
}

/** kebab-case slug for a prose ADR title, e.g. `"Use HTTP/2 — why?"` → `use-http-2-why`. */
export function adrSlug(title: string): string {
  return slugifyProse(title, '-', 'adr')
}

/** Highest existing `NNNN-` prefix in `dir`, plus one, zero-padded to four digits. */
async function nextSequenceNumber(dir: string): Promise<string> {
  let entries: string[] = []

  try {
    entries = await readdir(resolve(process.cwd(), dir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const highest = entries.reduce((max, entry) => {
    const match = ADR_FILE_RE.exec(entry)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)

  return String(highest + 1).padStart(4, '0')
}

/** Local-calendar `YYYY-MM-DD` (not UTC, so the stamp matches the author's day). */
function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export async function makeAdr(title: string, options: MakeAdrOptions = {}): Promise<string> {
  const dir = options.root ? `modules/${safeModuleName(options.root)}/${ADR_DIR}` : ADR_DIR
  const sequence = await nextSequenceNumber(dir)

  return writeFileSafe(
    `${dir}/${sequence}-${adrSlug(title)}.md`,
    adrTemplate(title.trim(), today()),
    options,
  )
}
