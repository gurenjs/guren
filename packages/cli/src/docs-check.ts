import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
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
  /** Reuses sources already read by the surrounding `runCheck`, when present. */
  cache?: ParseCache
}

function hasGlobChars(entry: string): boolean {
  return entry.includes('*')
}

/**
 * Backslashes count as separators, and a drive letter is absolute: on
 * Windows `path.resolve` treats them that way, so a `..\..\outside.md`
 * examined with `/` rules alone would slip past containment and resolve
 * outside the app root. Both containment checks below start here so
 * they cannot disagree about what a separator is.
 */
function normalizeTarget(target: string): { path: string; absolute: boolean } {
  const path = target.replace(/\\/g, '/')
  return { path, absolute: path.startsWith('/') || /^[A-Za-z]:/.test(path) }
}

/**
 * Doc links are app-root-relative by convention; absolute paths and `..`
 * segments would validate files outside the project.
 */
function isAppRootRelative(entry: string): boolean {
  const { path, absolute } = normalizeTarget(entry)
  return !absolute && !path.split('/').includes('..')
}

/**
 * The `docs/` bundle a document belongs to, with a trailing slash — the
 * root for its bundle-relative (`/…`) links. Matched structurally rather
 * than by searching for `docs/`, which would find the wrong segment in a
 * module named e.g. `apidocs`.
 */
function bundleRoot(docPath: string): string {
  return /^(?:modules\/[^/]+\/)?docs\//.exec(docPath)?.[0] ?? ''
}

/** OKF §5.4 lifecycle values. */
const DOC_STATUSES = new Set(['draft', 'stable', 'deprecated'])

/**
 * OKF §7 actor forms: `human:<id>`, `process:<id>`, or
 * `<producer>/<version>` for agents and tools.
 */
function isOkfActor(actor: string): boolean {
  return /^(?:human:|process:).+/.test(actor) || /^[^/]+\/.+/.test(actor)
}

/**
 * A real `YYYY-MM-DD` calendar date. `Date.parse` alone would accept
 * `2026-02-30` (rolled forward to March 2) and reject nothing loudly,
 * so the round-trip check rejects out-of-range days.
 */
function parseCalendarDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const time = Date.parse(value)
  if (Number.isNaN(time)) return null
  return new Date(time).toISOString().slice(0, 10) === value ? time : null
}

/**
 * OKF §5.5: content is stale when `today >= stale_after`. An absolute
 * date keeps this a plain comparison.
 */
function isStale(staleAt: number): boolean {
  const now = new Date()
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) >= staleAt
}

const MODEL_FILE_PATTERN = /(?:^|\/)app\/Models\/[^/]+\.(?:ts|mts|js|mjs)$/

/**
 * Resolve a body markdown link to an app-root-relative path. A leading
 * `/` is bundle-relative (OKF §6.1): it resolves from the doc's own
 * `docs/` root, so `/adr/0002-x.md` in `docs/adr/0001-y.md` means
 * `docs/adr/0002-x.md` and module docs stay within their module's
 * bundle. Anything else is relative to the doc's directory and may
 * reach into the app (`../../app/...`). Null when the target escapes
 * the app root.
 */
export function resolveDocLink(docPath: string, target: string): string | null {
  const { path } = normalizeTarget(target)
  if (/^[A-Za-z]:/.test(path)) return null

  // A leading `/` is bundle-relative, so it is resolved rather than
  // rejected — the one place the two containment checks legitimately
  // differ.
  const fromBundleRoot = path.startsWith('/')
  const base = fromBundleRoot ? bundleRoot(docPath) : posix.dirname(docPath)
  const joined = posix.join(base, fromBundleRoot ? path.slice(1) : path)
  return joined === '..' || joined.startsWith('../') ? null : joined
}

/**
 * Doc-link validation (RFC 0004): docs are OKF concept documents, so
 * frontmatter must carry `type` (the one field OKF requires), body
 * markdown links (OKF's relation mechanism) must resolve, frontmatter
 * `related` paths/globs must resolve, `entities` must name real models,
 * `@docs` tags in model and controller sources must point at existing
 * files, and entities whose only linked docs are superseded get flagged.
 * Activates on content — an app with no docs and no tags produces zero
 * results, so nothing goes red on projects that haven't adopted the
 * convention.
 */
export async function runDocsCheck(options: DocsCheckOptions): Promise<CheckResult[]> {
  const { cwd, changedFiles, cache } = options
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

  // Docs cross-link the same hub pages, so the same path is probed many
  // times per run; the promise is cached so each becomes one access().
  const existsCache = new Map<string, Promise<boolean>>()
  const exists = (path: string): Promise<boolean> => {
    let hit = existsCache.get(path)
    if (!hit) {
      // `fileExists` is access()-based, so it accepts directories too.
      hit = fileExists(cwd, path)
      existsCache.set(path, hit)
    }
    return hit
  }

  const entryResolves = async (entry: string): Promise<boolean> => {
    if (!isAppRootRelative(entry)) return false
    return hasGlobChars(entry) ? globMatchesSomething(entry) : exists(entry)
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
    const targetChanged = (path: string): boolean => {
      const normalized = path.replace(/\/$/, '')
      if (changedFiles!.has(normalized)) return true
      // A directory target is in scope when anything beneath it changed.
      return changedList.some((file) => file.startsWith(`${normalized}/`))
    }
    if (
      ref.related.some((entry) =>
        hasGlobChars(entry)
          ? changedList.some((file) => matchesGlob(file, entry))
          : targetChanged(entry),
      )
    ) {
      return true
    }
    return ref.links.some((target) => {
      const resolved = resolveDocLink(ref.path, target)
      return resolved !== null && targetChanged(resolved)
    })
  }

  const docsWithFrontmatter = refs.filter((ref) => ref.hasFrontmatter)
  const inScope = new Set(docsWithFrontmatter.filter(docInChangedScope).map((ref) => ref.path))

  for (const ref of docsWithFrontmatter) {
    if (!inScope.has(ref.path)) continue

    if (!ref.type) {
      results.push(
        check(
          `docs-type:${ref.path}`,
          `${ref.path} type`,
          'fail',
          `Doc has frontmatter but no 'type' — the one field OKF requires.`,
          `Add a 'type:' field (adr, context, guide, spec, …) to ${ref.path}.`,
          ref.path,
        ),
      )
    }

    const relatedChecks = await Promise.all(
      ref.related.map(async (entry) => ({
        entry,
        rooted: isAppRootRelative(entry),
        ok: await entryResolves(entry),
      })),
    )
    const brokenRelated = relatedChecks.filter((result) => !result.ok)
    const brokenEntities = ref.entities.filter((entity) => !modelNames.has(entity.toLowerCase()))

    const linkChecks = await Promise.all(
      ref.links.map(async (target) => {
        const resolved = resolveDocLink(ref.path, target)
        return { target, resolved, ok: resolved !== null && (await exists(resolved)) }
      }),
    )
    const brokenLinks = linkChecks.filter((result) => !result.ok)

    // A missing target is a warn, not a fail: OKF §6.1 treats a broken
    // link as possibly not-yet-written knowledge, not as malformed. A
    // link that escapes the app root is malformed and fails.
    for (const { target, resolved } of brokenLinks) {
      const escapes = resolved === null
      results.push(
        check(
          `docs-link:${ref.path}:${target}`,
          `${ref.path} → ${target}`,
          escapes ? 'fail' : 'warn',
          escapes
            ? `Doc links to '${target}', which escapes the app root.`
            : `Doc links to '${target}' but no such file exists (renamed, deleted, or not written yet?).`,
          `Fix the markdown link in ${ref.path}${escapes ? '' : ', restore the target, or write the missing doc'}.`,
          ref.path,
        ),
      )
    }

    for (const { entry, rooted } of brokenRelated) {
      const escapes = !rooted
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

    // Provenance is only as trustable as its actors: consumers derive
    // the trust tier from the `human:` prefix (§5.3), so an actor
    // written outside the §7 convention silently reads as a machine.
    const actorEvents = [
      ...(ref.generated ? [{ field: 'generated', event: ref.generated }] : []),
      ...ref.verified.map((event, index) => ({
        field: ref.verified.length === 1 ? 'verified' : `verified[${index}]`,
        event,
      })),
    ]
    for (const { field, event } of actorEvents) {
      if (event.by === undefined || !isOkfActor(event.by)) {
        results.push(
          check(
            `docs-actor:${ref.path}:${field}.by`,
            `${ref.path} ${field}.by`,
            'warn',
            event.by === undefined
              ? `${field} has no 'by' — OKF records who acted on every ${field} entry.`
              : `${field}.by '${event.by}' is not an OKF actor (human:<id>, process:<id>, or <producer>/<version>), so trust tiers keyed off the 'human:' prefix cannot recognize a person written this way.`,
            `Write the actor in ${ref.path} using one of the OKF §7 forms.`,
            ref.path,
          ),
        )
      }
      if (event.at !== undefined && Number.isNaN(Date.parse(event.at))) {
        results.push(
          check(
            `docs-actor:${ref.path}:${field}.at`,
            `${ref.path} ${field}.at`,
            'warn',
            `${field}.at '${event.at}' is not a parseable timestamp, so freshness comparisons skip it.`,
            `Write ${field}.at in ${ref.path} as an ISO 8601 date or datetime.`,
            ref.path,
          ),
        )
      }
    }

    if (ref.status !== undefined && !DOC_STATUSES.has(ref.status)) {
      results.push(
        check(
          `docs-status:${ref.path}`,
          `${ref.path} status`,
          'warn',
          `status '${ref.status}' is outside the OKF lifecycle values (draft, stable, deprecated).`,
          `Use one of draft | stable | deprecated in ${ref.path}, or drop the field (absent means stable).`,
          ref.path,
        ),
      )
    }

    // Presence, not truthiness: an empty `stale_after:` is a malformed
    // date, and skipping it would let the doc claim a freshness policy
    // the checker never enforces.
    if (ref.staleAfter !== undefined) {
      const staleAt = parseCalendarDate(ref.staleAfter)
      if (staleAt === null) {
        // A date the checker cannot read would silently never fire, so
        // the doc would claim a freshness policy it does not have.
        results.push(
          check(
            `docs-stale-after:${ref.path}`,
            `${ref.path} stale_after`,
            'warn',
            `stale_after '${ref.staleAfter}' is not a calendar date, so freshness is never checked.`,
            `Write stale_after as YYYY-MM-DD in ${ref.path}.`,
            ref.path,
          ),
        )
      } else if (isStale(staleAt)) {
        results.push(
          check(
            `docs-stale:${ref.path}`,
            `${ref.path} freshness`,
            'warn',
            `stale_after (${ref.staleAfter}) has passed — the doc declares its content stale.`,
            `Re-read ${ref.path}, update it if needed, and move stale_after forward (or remove it).`,
            ref.path,
          ),
        )
      }
    }

    const totalLinks = ref.related.length + ref.entities.length + ref.links.length
    if (
      totalLinks > 0
      && brokenRelated.length === 0
      && brokenEntities.length === 0
      && brokenLinks.length === 0
    ) {
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

  // OKF conformance (§11) asks every non-reserved doc to carry
  // frontmatter with a `type`. Only warn, and only once the app has
  // adopted the convention — a project with zero frontmatter docs stays
  // silent, preserving the activates-on-content principle.
  if (docsWithFrontmatter.length > 0) {
    for (const ref of refs) {
      if (ref.hasFrontmatter) continue
      if (changedFiles && !changedFiles.has(ref.path)) continue
      results.push(
        check(
          `docs-frontmatter:${ref.path}`,
          `${ref.path} frontmatter`,
          'warn',
          `Doc has no frontmatter, so it is not an OKF concept document and never links to anything.`,
          `Add a frontmatter block with at least a 'type:' field to ${ref.path}.`,
          ref.path,
        ),
      )
    }
  }

  // Entities whose only frontmatter-linked docs are deprecated: the entity
  // still "has documentation", but nothing current governs it.
  for (const [entityKey, docs] of buildEntityDocIndex(docsWithFrontmatter)) {
    const canonicalName = modelNames.get(entityKey)
    if (!canonicalName) continue
    const allDeprecated = docs.every((ref) => ref.status === 'deprecated')
    if (allDeprecated && docs.some((ref) => inScope.has(ref.path))) {
      results.push(
        check(
          `docs-deprecated:${canonicalName}`,
          `${canonicalName} docs`,
          'warn',
          `Every doc linked to this entity is deprecated (${docs.map((d) => d.path).join(', ')}).`,
          `Write or link a current doc for the entity, or remove it from the deprecated doc's 'entities'.`,
        ),
      )
    }
  }

  // Code-side @docs tags must point at existing files inside the app root.
  const sourceFiles = [...modelFiles, ...controllerFiles].filter(
    (file) => !changedFiles || changedFiles.has(toPosixRelative(cwd, file)),
  )
  // Source, not AST: a `@docs` tag lives in a comment, so a file the parser
  // rejects still has tags worth validating.
  const sources = await Promise.all(
    sourceFiles.map(async (file) => ({
      relPath: toPosixRelative(cwd, file),
      source: cache ? await cache.source(file) : await readFile(file, 'utf-8').catch(() => null),
    })),
  )
  for (const { relPath, source } of sources) {
    if (source === null) continue
    for (const tag of extractDocsTags(source)) {
      const key = `docs-tag:${relPath}:${tag}`
      const title = `${relPath} @docs`
      if (isAppRootRelative(tag) && (await exists(tag))) {
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
