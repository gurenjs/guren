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
  type RetiredNames,
  type TemplateFiles,
} from './agent-targets'

/**
 * AI agent harness installer (RFC 0008): the I/O half of `agent-targets.ts`, which
 * owns every path, content, and classification decision. Managed files (rules, skills,
 * subagents, hooks) are overwritten by `agent:sync`, never silently: a differing file
 * is reported in `replaced`, and `dryRun` answers what a sync would touch. User-owned
 * files (CLAUDE.md, AGENTS.md, settings, MCP configs) are replaced only by `agent:init --force`.
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
   * Sync only: delete the files reported in `stale`. Off by default because the
   * managed namespaces can hold user-authored files under colliding names.
   */
  prune?: boolean
  /** Report what the run would write, replace, and prune without touching the filesystem. */
  dryRun?: boolean
}

export interface AgentHarnessResult {
  /** Planned files written (or, under `dryRun`, that would be) — the delta, not the whole plan. */
  written: string[]
  /**
   * The subset of `written` that existed with different contents: where sync
   * discarded an older template version or a local edit, which nothing can tell apart.
   */
  replaced: string[]
  /** Planned files whose on-disk contents already matched — nothing written. */
  unchanged: string[]
  /**
   * The run's own parameters, echoed: `--prune --dry-run` is distinguishable
   * from a plain `--dry-run` only through `pruneRequested` (`pruned` is false in both).
   */
  mode: AgentHarnessMode
  /** True when `dryRun` held: nothing was written or deleted. */
  dryRun: boolean
  /** True when the run was asked to prune (whether or not anything was, or dryRun held). */
  pruneRequested: boolean
  skipped: string[]
  /**
   * Sync only: files inside `managedNamespaces` the current plan does not
   * write. Deleted only with `prune`, because a project's own file can land
   * here under a name the framework itself ships.
   */
  stale: string[]
  /** True when `prune` deleted the files listed in `stale` (always false without it). */
  pruned: boolean
  /**
   * True when the installed MCP client config points at an endpoint no script
   * enables. The endpoint is opt-in via `GUREN_MCP=1`, which apps scaffolded
   * before it landed never set, so their agent config silently fails to connect.
   */
  mcpEndpointNotEnabled: boolean
  /**
   * User-owned configs (MCP clients, stop hooks) that already existed without the
   * Guren entry. They routinely carry unrelated user configuration, so the installer
   * never merges into them — it reports the snippet to add by hand, and `what` it adds.
   */
  mergeHints: Array<{ path: string; snippet: string; what: string }>
}

/** `\r\n` → `\n`, for the up-to-date comparison in the write loop. */
function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
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
 * Whether any npm script turns the MCP endpoint on. An unreadable or malformed
 * `package.json` counts as enabled — better quiet than nagging about a file we
 * could not inspect.
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
 * Which harness components an app already has, evidenced by the plans
 * themselves: a component is installed when any managed file `planComponents`
 * would write for it exists, so detection cannot drift from the planner. A bare
 * app with no evidence gets the Claude default, so sync acts as install.
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
  return normalizeComponents(components)
}

/**
 * Only asked about a pair differing by case alone, which the path strings cannot
 * settle. `bigint` because a Windows file ID is 64 bits. ENOENT answers
 * "different" — under `dryRun` the planned side may not exist yet, which is when
 * a real `--prune` would report the leftover — while any other `lstat` failure
 * answers "same", leaving the entry alone rather than deleting it unproven.
 */
async function isSameFile(cwd: string, left: string, right: string): Promise<boolean> {
  const probe = (relPath: string) =>
    lstat(join(cwd, relPath), { bigint: true }).catch((error: unknown) =>
      (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? ('missing' as const) : ('unknown' as const),
    )
  const [leftStat, rightStat] = await Promise.all([probe(left), probe(right)])
  if (typeof leftStat !== 'string' && typeof rightStat !== 'string') {
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
  }
  return leftStat !== 'missing' && rightStat !== 'missing'
}

/**
 * Files inside the active components' managed namespaces that the plan does not
 * write. Planned paths are excluded wholesale, so a planner change cannot turn
 * its own output into a prune candidate; a match by case alone is `isSameFile`'s
 * call. `retired` is a test seam — it defaults to the tombstone constants, both
 * empty, so that path has no other way to be exercised.
 */
export async function findStaleManagedFiles(
  cwd: string,
  components: HarnessComponent[],
  plan: readonly PlannedFile[],
  retired: RetiredNames = {},
): Promise<string[]> {
  const plannedPaths = new Set(plan.map((file) => file.path))
  const plannedByLowerPath = new Map(plan.map((file) => [file.path.toLowerCase(), file.path]))
  const stale: string[] = []

  /**
   * Is every path component from `cwd` down to `dir` a real directory inside the
   * app? Each is checked in turn because lstat'ing the leaf says nothing about
   * its parents — a symlink anywhere along the way ends the walk before
   * `readdir`, and `rm`, can follow it out of the app.
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
  for (const namespace of managedNamespaces(components, plan, retired)) {
    switch (namespace.kind) {
      case 'files': {
        // Case-insensitive so a case-only rename is still reached; whether the
        // entry is a second file is `isSameFile`'s call. Top level only, so a
        // directory the project made under the rules root is never read.
        const claimed = new Set(namespace.names.map((name) => name.toLowerCase()))
        await walk(namespace.dir, false, (entry) => claimed.has(entry.name.toLowerCase()))
        break
      }
      case 'pattern':
        await walk(
          namespace.dir,
          false,
          (entry) => entry.name.startsWith(namespace.prefix) && entry.name.endsWith(namespace.suffix),
        )
        break
      case 'children':
        // Only named children are entered, so a directory an external installer
        // put beside them is never read, let alone claimed.
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
  const dryRun = Boolean(options.dryRun)
  const appTitle = await resolveAppTitle(cwd)
  const templates = await loadAgentTemplates()

  const components = options.targets
    ? componentsForTargets(options.targets)
    : mode === 'sync'
      ? await detectInstalledComponents(cwd, templates)
      : componentsForTargets(['claude'])

  const written: string[] = []
  const replaced: string[] = []
  const unchanged: string[] = []
  const skipped: string[] = []
  const mergeHints: AgentHarnessResult['mergeHints'] = []

  const plan = planComponents(components, templates, appTitle)
  for (const file of plan) {
    const destPath = join(cwd, file.path)
    const exists = await fileExists(cwd, file.path)

    // sync refreshes managed files; existing user-owned files are only
    // replaced by an explicit init --force
    const overwrite = force || (mode === 'sync' && file.managed)
    if (exists && !overwrite) {
      skipped.push(file.path)
      // Onboarding guidance, not a recurring nag: sync stays quiet about a
      // config the user has decided to keep without the Guren endpoint.
      if (file.merge && mode === 'init') {
        const current = (await readIfExists(cwd, file.path)) ?? ''
        if (!current.includes(file.merge.marker)) {
          mergeHints.push({ path: file.path, snippet: file.content, what: file.merge.hint })
        }
      }
      continue
    }

    // Not reported as a write, so `written` is the run's real delta and every
    // overwrite `replaced` names discarded something. An unreadable file counts
    // as differing; the write is where that failure surfaces. Line endings are
    // ignored: a CRLF-normalizing checkout would otherwise flag every managed
    // file as replaced on every sync.
    const existing = exists ? await readFile(destPath, 'utf8').catch(() => null) : null
    if (
      existing !== null &&
      (existing === file.content ||
        normalizeLineEndings(existing) === normalizeLineEndings(file.content))
    ) {
      unchanged.push(file.path)
      continue
    }

    if (!dryRun) {
      await mkdir(dirname(destPath), { recursive: true })
      await writeFile(destPath, file.content, 'utf8')
    }
    written.push(file.path)
    if (exists) {
      replaced.push(file.path)
    }
  }

  // Sync only: on init, "not in the plan" carries no leftover signal.
  const stale =
    mode === 'sync' ? await findStaleManagedFiles(cwd, components, plan) : []
  const pruned = Boolean(options.prune) && !dryRun && stale.length > 0
  if (pruned) {
    for (const relPath of stale) {
      await rm(join(cwd, relPath), { force: true })
    }
    // Sweep only what the deletions emptied: walk up until an rmdir refuses.
    // Pre-existing empty directories elsewhere are none of our business.
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
    replaced,
    unchanged,
    mode,
    dryRun,
    pruneRequested: Boolean(options.prune),
    skipped,
    stale,
    pruned,
    mcpEndpointNotEnabled: !(await scriptsEnableMcp(cwd)),
    mergeHints,
  }
}
