import { mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
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
  /** The subset of `stale` that `prune: true` deleted. */
  pruned: string[]
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
 * Files inside the active components' managed namespaces that the current
 * plan does not write. Planned-but-user-owned files (none live in a
 * namespace today) are excluded via the full planned path set, so a future
 * planner change cannot turn its own output into a prune candidate.
 */
async function findStaleManagedFiles(
  cwd: string,
  components: HarnessComponent[],
  plannedPaths: ReadonlySet<string>,
): Promise<string[]> {
  const stale: string[] = []
  for (const namespace of managedNamespaces(components)) {
    let entries: Dirent[]
    try {
      entries = await readdir(join(cwd, namespace.dir), {
        recursive: namespace.recursive,
        withFileTypes: true,
      })
    } catch {
      continue // namespace directory does not exist — nothing to clean
    }
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue
      }
      if (
        namespace.fileName &&
        !(entry.name.startsWith(namespace.fileName.prefix) && entry.name.endsWith(namespace.fileName.suffix))
      ) {
        continue
      }
      const relPath = toPosixRelative(cwd, join(entry.parentPath, entry.name))
      if (!plannedPaths.has(relPath)) {
        stale.push(relPath)
      }
    }
  }
  return stale.sort()
}

/** Depth-first removal of directories pruning emptied (rmdir refuses non-empty ones). */
async function removeEmptiedDirs(dir: string): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await removeEmptiedDirs(join(dir, entry.name))
    }
  }
  try {
    await rmdir(dir)
  } catch {
    // still holds files — keep it
  }
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
    mode === 'sync'
      ? await findStaleManagedFiles(cwd, components, new Set(plan.map((file) => file.path)))
      : []
  const pruned: string[] = []
  if (options.prune && stale.length > 0) {
    for (const relPath of stale) {
      await rm(join(cwd, relPath), { force: true })
      pruned.push(relPath)
    }
    for (const namespace of managedNamespaces(components)) {
      if (pruned.some((relPath) => relPath.startsWith(`${namespace.dir}/`))) {
        await removeEmptiedDirs(join(cwd, namespace.dir))
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
