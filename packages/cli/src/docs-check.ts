import { readFile } from 'node:fs/promises'
import {
  discoverModelFiles,
  discoverControllerFiles,
  fileExists,
  collectAllFiles,
  toPosixRelative,
  classNameFromPath,
} from './discovery'
import { matchesGlob } from './glob-match'
import { parseModelFile } from './model-parser'
import { scanDocs, extractDocsTags, buildEntityDocIndex, type DocRef } from './docs-index'
import type { ParseCache } from './parse-cache'
import { check, type CheckResult } from './check-result'

export interface DocsCheckOptions {
  cwd: string
  /** Restrict validation to changed docs and tags in changed source files. */
  changedFiles?: Set<string> | null
  /** Warn when `last_reviewed` is older than this many days. Off when unset. */
  ttlDays?: number
  /** Reuses sources already read by the surrounding `runCheck`, when present. */
  cache?: ParseCache
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

function hasGlobChars(entry: string): boolean {
  return entry.includes('*')
}

/**
 * Doc links are app-root-relative by convention; absolute paths and `..`
 * segments would validate files outside the project.
 */
function isAppRootRelative(entry: string): boolean {
  return !entry.startsWith('/') && !/^[A-Za-z]:/.test(entry) && !entry.split('/').includes('..')
}

/** Calendar-day difference, treating both sides as dates (not instants). */
function daysSince(isoDate: string): number | null {
  const reviewedAt = Date.parse(isoDate)
  if (Number.isNaN(reviewedAt)) return null
  const now = new Date()
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.floor((todayUtc - reviewedAt) / MS_PER_DAY)
}

const MODEL_FILE_PATTERN = /(?:^|\/)app\/Models\/[^/]+\.(?:ts|mts|js|mjs)$/

/**
 * Doc-link validation (RFC 0004): frontmatter `related` paths/globs must
 * resolve, `entities` must name real models, `@docs` tags in model and
 * controller sources must point at existing files, and entities whose only
 * linked docs are superseded get flagged. Activates on content — an app
 * with no docs and no tags produces zero results, so nothing goes red on
 * projects that haven't adopted the convention.
 */
export async function runDocsCheck(options: DocsCheckOptions): Promise<CheckResult[]> {
  const { cwd, changedFiles, ttlDays, cache } = options
  const results: CheckResult[] = []

  const [refs, modelFiles, controllerFiles] = await Promise.all([
    scanDocs(cwd),
    discoverModelFiles(cwd),
    discoverControllerFiles(cwd),
  ])

  // Lowercased name → canonical class name, parsed from model sources (the
  // same identity `guren context <Entity>` resolves against); filename is
  // the fallback for unparsable files.
  const parsedModels = await Promise.all(modelFiles.map((file) => parseModelFile(file)))
  const modelNames = new Map(
    parsedModels.map((info, index) => {
      const className = info?.className ?? classNameFromPath(modelFiles[index])
      return [className.toLowerCase(), className] as const
    }),
  )

  // Lazily built once, only when some doc uses a glob. Holds the promise so
  // concurrent glob entries share one scan.
  let projectFilesPromise: Promise<string[]> | null = null
  const globMatchesSomething = async (glob: string): Promise<boolean> => {
    projectFilesPromise ??= collectAllFiles(cwd).then((files) =>
      files.map((file) => toPosixRelative(cwd, file)),
    )
    return (await projectFilesPromise).some((file) => matchesGlob(file, glob))
  }

  const entryResolves = async (entry: string): Promise<boolean> => {
    if (!isAppRootRelative(entry)) return false
    // `fileExists` is access()-based, so it accepts directories too.
    return hasGlobChars(entry) ? globMatchesSomething(entry) : fileExists(cwd, entry)
  }

  // --changed scoping. Entity names are derived from changed *paths* (not
  // the discovered file list) so a deleted model still pulls the docs that
  // referenced it into scope and fails their dangling `entities:` links.
  const changedList = changedFiles ? [...changedFiles] : null
  const changedModelNames = changedList
    ? new Set(
        changedList
          .filter((path) => MODEL_FILE_PATTERN.test(path))
          .map((path) => classNameFromPath(path).toLowerCase()),
      )
    : null

  const docInChangedScope = (ref: DocRef): boolean => {
    if (!changedList) return true
    if (changedFiles!.has(ref.path)) return true
    if (ref.entities.some((entity) => changedModelNames!.has(entity.toLowerCase()))) return true
    return ref.related.some((entry) => {
      if (hasGlobChars(entry)) return changedList.some((file) => matchesGlob(file, entry))
      const normalized = entry.replace(/\/$/, '')
      // A directory target is in scope when anything beneath it changed.
      return changedList.some((file) => file === normalized || file.startsWith(`${normalized}/`))
    })
  }

  const docsWithFrontmatter = refs.filter((ref) => ref.hasFrontmatter)
  const inScope = new Set(docsWithFrontmatter.filter(docInChangedScope).map((ref) => ref.path))

  for (const ref of docsWithFrontmatter) {
    if (!inScope.has(ref.path)) continue

    const relatedChecks = await Promise.all(
      ref.related.map(async (entry) => ({ entry, ok: await entryResolves(entry) })),
    )
    const brokenRelated = relatedChecks.filter((result) => !result.ok).map((result) => result.entry)
    const brokenEntities = ref.entities.filter((entity) => !modelNames.has(entity.toLowerCase()))

    for (const entry of brokenRelated) {
      const escapes = !isAppRootRelative(entry)
      results.push(
        check(
          `docs-related:${ref.path}:${entry}`,
          `${ref.path} → ${entry}`,
          'fail',
          escapes
            ? `Doc references '${entry}', which is not app-root-relative.`
            : `Doc references '${entry}' but nothing matches it (renamed or deleted?).`,
          `Update the 'related' entry in ${ref.path}${escapes ? ' to an app-root-relative path' : ' or restore the path'}.`,
          ref.path,
        ),
      )
    }

    for (const entity of brokenEntities) {
      results.push(
        check(
          `docs-entity:${ref.path}:${entity}`,
          `${ref.path} → ${entity}`,
          'fail',
          `Doc lists entity '${entity}' but no such model exists.`,
          `Fix the 'entities' entry in ${ref.path} or add the model.`,
          ref.path,
        ),
      )
    }

    if (ttlDays && ttlDays > 0 && ref.lastReviewed) {
      const age = daysSince(ref.lastReviewed)
      if (age !== null && age > ttlDays) {
        results.push(
          check(
            `docs-stale:${ref.path}`,
            `${ref.path} freshness`,
            'warn',
            `last_reviewed (${ref.lastReviewed}) is older than ${ttlDays} days.`,
            `Re-read ${ref.path}, update it if needed, and bump last_reviewed.`,
            ref.path,
          ),
        )
      }
    }

    const totalLinks = ref.related.length + ref.entities.length
    if (totalLinks > 0 && brokenRelated.length === 0 && brokenEntities.length === 0) {
      results.push(
        check(
          `docs-links:${ref.path}`,
          `${ref.path} links`,
          'pass',
          `All ${totalLinks} link(s) resolve.`,
          undefined,
          ref.path,
        ),
      )
    }
  }

  // Entities whose only frontmatter-linked docs are superseded: the entity
  // still "has documentation", but nothing current governs it.
  for (const [entityKey, docs] of buildEntityDocIndex(docsWithFrontmatter)) {
    const canonicalName = modelNames.get(entityKey)
    if (!canonicalName) continue
    const allSuperseded = docs.every((ref) => ref.status === 'superseded')
    if (allSuperseded && docs.some((ref) => inScope.has(ref.path))) {
      results.push(
        check(
          `docs-superseded:${canonicalName}`,
          `${canonicalName} docs`,
          'warn',
          `Every doc linked to this entity is superseded (${docs.map((d) => d.path).join(', ')}).`,
          `Write or link a current doc for the entity, or remove it from the superseded doc's 'entities'.`,
        ),
      )
    }
  }

  // Code-side @docs tags must point at existing files inside the app root.
  const sourceFiles = [...modelFiles, ...controllerFiles].filter(
    (file) => !changedFiles || changedFiles.has(toPosixRelative(cwd, file)),
  )
  const sources = await Promise.all(
    sourceFiles.map(async (file) => ({
      relPath: toPosixRelative(cwd, file),
      source: (await cache?.get(file))?.source ?? (await readFile(file, 'utf-8')),
    })),
  )
  for (const { relPath, source } of sources) {
    for (const tag of extractDocsTags(source)) {
      const key = `docs-tag:${relPath}:${tag}`
      const title = `${relPath} @docs`
      if (isAppRootRelative(tag) && (await fileExists(cwd, tag))) {
        results.push(check(key, title, 'pass', `@docs ${tag} resolves.`, undefined, relPath))
      } else {
        results.push(
          check(
            key,
            title,
            'fail',
            `@docs tag points at '${tag}' but no such file exists inside the app root.`,
            `Fix the @docs path in ${relPath} or restore ${tag}.`,
            relPath,
          ),
        )
      }
    }
  }

  return results
}
