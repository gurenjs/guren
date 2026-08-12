import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { fileExists } from './discovery'
import {
  componentsForTargets,
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
}

export interface AgentHarnessResult {
  written: string[]
  skipped: string[]
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
   * `.codex/config.toml`), so the installer never merges into them — it
   * reports the snippet to add by hand instead.
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

async function loadTemplates(): Promise<TemplateFiles> {
  const entries = await readdir(templateDir, { recursive: true, withFileTypes: true })
  const files: TemplateFiles = new Map()
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }
    const sourcePath = join(entry.parentPath, entry.name)
    const relPath = relative(templateDir, sourcePath).replaceAll('\\', '/')
    files.set(relPath, await readFile(sourcePath, 'utf8'))
  }
  return files
}

/**
 * Which harness components an app already has, judged by positive evidence of
 * framework-managed artifacts — never by files other tools also create
 * (`AGENTS.md` exists in plenty of repos that never ran `agent:init`, so its
 * presence proves nothing). A bare app with no evidence gets the Claude
 * default, preserving the long-standing "sync acts as install" behavior.
 */
async function dirHasGurenFiles(cwd: string, dir: string, suffix: string): Promise<boolean> {
  try {
    const names = await readdir(join(cwd, dir))
    return names.some((name) => name.startsWith('guren-') && name.endsWith(suffix))
  } catch {
    return false
  }
}

async function detectInstalledComponents(cwd: string): Promise<HarnessComponent[]> {
  const components: HarnessComponent[] = []
  if (await fileExists(cwd, '.claude/rules')) {
    components.push('claude')
  }
  if (await fileExists(cwd, '.agents/rules')) {
    components.push('agents')
  }
  if (await dirHasGurenFiles(cwd, '.cursor/rules', '.mdc')) {
    components.push('cursor')
  }
  if (await dirHasGurenFiles(cwd, '.github/instructions', '.instructions.md')) {
    components.push('copilot')
  }
  if (components.length === 0) {
    components.push('claude')
  }
  return components
}

export async function installAgentHarness(options: AgentHarnessOptions = {}): Promise<AgentHarnessResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const mode = options.mode ?? 'init'
  const force = Boolean(options.force)
  const appTitle = await resolveAppTitle(cwd)

  const components = options.targets
    ? componentsForTargets(options.targets)
    : mode === 'sync'
      ? await detectInstalledComponents(cwd)
      : componentsForTargets(['claude'])

  const templates = await loadTemplates()
  const written: string[] = []
  const skipped: string[] = []
  const mcpMergeHints: AgentHarnessResult['mcpMergeHints'] = []

  for (const file of planComponents(components, templates)) {
    const destPath = join(cwd, file.path)
    const content = file.content.replaceAll('__APP_TITLE__', appTitle)
    const exists = await fileExists(cwd, file.path)

    // sync refreshes managed files; existing user-owned files are only
    // replaced by an explicit init --force
    const overwrite = force || (mode === 'sync' && file.managed)
    if (exists && !overwrite) {
      skipped.push(file.path)
      // onboarding guidance, not a recurring nag — sync stays quiet about
      // configs the user has decided to keep without the Guren endpoint
      if (file.mergeHint && mode === 'init') {
        const current = await readFile(destPath, 'utf8').catch(() => '')
        if (!current.includes('_guren/mcp')) {
          mcpMergeHints.push({ path: file.path, snippet: content })
        }
      }
      continue
    }

    await mkdir(dirname(destPath), { recursive: true })
    await writeFile(destPath, content, 'utf8')
    written.push(file.path)
  }

  return {
    written,
    skipped,
    mcpEndpointNotEnabled: !(await scriptsEnableMcp(cwd)),
    mcpMergeHints,
  }
}
