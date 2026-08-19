import { lstat, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { fileExists, readIfExists, toPosixRelative } from './discovery'
import {
  DETECTABLE_COMPONENTS,
  componentsForTargets,
  managedNamespaces,
  normalizeComponents,
  planComponents,
  type AgentTarget,
  type HarnessComponent,
  type PlannedFile,
  type TemplateFiles,
} from './agent-targets'

/**
 * AI agent harness installer (RFC 0008).
 *
 * Renders the canonical harness template (`templates/agent/core` +
 * `templates/agent/targets`) into the per-agent files planned by
 * `agent-targets.ts` — Claude Code's `.claude/` tree, and the shared
 * `AGENTS.md` + `.agents/` family for Codex, Cursor, Copilot, and OpenCode.
 * The planner owns every path, content, and classification decision; this
 * module is the I/O half.
 *
 * Files fall into two groups:
 * - Managed (rules, skills, subagents, hooks) — owned by the framework,
 *   `agent:sync` overwrites them with the latest version.
 * - User-owned (CLAUDE.md, AGENTS.md, settings, MCP client configs) —
 *   written once, never overwritten by `agent:sync` (only by
 *   `agent:init --force`).
 */

const templateDir = fileURLToPath(new URL('../templates/agent', import.meta.url))

export type AgentHarnessMode = 'init' | 'sync'

export interface AgentHarnessOptions {
  cwd?: string
  mode?: AgentHarnessMode
  force?: boolean
  /**
   * Agent targets to install. Defaults to `['claude']` on init; on sync the
   * default is whatever components are already installed on disk.
   */
  targets?: AgentTarget[]
  /**
   * Sync only: delete the files reported in `stale` instead of just listing
   * them. Off by default because the managed namespaces can hold
   * user-authored files under colliding names — the report names every
   * candidate first, and deletion stays an explicit opt-in.
   */
  prune?: boolean
}

export interface AgentHarnessResult {
  written: string[]
  skipped: string[]
  /**
   * Sync only: files inside the framework-managed namespaces
   * (`managedNamespaces`) that the current plan no longer writes — what a
   * renamed or removed canonical rule/skill leaves behind, in every root it
   * fanned out to. Reported so the user can decide; deleted only with
   * `prune`. A user file under a colliding name lands here too, which is why
   * the default is report-only.
   */
  stale: string[]
  /** True when `prune` deleted the files listed in `stale` (always false without it). */
  pruned: boolean
  /**
   * True when the installed MCP client config points at an endpoint no script
   * in the app enables. The endpoint is opt-in via `GUREN_MCP=1`; apps
   * scaffolded before that landed have a `dev` script that never sets it, so
   * their agent config would silently fail to connect.
   */
  mcpEndpointNotEnabled: boolean
  /**
   * MCP client configs that already existed without the Guren endpoint.
   * Those files routinely carry unrelated user configuration (`opencode.json`,
   * `.codex/config.toml`, `.vscode/mcp.json`), so the installer never merges
   * into them — it reports the snippet to add by hand instead.
   */
  mcpMergeHints: Array<{ path: string; snippet: string }>
}

function toTitleCase(value: string): string {
  const words = value
    .replace(/^@[^/]+\//u, '')
    .replace(/[-_]+/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean)

  if (words.length === 0) {
    return 'Guren App'
  }

  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

async function resolveAppTitle(cwd: string): Promise<string> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { name?: string }
    if (pkg.name) {
      return toTitleCase(pkg.name)
    }
  } catch {
    // fall through to directory name
  }
  return toTitleCase(basename(cwd))
}

/**
 * Whether any npm script turns the MCP endpoint on.
 *
 * Unreadable or malformed `package.json` counts as "enabled" — staying quiet
 * beats nagging about a file we could not inspect.
 */
async function scriptsEnableMcp(cwd: string): Promise<boolean> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }
    return Object.values(pkg.scripts ?? {}).some((script) => script.includes('GUREN_MCP=1'))
  } catch {
    return true
  }
}

/** Load every file under `templates/agent` keyed by template-relative POSIX path. */
export async function loadAgentTemplates(): Promise<TemplateFiles> {
  const entries = await readdir(templateDir, { recursive: true, withFileTypes: true })
  const files: TemplateFiles = new Map()
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }
    const sourcePath = join(entry.parentPath, entry.name)
    files.set(toPosixRelative(templateDir, sourcePath), await readFile(sourcePath, 'utf8'))
  }
  return files
}

/**
 * Which harness components an app already has. The evidence is the plans
 * themselves: a component counts as installed when any of the managed files
 * `planComponents` would write for it exists on disk — detection can never
 * drift from the planner because it has no path knowledge of its own. A
 * user-authored file that happens to collide with a managed path is still
 * read as evidence (and `sync` would refresh it); that residual risk is
 * narrower than the pre-multi-agent behavior, which overwrote the managed
 * set unconditionally. A bare app with no evidence gets the Claude default,
 * preserving the long-standing "sync acts as install" behavior.
 */
async function detectInstalledComponents(
  cwd: string,
  templates: TemplateFiles,
): Promise<HarnessComponent[]> {
  const components: HarnessComponent[] = []
  for (const component of DETECTABLE_COMPONENTS) {
    const managed = planComponents([component], templates, 'App').filter((file) => file.managed)
    for (const file of managed) {
      if (await fileExists(cwd, file.path)) {
        components.push(component)
        break
      }
    }
  }
  if (components.length === 0) {
    components.push('claude')
  }
  // restore the install invariant (cursor/copilot imply the agents family),
  // so a deleted .agents/ tree is recreated rather than left dangling
  return normalizeComponents(components)
}

/**
 * Do two app-relative paths name the same file on disk? Only ever asked about
 * a pair that differs by case alone, where the path strings cannot answer it:
 * on a case-insensitive filesystem the two are one directory entry the write
 * loop has just refreshed through the casing it found, on a case-sensitive one
 * they are two files and the unplanned casing is a genuine leftover. `bigint`
 * because a Windows file ID is 64 bits and would not survive a `number` — two
 * distinct NTFS files could compare equal and spare a real leftover.
 *
 * A failed `lstat` leaves the two indistinguishable, so it answers "same": the
 * entry is left alone rather than deleted on a claim that could not be
 * established. Nothing is lost by that on the one plausible path — a directory
 * readable but not searchable lists its names and refuses to stat them, and
 * `rm` would be refused there too.
 */
async function isSameFile(cwd: string, left: string, right: string): Promise<boolean> {
  try {
    const [leftStat, rightStat] = await Promise.all([
      lstat(join(cwd, left), { bigint: true }),
      lstat(join(cwd, right), { bigint: true }),
    ])
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
  } catch {
    return true
  }
}

/**
 * Files inside the active components' managed namespaces that the current
 * plan does not write. Planned files (managed or user-owned) are excluded
 * via the full planned path set, so a future planner change cannot turn its
 * own output into a prune candidate. A scanned entry that matches a planned
 * path by case alone is settled by `isSameFile` rather than by string — every
 * planned path exists on disk once the write loop has run (it either wrote the
 * file or skipped it because it was already there), so the identity check has
 * both sides to compare.
 *
 * Exported for tests: `retiredSkills` defaults to `RETIRED_CANONICAL_SKILLS`,
 * which is empty, so the retired-name path has no other way to be exercised.
 * The seam belongs here rather than on `AgentHarnessOptions`, which is a
 * published type — a test hook there would outlive the reason for it.
 */
export async function findStaleManagedFiles(
  cwd: string,
  components: HarnessComponent[],
  plan: readonly PlannedFile[],
  retiredSkills?: readonly string[],
): Promise<string[]> {
  const plannedPaths = new Set(plan.map((file) => file.path))
  const plannedByLowerPath = new Map(plan.map((file) => [file.path.toLowerCase(), file.path]))
  const stale: string[] = []

  /**
   * Is every path component from `cwd` down to `dir` a real directory inside
   * the app? A claim is only safe over files that live there, and `lstat`
   * refuses to follow just the component it is given: lstat'ing
   * `.claude/skills/dev-workflow` says nothing about `.claude/skills`, which
   * a symlink would hand the walk as an ordinary external directory. So each
   * component is checked in turn, and a symlink anywhere along the way ends
   * the walk before `readdir` — and `rm` — can follow it.
   */
  const insideTheApp = async (dir: string): Promise<boolean> => {
    let current = cwd
    for (const segment of dir.split('/')) {
      current = join(current, segment)
      let info
      try {
        info = await lstat(current)
      } catch {
        return false // does not exist — nothing to clean
      }
      if (!info.isDirectory()) {
        return false
      }
    }
    return true
  }

  /**
   * One walk over one directory. `recursive` is the only knob: a `tree` and
   * each named child of a `children` claim walk their whole subtree; a
   * `pattern` looks only at the top level and only at framework-named files.
   */
  const walk = async (
    dir: string,
    recursive: boolean,
    accept: (entry: Dirent) => boolean,
  ): Promise<void> => {
    const root = join(cwd, dir)
    if (!(await insideTheApp(dir))) {
      return
    }
    let entries: Dirent[]
    try {
      entries = await readdir(root, { recursive, withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isFile() || !accept(entry)) {
        continue
      }
      const relPath = toPosixRelative(cwd, join(entry.parentPath, entry.name))
      if (plannedPaths.has(relPath)) {
        continue
      }
      const caseAlias = plannedByLowerPath.get(relPath.toLowerCase())
      if (caseAlias && (await isSameFile(cwd, relPath, caseAlias))) {
        continue
      }
      stale.push(relPath)
    }
  }

  const everything = (): boolean => true
  for (const namespace of managedNamespaces(components, plan, retiredSkills)) {
    switch (namespace.kind) {
      case 'tree':
        await walk(namespace.dir, true, everything)
        break
      case 'pattern':
        await walk(
          namespace.dir,
          false,
          (entry) => entry.name.startsWith(namespace.prefix) && entry.name.endsWith(namespace.suffix),
        )
        break
      case 'children':
        // only the named children are ever entered; a sibling directory
        // an external installer put there is not read, let alone claimed
        for (const name of namespace.names) {
          await walk(`${namespace.dir}/${name}`, true, everything)
        }
        break
    }
  }
  return stale.sort()
}

export async function installAgentHarness(options: AgentHarnessOptions = {}): Promise<AgentHarnessResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const mode = options.mode ?? 'init'
  const force = Boolean(options.force)
  const appTitle = await resolveAppTitle(cwd)
  const templates = await loadAgentTemplates()

  const components = options.targets
    ? componentsForTargets(options.targets)
    : mode === 'sync'
      ? await detectInstalledComponents(cwd, templates)
      : componentsForTargets(['claude'])

  const written: string[] = []
  const skipped: string[] = []
  const mcpMergeHints: AgentHarnessResult['mcpMergeHints'] = []

  const plan = planComponents(components, templates, appTitle)
  for (const file of plan) {
    const destPath = join(cwd, file.path)
    const exists = await fileExists(cwd, file.path)

    // sync refreshes managed files; existing user-owned files are only
    // replaced by an explicit init --force
    const overwrite = force || (mode === 'sync' && file.managed)
    if (exists && !overwrite) {
      skipped.push(file.path)
      // onboarding guidance, not a recurring nag — sync stays quiet about
      // configs the user has decided to keep without the Guren endpoint
      if (file.mergeMarker && mode === 'init') {
        const current = (await readIfExists(cwd, file.path)) ?? ''
        if (!current.includes(file.mergeMarker)) {
          mcpMergeHints.push({ path: file.path, snippet: file.content })
        }
      }
      continue
    }

    await mkdir(dirname(destPath), { recursive: true })
    await writeFile(destPath, file.content, 'utf8')
    written.push(file.path)
  }

  // Stale cleanup is a sync concern: init installs into places it has never
  // written, so "not in the plan" carries no leftover signal there.
  const stale =
    mode === 'sync' ? await findStaleManagedFiles(cwd, components, plan) : []
  const pruned = Boolean(options.prune) && stale.length > 0
  if (pruned) {
    for (const relPath of stale) {
      await rm(join(cwd, relPath), { force: true })
    }
    // sweep only what the deletions emptied: from each removed file, walk up
    // and rmdir until a directory refuses (still holds files) — pre-existing
    // empty directories elsewhere in a namespace are none of our business
    for (const startDir of new Set(stale.map((relPath) => dirname(relPath)))) {
      for (let dir = startDir; dir !== '.' && dir !== ''; dir = dirname(dir)) {
        try {
          await rmdir(join(cwd, dir))
        } catch {
          break
        }
      }
    }
  }

  return {
    written,
    skipped,
    stale,
    pruned,
    mcpEndpointNotEnabled: !(await scriptsEnableMcp(cwd)),
    mcpMergeHints,
  }
}
