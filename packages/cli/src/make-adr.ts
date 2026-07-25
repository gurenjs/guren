import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { consola } from 'consola'

import type { WriterOptions } from './utils'
import { safeModuleName, slugifyProse, writeFileSafe } from './utils'
import {
  discoverModelFiles,
  discoverControllerFiles,
  discoverResourceFiles,
  discoverPolicyFiles,
  classNameFromPath,
  toPosixRelative,
} from './discovery'
import { parseModelFile } from './model-parser'

const ADR_DIR = 'docs/adr'

/**
 * Matches the `NNNN-slug.md` files `make:adr` produces; anything else in the
 * directory is ignored when numbering. The extension match is case-insensitive
 * on purpose: on a case-insensitive filesystem (APFS, NTFS) a `0001-x.MD` that
 * numbering skipped would still collide with the `0001-x.md` we then try to
 * write, so such a file has to participate in the sequence.
 */
const ADR_FILE_RE = /^(\d{4})-.*\.md$/iu

export interface MakeAdrOptions extends WriterOptions {
  /**
   * Model class name (case-insensitive) to prefill `entities:` with; its
   * companion controller/resource/policy files prefill `related:`.
   */
  entity?: string
}

interface AdrPrefill {
  entities: string[]
  related: string[]
}

const EMPTY_PREFILL: AdrPrefill = { entities: [], related: [] }

/**
 * Prefill for `--entity`: the canonical class name plus the entity's
 * companion files as `related:` entries. A model that doesn't exist yet is
 * prefilled as given — ADR-first flows write the decision before the code,
 * and `guren check --docs` failing until the model lands is the intended
 * "implementation missing" signal.
 */
async function resolveAdrPrefill(entity: string, moduleName?: string): Promise<AdrPrefill> {
  const cwd = process.cwd()
  const modelFiles = await discoverModelFiles(cwd)
  const parsed = await Promise.all(modelFiles.map((file) => parseModelFile(file)))
  const lower = entity.toLowerCase()
  const matches = parsed.flatMap((info, index) =>
    info && info.className.toLowerCase() === lower
      ? [{ className: info.className, file: modelFiles[index] }]
      : [],
  )
  // When scaffolding into a module, that module's model wins a name tie.
  const match =
    matches.find(
      (m) => moduleName && toPosixRelative(cwd, m.file).startsWith(`modules/${moduleName}/`),
    ) ?? matches[0]

  if (!match) {
    consola.warn(
      `Model "${entity}" not found — prefilled entities anyway; \`guren check --docs\` will fail until the model exists.`,
    )
    return { entities: [entity], related: [] }
  }

  const related: string[] = []
  const companions: Array<[(root: string) => Promise<string[]>, string]> = [
    [discoverControllerFiles, `${match.className}Controller`],
    [discoverResourceFiles, `${match.className}Resource`],
    [discoverPolicyFiles, `${match.className}Policy`],
  ]
  for (const [discover, companionName] of companions) {
    const file = (await discover(cwd)).find((f) => classNameFromPath(f) === companionName)
    if (file) related.push(toPosixRelative(cwd, file))
  }

  return { entities: [match.className], related }
}

function adrTemplate(title: string, lastReviewed: string, prefill: AdrPrefill): string {
  const entities =
    prefill.entities.length > 0 ? `entities: [${prefill.entities.join(', ')}]` : 'entities: []'
  const related =
    prefill.related.length > 0
      ? `related:\n${prefill.related.map((path) => `  - ${path}`).join('\n')}`
      : 'related: []'

  return `---
kind: adr
status: draft
${entities}
${related}
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
  const moduleName = options.root ? safeModuleName(options.root) : undefined
  const dir = moduleName ? `modules/${moduleName}/${ADR_DIR}` : ADR_DIR
  const prefill = options.entity ? await resolveAdrPrefill(options.entity, moduleName) : EMPTY_PREFILL
  const sequence = await nextSequenceNumber(dir)

  return writeFileSafe(
    `${dir}/${sequence}-${adrSlug(title)}.md`,
    adrTemplate(title.trim(), today(), prefill),
    options,
  )
}
