/**
 * Acceptance ids on both sides of the docs graph (RFC 0030 §7, the docs graph): a document
 * cites one in parentheses, `… (AC-comments-4)`, and a test carries it in brackets,
 * `test('[AC-comments-4] …')`. The id grammar is `isAcceptanceId()`, and the test side is
 * {@link readBracketedTokenFiles}, the one reader `plan:verify` selects test files with too.
 */

import { readFile } from 'node:fs/promises'

import { discoverTestFiles, toPosixRelative } from './discovery'
import { markdownLines, stripMarkdownCode } from './docs-links'
import { collectionName, collectionSlug } from './inflect'
import { kebabCase } from './utils'
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
  const cited = new Set<string>()
  for (const match of stripMarkdownCode(body).matchAll(CITATION_GROUP)) {
    const entries = match[1].split(',').map((entry) => entry.trim())
    if (entries.every(isAcceptanceId)) for (const entry of entries) cited.add(entry)
  }
  return [...cited]
}

/**
 * Token → the files, app-relative and sorted, whose source carries it as a bracketed token,
 * for the tokens `accept` takes. A file that will not read carries nothing.
 */
export async function readBracketedTokenFiles(root: string, files: readonly string[], accept: (token: string) => boolean): Promise<Map<string, string[]>> {
  const byToken = new Map<string, string[]>()
  for (const file of files) {
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const relative = toPosixRelative(root, file)
    for (const token of new Set(bracketedTokens(source))) {
      if (accept(token)) byToken.set(token, [...(byToken.get(token) ?? []), relative])
    }
  }
  for (const list of byToken.values()) list.sort()
  return byToken
}

/** Every acceptance id a test file under `cwd` carries as a bracketed token, sorted by id. */
export async function scanAcceptanceTests(cwd: string): Promise<AcceptanceTestRef[]> {
  const byId = await readBracketedTokenFiles(cwd, await discoverTestFiles(cwd), isAcceptanceId)
  return [...byId.entries()]
    .map(([id, files]) => ({ id, files }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/**
 * The test scan the docs graph and `check --docs` share: run at most once, and only when a
 * document cites an id, so an app without the convention never reads its test tree.
 */
export function acceptanceTestsLoader(cwd: string, refs: ReadonlyArray<{ citations: readonly string[] }>): () => Promise<AcceptanceTestRef[]> {
  let loaded: Promise<AcceptanceTestRef[]> | undefined
  return () => {
    loaded ??= refs.some((ref) => ref.citations.length > 0) ? scanAcceptanceTests(cwd) : Promise.resolve([])
    return loaded
  }
}

/**
 * The names an id may lead with for `entity`, lowercased: its class name and collection (`comments`
 * for `Comment`, the spelling the plan's ids use), each as written and kebab-cased.
 */
function entityIdNames(entity: string): string[] {
  const collection = collectionName(entity)
  return [...new Set([entity, collection, kebabCase(entity), collectionSlug(entity)].map((name) => name.toLowerCase()))]
}

/**
 * The entity an id names, or `undefined`. The grammar (`isAcceptanceId()`) has no entity segment: a
 * plan's id names its task, `AC-<collection>[-<task>]-<n>`, and the task names the entity, so the
 * entity is the one whose name the id leads with as whole dash-separated segments, the longest one
 * winning (`AC-post-comments-1` names `PostComment` over `Post`).
 */
export function acceptanceIdEntity(id: string, entities: Iterable<string>): string | undefined {
  if (!isAcceptanceId(id)) return undefined
  const lower = id.toLowerCase()
  let best: { entity: string; length: number } | undefined
  for (const entity of entities) {
    for (const name of entityIdNames(entity)) {
      const prefix = `ac-${name}-`
      if (lower.length > prefix.length && lower.startsWith(prefix) && name.length > (best?.length ?? 0)) best = { entity, length: name.length }
    }
  }
  return best?.entity
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
  for (const line of markdownLines(body).lines) {
    if (line.inFence) continue
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line.text)
    if (heading) {
      if (heading[1].length <= 2) inRules = heading[1].length === 2 && RULES_HEADINGS.includes(heading[2])
      continue
    }
    const item = inRules ? /^\s*[-*+]\s+(.+)$/u.exec(line.text) : null
    if (item && extractAcceptanceCitations(item[1]).length === 0) uncited.push(item[1].trim())
  }
  return uncited
}
