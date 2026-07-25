import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  discoverModelFiles,
  discoverControllerFiles,
  fileExists,
  directoryExists,
  collectFiles,
  toPosixRelative,
  classNameFromPath,
  IMPORTABLE_EXTENSIONS,
  NON_SOURCE_DIR_NAMES,
} from './discovery'
import { matchesGlob } from './glob-match'
import { scanDocs, extractDocsTags, type DocRef } from './docs-index'
import { check, type CheckResult } from './check-result'

export interface DocsCheckOptions {
  cwd: string
  /** Restrict validation to changed docs and tags in changed source files. */
  changedFiles?: Set<string> | null
  /** Warn when `last_reviewed` is older than this many days. Off when unset. */
  ttlDays?: number
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

function hasGlobChars(entry: string): boolean {
  return entry.includes('*')
}

/**
 * Doc-link validation (RFC 0004): frontmatter `related` paths/globs must
 * resolve, `entities` must name real models, `@docs` tags in model and
 * controller sources must point at existing files, and entities whose only
 * linked docs are superseded ADRs get flagged. Activates on content — an
 * app with no docs and no tags produces zero results, so nothing goes red
 * on projects that haven't adopted the convention.
 */
export async function runDocsCheck(options: DocsCheckOptions): Promise<CheckResult[]> {
  const { cwd, changedFiles, ttlDays } = options
  const results: CheckResult[] = []

  const [refs, modelFiles, controllerFiles] = await Promise.all([
    scanDocs(cwd),
    discoverModelFiles(cwd),
    discoverControllerFiles(cwd),
  ])

  const modelNames = new Set(modelFiles.map((file) => classNameFromPath(file).toLowerCase()))

  // Lazily built once, only when some doc uses a glob: POSIX-relative
  // source-file list to match `related` globs against.
  let projectFiles: string[] | null = null
  const globMatchesSomething = async (glob: string): Promise<boolean> => {
    projectFiles ??= (await collectFiles(cwd, IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES)).map(
      (file) => toPosixRelative(cwd, file),
    )
    return projectFiles.some((file) => matchesGlob(file, glob))
  }

  const changedModelNames = changedFiles
    ? new Set(
        modelFiles
          .filter((file) => changedFiles.has(toPosixRelative(cwd, file)))
          .map((file) => classNameFromPath(file).toLowerCase()),
      )
    : null

  const docInChangedScope = (ref: DocRef): boolean => {
    if (!changedFiles) return true
    if (changedFiles.has(ref.path)) return true
    if (ref.entities.some((entity) => changedModelNames?.has(entity.toLowerCase()))) return true
    return ref.related.some((entry) =>
      hasGlobChars(entry)
        ? [...changedFiles].some((file) => matchesGlob(file, entry))
        : changedFiles.has(entry.replace(/\/$/, '')),
    )
  }

  const linkedDocs = refs.filter((ref) => ref.hasFrontmatter)

  for (const ref of linkedDocs) {
    if (!docInChangedScope(ref)) continue

    let broken = 0

    for (const entry of ref.related) {
      const resolves = hasGlobChars(entry)
        ? await globMatchesSomething(entry)
        : (await fileExists(cwd, entry)) || (await directoryExists(resolve(cwd, entry)))
      if (!resolves) {
        broken += 1
        results.push(
          check(
            `docs-related:${ref.path}:${entry}`,
            `${ref.path} → ${entry}`,
            'fail',
            `Doc references '${entry}' but nothing matches it (renamed or deleted?).`,
            `Update the 'related' entry in ${ref.path} or restore the path.`,
            ref.path,
          ),
        )
      }
    }

    for (const entity of ref.entities) {
      if (!modelNames.has(entity.toLowerCase())) {
        broken += 1
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
    }

    if (ttlDays && ttlDays > 0 && ref.lastReviewed) {
      const reviewedAt = Date.parse(ref.lastReviewed)
      if (!Number.isNaN(reviewedAt) && Date.now() - reviewedAt > ttlDays * MS_PER_DAY) {
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

    if (broken === 0 && (ref.related.length > 0 || ref.entities.length > 0)) {
      results.push(
        check(
          `docs-links:${ref.path}`,
          `${ref.path} links`,
          'pass',
          `All ${ref.related.length + ref.entities.length} link(s) resolve.`,
          undefined,
          ref.path,
        ),
      )
    }
  }

  // Entities whose only frontmatter-linked docs are superseded ADRs: the
  // entity still "has documentation", but nothing current governs it.
  const byEntity = new Map<string, DocRef[]>()
  for (const ref of linkedDocs) {
    for (const entity of ref.entities) {
      const key = entity.toLowerCase()
      if (!modelNames.has(key)) continue
      const list = byEntity.get(key) ?? []
      list.push(ref)
      byEntity.set(key, list)
    }
  }
  for (const [entityKey, docs] of byEntity) {
    const allSuperseded = docs.every((ref) => ref.status === 'superseded')
    if (allSuperseded && (!changedFiles || docs.some(docInChangedScope))) {
      results.push(
        check(
          `docs-superseded:${entityKey}`,
          `${docs[0].entities.find((e) => e.toLowerCase() === entityKey) ?? entityKey} docs`,
          'warn',
          `Every doc linked to this entity is superseded (${docs.map((d) => d.path).join(', ')}).`,
          `Write or link a current doc for the entity, or remove it from the superseded doc's 'entities'.`,
        ),
      )
    }
  }

  // Code-side @docs tags must point at existing files.
  const sourceFiles = [...modelFiles, ...controllerFiles].filter(
    (file) => !changedFiles || changedFiles.has(toPosixRelative(cwd, file)),
  )
  for (const file of sourceFiles) {
    const relPath = toPosixRelative(cwd, file)
    const source = await readFile(file, 'utf-8')
    for (const tag of extractDocsTags(source)) {
      const exists = await fileExists(cwd, tag)
      results.push(
        check(
          `docs-tag:${relPath}:${tag}`,
          `${relPath} @docs`,
          exists ? 'pass' : 'fail',
          exists ? `@docs ${tag} resolves.` : `@docs tag points at '${tag}' but the file does not exist.`,
          exists ? undefined : `Fix the @docs path in ${relPath} or restore ${tag}.`,
          relPath,
        ),
      )
    }
  }

  return results
}
