import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { consola } from 'consola'

import type { WriterOptions } from './utils'
import { assertCwdUnsupported, safeModuleName, slugifyProse, writeScaffoldFile } from './utils'
import {
  discoverControllerFiles,
  discoverResourceFiles,
  discoverPolicyFiles,
  classNameFromPath,
  toPosixRelative,
  moduleNameFromRelPath,
} from './discovery'
import { discoverParsedModels } from './model-parser'
import { runGit } from './changed-files'

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
  /**
   * OKF actor for `generated.by` (§7): `human:<id>`, `process:<id>`, or
   * `<producer>/<version>` for agents. Defaults to the git author as
   * `human:<user.name>`; when neither is available the scaffold omits
   * `generated` entirely (a concept with just `type` is conformant).
   */
  by?: string
}

interface AdrPrefill {
  entities: string[]
  related: string[]
}

const EMPTY_PREFILL: AdrPrefill = { entities: [], related: [] }

/**
 * Entity names are class identifiers, and they are interpolated into the
 * frontmatter unquoted — anything beyond identifier characters could
 * inject frontmatter keys (`]`, newlines, `#`, quotes), so it is rejected
 * outright rather than escaped.
 */
const ENTITY_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/

/**
 * Prefill for `--entity`: the canonical class name plus the entity's
 * companion files (from the same location as the resolved model) as
 * `related:` entries. A model that doesn't exist yet is prefilled as
 * given — ADR-first flows write the decision before the code, and
 * `guren check --docs` failing until the model lands is the intended
 * "implementation missing" signal.
 */
async function resolveAdrPrefill(entity: string, moduleName?: string): Promise<AdrPrefill> {
  if (!ENTITY_NAME_RE.test(entity)) {
    throw new Error(
      `Invalid entity name "${entity}" — it is written into YAML frontmatter, so it must be a plain class identifier (letters, digits, underscores).`,
    )
  }

  const cwd = process.cwd()
  const lower = entity.toLowerCase()
  const matches = (await discoverParsedModels(cwd))
    .filter((model) => model.info.className.toLowerCase() === lower)
    .map((model) => ({ className: model.info.className, module: model.module }))

  // A module ADR prefers that module's model; a root ADR prefers the root
  // model. Only when neither preference resolves a name tie is it ambiguous.
  const preferredModule = moduleName ?? null
  const match =
    matches.find((m) => m.module === preferredModule)
    ?? (matches.length === 1 ? matches[0] : undefined)

  if (!match) {
    if (matches.length > 1) {
      const locations = matches.map((m) => m.module ?? 'app').sort()
      throw new Error(
        `Model "${entity}" exists in multiple locations: ${locations.join(', ')}. Pass --module <name> to target that module's model (and docs/adr).`,
      )
    }
    consola.warn(
      `Model "${entity}" not found — prefilled entities anyway; \`guren check --docs\` will fail until the model exists.`,
    )
    return { entities: [entity], related: [] }
  }

  // Companions come from the resolved model's own location, so a module
  // entity never links a same-named root controller (and vice versa).
  const companions: Array<[(root: string) => Promise<string[]>, string]> = [
    [discoverControllerFiles, `${match.className}Controller`],
    [discoverResourceFiles, `${match.className}Resource`],
    [discoverPolicyFiles, `${match.className}Policy`],
  ]
  const related = (
    await Promise.all(
      companions.map(async ([discover, companionName]) => {
        const files = (await discover(cwd)).map((file) => toPosixRelative(cwd, file))
        return files.find(
          (file) =>
            classNameFromPath(file) === companionName
            && moduleNameFromRelPath(file) === match.module,
        )
      }),
    )
  ).filter((file): file is string => file !== undefined)

  return { entities: [match.className], related }
}

/**
 * The actor is written into a double-quoted YAML scalar, so only what
 * could break that scalar is rejected — quotes, backslashes, newlines.
 * Shape questions (OKF §7) are `guren check --docs`'s to warn about,
 * and git author names are not ASCII, so no character allowlist here.
 */
const ACTOR_RE = /^[^"\\\r\n]+$/

/** The git author as an OKF `human:<id>` actor, or null when unavailable. */
async function gitAuthorActor(): Promise<string | null> {
  const [name] = (await runGit(process.cwd(), ['config', 'user.name'])) ?? []
  if (name === undefined) return null
  return ACTOR_RE.test(`human:${name}`) ? `human:${name}` : null
}

async function resolveActor(by?: string): Promise<string | null> {
  if (by !== undefined) {
    if (!ACTOR_RE.test(by)) {
      throw new Error(
        `Invalid actor "${by}" — it is written into a quoted YAML scalar, so it cannot contain quotes, backslashes, or newlines.`,
      )
    }
    return by
  }
  return gitAuthorActor()
}

function adrTemplate(title: string, actor: string | null, generatedAt: string, prefill: AdrPrefill): string {
  const entities =
    prefill.entities.length > 0 ? `entities: [${prefill.entities.join(', ')}]` : 'entities: []'
  const related =
    prefill.related.length > 0
      ? `related:\n${prefill.related.map((path) => `  - ${path}`).join('\n')}`
      : 'related: []'
  // Quoted: an actor may legitimately contain `: ` (a git author like
  // "Ada: Admin"), which would otherwise make the flow mapping invalid
  // YAML. ACTOR_RE already excludes quotes, so no escaping is needed.
  const generated = actor === null ? '' : `\ngenerated: { by: "${actor}", at: ${generatedAt} }`

  return `---
type: adr
status: draft
${entities}
${related}${generated}
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

export async function makeAdr(title: string, options: MakeAdrOptions = {}): Promise<string> {
  assertCwdUnsupported(options, 'make:adr')
  const moduleName = options.root ? safeModuleName(options.root) : undefined
  const dir = moduleName ? `modules/${moduleName}/${ADR_DIR}` : ADR_DIR
  const [prefill, actor] = await Promise.all([
    options.entity ? resolveAdrPrefill(options.entity, moduleName) : EMPTY_PREFILL,
    resolveActor(options.by),
  ])
  const sequence = await nextSequenceNumber(dir)

  return writeScaffoldFile(
    `${dir}/${sequence}-${adrSlug(title)}.md`,
    adrTemplate(title.trim(), actor, new Date().toISOString(), prefill),
    options,
  )
}
