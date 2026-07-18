import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

/**
 * AI agent harness installer.
 *
 * Copies the agent harness template (CLAUDE.md, .claude/rules, .claude/skills,
 * .claude/agents, .claude/hooks, .claude/settings.json, .mcp.json) into an app.
 *
 * Files fall into two groups:
 * - Managed: .claude/rules, .claude/skills, .claude/agents, .claude/hooks —
 *   owned by the framework, `agent:sync` overwrites them with the latest version.
 * - User-owned: CLAUDE.md, .mcp.json, .claude/settings.json — written once,
 *   never overwritten by `agent:sync` (only by `agent:init --force`).
 */

const templateDir = fileURLToPath(new URL('../templates/agent', import.meta.url))

const USER_OWNED_FILES = new Set(['CLAUDE.md', '.mcp.json', '.claude/settings.json'])

export type AgentHarnessMode = 'init' | 'sync'

export interface AgentHarnessOptions {
  cwd?: string
  mode?: AgentHarnessMode
  force?: boolean
}

export interface AgentHarnessResult {
  written: string[]
  skipped: string[]
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

async function collectTemplateFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectTemplateFiles(fullPath)))
    } else if (entry.isFile()) {
      files.push(fullPath)
    }
  }
  return files
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isFile()
  } catch {
    return false
  }
}

export async function installAgentHarness(options: AgentHarnessOptions = {}): Promise<AgentHarnessResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const mode = options.mode ?? 'init'
  const force = Boolean(options.force)
  const appTitle = await resolveAppTitle(cwd)

  const templateFiles = await collectTemplateFiles(templateDir)
  const written: string[] = []
  const skipped: string[] = []

  for (const sourcePath of templateFiles) {
    const relPath = relative(templateDir, sourcePath).replaceAll('\\', '/')
    const destPath = join(cwd, relPath)
    const userOwned = USER_OWNED_FILES.has(relPath)
    const exists = await fileExists(destPath)

    // sync refreshes managed files; existing user-owned files are only
    // replaced by an explicit init --force
    const overwrite = force || (mode === 'sync' && !userOwned)
    if (exists && !overwrite) {
      skipped.push(relPath)
      continue
    }

    const content = await readFile(sourcePath, 'utf8')
    const transformed = content.split('__APP_TITLE__').join(appTitle)
    await mkdir(dirname(destPath), { recursive: true })
    await writeFile(destPath, transformed, 'utf8')
    written.push(relPath)
  }

  return { written, skipped }
}
