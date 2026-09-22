/**
 * Acceptance ids on both sides of the docs graph (RFC 0030 §7, the docs graph): a document
 * cites one in parentheses, `… (AC-comments-4)`, and a test carries it in brackets,
 * `test('[AC-comments-4] …')`. The id grammar is `isAcceptanceId()`, the one `plan:verify`
 * reads undeclared ids with, and the test side is `bracketedTokens()`, the scan
 * `plan:verify` selects test files by.
 */

import { readFile } from 'node:fs/promises'

import { discoverTestFiles, toPosixRelative } from './discovery'
import { collectionName } from './inflect'
import { bracketedTokens, isAcceptanceId } from './plan/acceptance-status'

export interface AcceptanceTestRef {
  id: string
  /** App-relative, POSIX separators, sorted. */
  files: string[]
}

// A parenthesized group whose every comma-separated entry is an id: `(AC-a-1)`, `(AC-a-1, AC-a-2)`.
const CITATION_GROUP = /\(([^()\n]+)\)/gu

/** The ids a markdown body cites, in first-seen order. Code spans and fences cite nothing. */
export function extractAcceptanceCitations(body: string): string[] {
  const withoutCode = body.replace(/```[\s\S]*?```/gu, '').replace(/`[^`\n]*`/gu, '')
  const cited = new Set<string>()
  for (const match of withoutCode.matchAll(CITATION_GROUP)) {
    const entries = match[1].split(',').map((entry) => entry.trim())
    if (entries.every(isAcceptanceId)) for (const entry of entries) cited.add(entry)
  }
  return [...cited]
}

/** Every acceptance id a test file under `cwd` carries as a bracketed token, sorted by id. */
export async function scanAcceptanceTests(cwd: string): Promise<AcceptanceTestRef[]> {
  const byId = new Map<string, Set<string>>()
  for (const file of await discoverTestFiles(cwd)) {
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const token of bracketedTokens(source)) {
      if (!isAcceptanceId(token)) continue
      const files = byId.get(token) ?? new Set<string>()
      files.add(toPosixRelative(cwd, file))
      byId.set(token, files)
    }
  }
  return [...byId.entries()]
    .map(([id, files]) => ({ id, files: [...files].sort() }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/** The `<entity>` segment of `AC-<entity>-<n>`, or `undefined` for an id of another shape. */
export function acceptanceIdSegment(id: string): string | undefined {
  return /^AC-(.+)-[^-]+$/u.exec(id)?.[1]
}

/**
 * Whether an id's segment names `entity`: its collection (`comments` for `Comment`, the
 * spelling the plan's ids use) or the class name itself, case-insensitively.
 */
export function acceptanceIdNamesEntity(id: string, entity: string): boolean {
  const segment = acceptanceIdSegment(id)?.toLowerCase()
  if (segment === undefined) return false
  return segment === entity.toLowerCase() || segment === collectionName(entity).toLowerCase()
}

/** The `## ` heading a rules section goes under, per plan locale; `plan:close` writes these words. */
export const RULES_HEADING_BY_LOCALE = { en: 'Rules', ja: 'ルール' } as const
const RULES_HEADINGS: readonly string[] = Object.values(RULES_HEADING_BY_LOCALE)

/**
 * List items under a rules heading that cite no acceptance id. A rule states behaviour the
 * code must have, and one no test verifies is a claim nothing checks.
 */
export function extractUncitedRules(body: string): string[] {
  const uncited: string[] = []
  let inRules = false
  let inFence = false
  for (const line of body.split(/\r?\n/u)) {
    if (/^\s*```/u.test(line)) inFence = !inFence
    if (inFence) continue
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line)
    if (heading) {
      if (heading[1].length <= 2) inRules = heading[1].length === 2 && RULES_HEADINGS.includes(heading[2])
      continue
    }
    const item = inRules ? /^\s*[-*+]\s+(.+)$/u.exec(line) : null
    if (item && extractAcceptanceCitations(item[1]).length === 0) uncited.push(item[1].trim())
  }
  return uncited
}
