/**
 * Keep `@guren/core`'s bump type honest about breaking changes it inherits.
 *
 * Line 1 of `packages/core/src/index.ts` is `export * from '@guren/server'`, so
 * server's whole root surface *is* core's surface. A symbol server removes is a
 * symbol core removes. Nothing in the release machinery knows that:
 * `changeset version` bumps a dependent by `updateInternalDependencies`
 * ("patch" here) and rewrites its range, but it never promotes a dependent's
 * bump type to match the dependency's.
 *
 * It has already happened. Server 2.0.0 removed `Model.guarded` and
 * `Model.strictFillable` (RFC 0006); core shipped those same removals as
 * **1.5.0**, a minor. Everyone on `@guren/core: ^1.4.0` had the break delivered
 * through a range they had every right to trust.
 *
 * So: a release plan that majors `@guren/server` must major `@guren/core` too.
 * Read from the pending `.changeset/*.md` *before* `changeset version` consumes
 * them, which is the last moment the bump type can still be corrected.
 *
 * Both release modes were driven to check that "before" is the right slot and
 * the only one needed. Outside pre mode `changeset version` deletes the `.md`,
 * so running after it would always see an empty plan — hence the position at
 * the head of `version-packages`. Inside pre mode the file survives instead
 * (`pre.json` only records which ids were consumed), so the same scan keeps
 * flagging an under-bump on every `rc` and again at pre exit. Nothing here has
 * to read `pre.json`.
 *
 * ## Why this rather than `fixed: [["@guren/server", "@guren/core"]]`
 *
 * Measured by running `changeset version` against this workspace, not read off
 * the changesets documentation:
 *
 *   - a **core-only major** drags server to 3.0.0 — a major with no content for
 *     everyone who depends on `@guren/server` directly.
 *   - a **server-only patch** moves core 1.6.2 -> 2.7.1. A fixed group snaps to
 *     its highest member, so adopting it crosses core's major line inside a
 *     release whose changelog reads "Patch Changes". Every `@guren/core: ^1.x`
 *     in the wild silently stops following, and all three first-party plugins'
 *     `gurenPlugin.compatibility: ">=1.0.0 <2.0.0"` begin throwing at
 *     `packages/cli/src/plugin.ts`.
 *
 * `fixed` is bidirectional and only one of its two directions is true. This
 * gate is that one direction, without the other.
 *
 * ## What it deliberately does not do
 *
 * There is no escape hatch. A server major confined to a subpath core does not
 * re-export (`@guren/server/lambda`, `/mcp`, `/vite` — the root barrel is a
 * named re-export list that does not reach them) would not strictly need a core
 * major, and this asks for one anyway. That is the cheaper mistake:
 * over-bumping core costs one deliberate round of range and compatibility
 * revision, during a server-major release everyone is already watching, whereas
 * under-bumping ships a silent break to `^`-pinned apps. An opt-out would have
 * to be free-form prose about which symbols moved, and CI cannot check prose —
 * that is a bypass, not a gate.
 *
 * `@guren/orm` is out of scope. Core re-exports it through an explicit named
 * allowlist (`index.ts` from line 2), so an orm major reaches core only if it
 * touches a listed name — a judgment a changeset scan cannot make.
 *
 * Exit codes: 0 clean, 1 a release plan that under-bumps core, 2 the gate could
 * not run — a changeset it cannot parse, or a `.changeset/` it cannot read. As
 * in `plugin-compat-audit.ts` and `dependency-audit.ts`, an unavailable check is
 * a failure rather than a silent pass; only a directory that reads back with no
 * changesets in it is an empty plan.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const SERVER = '@guren/server'
const CORE = '@guren/core'

export type Bump = 'major' | 'minor' | 'patch' | 'none'

const BUMPS = new Set<string>(['major', 'minor', 'patch', 'none'])

export interface ParsedChangeset {
  file: string
  releases: Map<string, Bump>
}

export interface AuditResult {
  /** 0 clean, 1 the plan under-bumps core, 2 the gate could not run. */
  code: 0 | 1 | 2
  /** Lines to print before exiting, most important first. */
  messages: string[]
}

const FRONTMATTER = /^﻿?\s*---\r?\n([\s\S]*?)\r?\n---/
const RELEASE_LINE = /^\s*(?:"([^"]*)"|'([^']*)'|([^:\s]+))\s*:\s*([A-Za-z]+)\s*$/

export class ChangesetParseError extends Error {}

/**
 * Read one changeset's frontmatter. Throws rather than skipping: a changeset
 * this script cannot read is a release plan it cannot judge, and reporting
 * "clean" over one would be exactly the silent pass the gate exists to prevent.
 */
export function parseChangeset(file: string, contents: string): ParsedChangeset {
  const frontmatter = FRONTMATTER.exec(contents)
  if (!frontmatter) {
    throw new ChangesetParseError(
      `${file}: no \`---\` frontmatter block. Every changeset opens with one listing the ` +
        'packages it releases.',
    )
  }

  const releases = new Map<string, Bump>()
  for (const line of frontmatter[1].split(/\r?\n/)) {
    if (line.trim() === '') continue
    const release = RELEASE_LINE.exec(line)
    if (!release) {
      throw new ChangesetParseError(
        `${file}: frontmatter line ${JSON.stringify(line)} is not a \`"package": bump\` entry.`,
      )
    }
    const name = release[1] ?? release[2] ?? release[3] ?? ''
    const bump = release[4].toLowerCase()
    if (!BUMPS.has(bump)) {
      throw new ChangesetParseError(
        `${file}: ${name} declares an unknown bump ${JSON.stringify(release[4])}.`,
      )
    }
    releases.set(name, bump as Bump)
  }

  return { file, releases }
}

export function auditReleasePlan(changesets: ParsedChangeset[]): AuditResult {
  const pending = changesets.length
  if (pending === 0) {
    return { code: 0, messages: ['core semver audit: no pending changesets to check.'] }
  }

  const serverMajors = changesets.filter((c) => c.releases.get(SERVER) === 'major')
  if (serverMajors.length === 0) {
    return {
      code: 0,
      messages: [`core semver audit passed: no ${SERVER} major among ${pending} pending changeset(s).`],
    }
  }

  if (changesets.some((c) => c.releases.get(CORE) === 'major')) {
    return {
      code: 0,
      messages: [
        `core semver audit passed: ${serverMajors.length} ${SERVER} major change(s), ` +
          `and the plan majors ${CORE} with them.`,
      ],
    }
  }

  // The loudest core bump in the plan, not the first one read: two changesets
  // may bump core, and naming `patch` while a `minor` sits beside it would
  // describe a release that is not the one being refused.
  const ORDER: readonly Bump[] = ['none', 'patch', 'minor', 'major']
  const declared = changesets
    .map((c) => c.releases.get(CORE))
    .filter((bump): bump is Bump => bump !== undefined)
    .sort((a, b) => ORDER.indexOf(b) - ORDER.indexOf(a))[0]

  return {
    code: 1,
    messages: [
      `core semver audit failed: this release majors ${SERVER} (${serverMajors
        .map((c) => c.file)
        .join(', ')}) but ${CORE} is ${
        declared === undefined
          ? 'not bumped at all'
          : declared === 'none'
            ? 'explicitly held at `none`'
            : `only bumped \`${declared}\``
      }.`,
      `${CORE} re-exports server's entire root surface (\`export * from '@guren/server'\` at ` +
        'packages/core/src/index.ts:1), so a server removal is a core removal. Server 2.0.0 ' +
        'shipped through core as 1.5.0 exactly this way, breaking every app on `^1.4.0`.',
      `Add a changeset declaring \`"${CORE}": major\`. Bump it even when the break sits in a ` +
        'server subpath core does not re-export: over-bumping costs one deliberate revision, ' +
        'under-bumping is delivered silently by a caret.',
    ],
  }
}

/**
 * Never answers "empty plan" for a directory it could not read. `.changeset/`
 * is tracked (`config.json`, `README.md`), so a failure here is a broken path
 * or a permission — never an empty release plan — and returning `[]` would
 * report the gate's own breakage as a clean bill of health, at exit 0, in the
 * one release where it was supposed to speak up.
 */
export async function readChangesetDirectory(dir: string): Promise<ParsedChangeset[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (cause) {
    throw new Error(
      `${dir} could not be read, so there is no release plan to judge. That directory is ` +
        'tracked in git, so this is the gate failing rather than a release with nothing in it.',
      { cause },
    )
  }

  const changesets: ParsedChangeset[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md') || entry === 'README.md') continue
    changesets.push(parseChangeset(entry, await readFile(join(dir, entry), 'utf8')))
  }
  return changesets
}

if (import.meta.main) {
  const dir = join(import.meta.dir, '..', '..', '.changeset')
  let result: AuditResult
  try {
    result = auditReleasePlan(await readChangesetDirectory(dir))
  } catch (error) {
    const messages = ['core semver audit could not run.']
    messages.push(error instanceof Error ? error.message : String(error))
    // The underlying ENOENT/EACCES, without which "could not be read" names no
    // reason a reader could act on.
    if (error instanceof Error && error.cause !== undefined) {
      messages.push(
        `  caused by: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
      )
    }
    result = { code: 2, messages }
  }

  const log = result.code === 0 ? console.log : console.error
  for (const message of result.messages) log(message)
  process.exit(result.code)
}
