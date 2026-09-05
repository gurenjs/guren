// oxlint-disable-next-line guren/comment-length -- every line is a measured `changeset version` result that .claude/rules/common-pitfalls.md sends readers here for
/**
 * Keep `@guren/core`'s bump type honest about breaking changes it inherits.
 *
 * `packages/core/src/index.ts:1` is `export * from '@guren/server'`, so a symbol
 * server removes is a symbol core removes, but `changeset version` only rewrites a
 * dependent's range and never promotes its bump type: server 2.0.0's RFC 0006
 * removals shipped as core **1.5.0**, a minor, through every `^1.4.0`. So a plan that
 * majors `@guren/server` must major `@guren/core`, judged from the pending
 * `.changeset/*.md` at the head of `version-packages`, the last moment before
 * `changeset version` deletes them. (In pre mode they survive, so the same scan keeps
 * flagging on every `rc`; `pre.json` is never read.)
 *
 * Not `fixed: [["@guren/server", "@guren/core"]]`, measured by running `changeset
 * version` against this workspace: a core-only major drags server to 3.0.0, and a
 * server-only patch moves core 1.6.2 -> 2.7.1, because a fixed group snaps to its
 * highest member. That crosses core's major line inside a release whose changelog
 * reads "Patch Changes", silently unfollowing every `^1.x` and tripping the plugins'
 * `gurenPlugin.compatibility: ">=1.0.0 <2.0.0"`. `fixed` is bidirectional; only one
 * of its directions is true.
 *
 * No escape hatch: a server major confined to `/mcp` or to names outside the
 * `lambda.ts`/`redis.ts` allowlists still asks for a core major; over-bumping costs one
 * deliberate revision, under-bumping is delivered silently by a caret. `@guren/orm` is
 * out of scope, being re-exported through an explicit named allowlist.
 *
 * Exit codes: 0 clean, 1 a plan that under-bumps core, 2 the gate could not run (an
 * unparseable changeset, or a `.changeset/` it cannot read); as in
 * `plugin-compat-audit.ts` and `dependency-audit.ts`, unavailable is a failure.
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

// As permissive as `@changesets/parse`'s real YAML: an empty block, `#` comments
// and a quoted bump are all legal changesets this gate must not refuse.
const FRONTMATTER = /^﻿?\s*---\r?\n((?:[\s\S]*?\r?\n)?)---/
const RELEASE_LINE = /^\s*(?:"([^"]*)"|'([^']*)'|([^:\s]+))\s*:\s*(\S+)\s*$/

export class ChangesetParseError extends Error {}

/**
 * Throws rather than skipping: a changeset this script cannot read is a release
 * plan it cannot judge, and "clean" over one is the silent pass to prevent.
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
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const release = RELEASE_LINE.exec(line)
    if (!release) {
      throw new ChangesetParseError(
        `${file}: frontmatter line ${JSON.stringify(line)} is not a \`"package": bump\` entry.`,
      )
    }
    const name = release[1] ?? release[2] ?? release[3]
    const bump = release[4].replace(/^["']|["']$/g, '').toLowerCase()
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

  // The loudest core bump in the plan, not the first read: naming `patch` while a
  // `minor` sits beside it describes the wrong release. `major` is absent because
  // the early return above already took it.
  const LOUDEST_FIRST = ['minor', 'patch', 'none'] as const
  const declared = LOUDEST_FIRST.find((bump) =>
    changesets.some((c) => c.releases.get(CORE) === bump),
  )
  const coreState =
    declared === undefined
      ? 'not bumped at all'
      : declared === 'none'
        ? 'explicitly held at `none`'
        : `only bumped \`${declared}\``

  return {
    code: 1,
    messages: [
      `core semver audit failed: this release majors ${SERVER} ` +
        `(${serverMajors.map((c) => c.file).join(', ')}) but ${CORE} is ${coreState}.`,
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
 * Never answers "empty plan" for a directory it could not read: `.changeset/` is
 * tracked, so a failure here is a broken path or a permission, and `[]` would
 * report the gate's own breakage as a clean bill of health at exit 0.
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
    // The underlying ENOENT/EACCES: "could not be read" names no actionable reason.
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
