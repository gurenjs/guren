import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { fileExists } from './discovery'

/**
 * AI agent harness installer.
 *
 * Copies the agent harness template (CLAUDE.md, .claude/rules, .claude/skills,
 * .claude/agents, .claude/hooks, .claude/settings.json, .mcp.json) into an app.
 *
 * Files fall into two groups:
 * - Managed: files under MANAGED_PREFIXES — owned by the framework,
 *   `agent:sync` overwrites them with the latest version.
 * - User-owned: everything else (CLAUDE.md, .mcp.json, .claude/settings.json,
 *   and any future top-level template file) — written once, never overwritten
 *   by `agent:sync` (only by `agent:init --force`).
 */

const templateDir = fileURLToPath(new URL('../templates/agent', import.meta.url))

const MANAGED_PREFIXES = ['.claude/rules/', '.claude/skills/', '.claude/agents/', '.claude/hooks/']

export type AgentHarnessMode = 'init' | 'sync'

export interface AgentHarnessOptions {
  cwd?: string
  mode?: AgentHarnessMode
  force?: boolean
}

export interface AgentHarnessResult {
  written: string[]
  skipped: string[]
  /**
   * True when the installed `.mcp.json` points at an endpoint no script in the
   * app enables. The endpoint is opt-in via `GUREN_MCP=1`; apps scaffolded
   * before that landed have a `dev` script that never sets it, so their agent
   * config would silently fail to connect.
   */
  mcpEndpointNotEnabled: boolean
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

export async function installAgentHarness(options: AgentHarnessOptions = {}): Promise<AgentHarnessResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const mode = options.mode ?? 'init'
  const force = Boolean(options.force)
  const appTitle = await resolveAppTitle(cwd)

  const entries = await readdir(templateDir, { recursive: true, withFileTypes: true })
  const written: string[] = []
  const skipped: string[] = []

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }
    const sourcePath = join(entry.parentPath, entry.name)
    const relPath = relative(templateDir, sourcePath).replaceAll('\\', '/')
    const destPath = join(cwd, relPath)
    const managed = MANAGED_PREFIXES.some((prefix) => relPath.startsWith(prefix))
    const exists = await fileExists(cwd, relPath)

    // sync refreshes managed files; existing user-owned files are only
    // replaced by an explicit init --force
    const overwrite = force || (mode === 'sync' && managed)
    if (exists && !overwrite) {
      skipped.push(relPath)
      continue
    }

    const content = await readFile(sourcePath, 'utf8')
    const transformed = content.replaceAll('__APP_TITLE__', appTitle)
    await mkdir(dirname(destPath), { recursive: true })
    await writeFile(destPath, transformed, 'utf8')
    written.push(relPath)
  }

  return { written, skipped, mcpEndpointNotEnabled: !(await scriptsEnableMcp(cwd)) }
}
