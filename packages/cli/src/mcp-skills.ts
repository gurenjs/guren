/**
 * The one reading of the skills an app publishes on its MCP endpoint (RFC 0042 §1.1, §1.2):
 * `resources/skills/<name>/` in the root, and `modules/<module>/resources/skills/<name>/` under the module's name.
 * A skill is a directory holding a top-level `SKILL.md`, and every regular file below it is published.
 * A dotfile, a symlink and a directory with no `SKILL.md` are not: none is something the author placed to be served.
 * `guren codegen` renders the result as `.guren/mcp-skills.gen.ts`, the module `mcpPlugin({ skills })` loads.
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { listAppRoots, readDirectory, MCP_SKILLS_DIR, toPosixRelative } from './discovery'
import { pathExists, resolveAppRoot, writeGeneratedFileIn, type WriterOptions } from './utils'

export const SKILL_MANIFEST = 'SKILL.md'
export const MCP_SKILLS_MODULE = '.guren/mcp-skills.gen.ts'

export interface DiscoveredSkillFile {
  /** The path under the skill namespace, `/`-separated: `refunds/references/policy.md`. */
  key: string
  file: string
}

export interface DiscoveredSkill {
  name: string
  module: string | null
  dir: string
  /** The skill's path under the namespace: `refunds`, or `billing/dunning` for a module's. */
  path: string
  /** Sorted by key, `SKILL.md` included. */
  files: DiscoveredSkillFile[]
}

export interface McpSkillsContent {
  skills: DiscoveredSkill[]
  files: Record<string, string>
  /** Files that are not valid UTF-8, as base64. */
  binary: Record<string, string>
  warnings: string[]
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

async function skillFiles(dir: string, prefix: string): Promise<DiscoveredSkillFile[]> {
  const found: DiscoveredSkillFile[] = []
  for (const entry of await readDirectory(dir)) {
    if (entry.name.startsWith('.')) continue
    const file = join(dir, entry.name)
    const key = `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...(await skillFiles(file, key)))
    else if (entry.isFile()) found.push({ key, file })
  }
  return found
}

/** Every skill of the app, the root's first and then each module's, each list in code-unit order. */
export async function discoverMcpSkills(appRoot: string): Promise<DiscoveredSkill[]> {
  const skills: DiscoveredSkill[] = []
  for (const root of await listAppRoots(appRoot)) {
    const skillsDir = resolve(root.dir, MCP_SKILLS_DIR)
    const names = (await readDirectory(skillsDir))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort(byCodeUnit)
    for (const name of names) {
      const dir = join(skillsDir, name)
      const path = root.module === null ? name : `${root.module}/${name}`
      const files = (await skillFiles(dir, path)).sort((a, b) => byCodeUnit(a.key, b.key))
      if (files.some((file) => file.key === `${path}/${SKILL_MANIFEST}`)) skills.push({ name, module: root.module, dir, path, files })
    }
  }
  return skills
}

/** The contents the generated module holds. A path two skills both give is published once, the first one's. */
export async function readMcpSkills(appRoot: string): Promise<McpSkillsContent> {
  const skills = await discoverMcpSkills(appRoot)
  const text = new Map<string, string>()
  const binary = new Map<string, string>()
  const sources = new Map<string, string>()
  const warnings: string[] = []

  for (const skill of skills) {
    for (const { key, file } of skill.files) {
      const taken = sources.get(key)
      if (taken !== undefined) {
        warnings.push(
          `${toPosixRelative(appRoot, file)} is not published: ${toPosixRelative(appRoot, taken)} already takes skill://${key}. `
          + 'A root skill may not carry the name of a module that has skills.',
        )
        continue
      }
      sources.set(key, file)
      const bytes = await readFile(file)
      const decoded = decodeUtf8(bytes)
      if (decoded === undefined) binary.set(key, bytes.toString('base64'))
      else text.set(key, decoded)
    }
  }

  return { skills, files: sorted(text), binary: sorted(binary), warnings }
}

function sorted(entries: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...entries].sort(([a], [b]) => byCodeUnit(a, b)))
}

/** `undefined` for bytes that are not UTF-8. A byte order mark is kept, as the endpoint serves the file's own bytes. */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function recordLiteral(entries: Readonly<Record<string, string>>): string {
  const lines = Object.entries(entries).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
  return lines.length === 0 ? '{}' : `{\n${lines.join('\n')}\n}`
}

export function renderMcpSkillsModule(content: Pick<McpSkillsContent, 'files' | 'binary'>): string {
  return `// Generated from ${MCP_SKILLS_DIR}/ (and modules/*/${MCP_SKILLS_DIR}/) — DO NOT EDIT
export const files: Readonly<Record<string, string>> = ${recordLiteral(content.files)}

/** Files that are not valid UTF-8, base64. */
export const binary: Readonly<Record<string, string>> = ${recordLiteral(content.binary)}
`
}

export interface GenerateMcpSkillsOptions extends WriterOptions {
  appRoot?: string
}

/**
 * Written once a skill exists and never removed after that: with the last skill gone it is rewritten
 * empty, so the `import()` an app's `mcpPlugin({ skills })` still names keeps resolving.
 */
export async function generateMcpSkills(
  options: GenerateMcpSkillsOptions = {},
): Promise<{ outputPath: string | null; skillCount: number; warnings: string[] }> {
  const appRoot = resolveAppRoot(options)
  const outputFile = resolve(appRoot, MCP_SKILLS_MODULE)
  const content = await readMcpSkills(appRoot)

  if (content.skills.length === 0 && !(await pathExists(outputFile))) {
    return { outputPath: null, skillCount: 0, warnings: content.warnings }
  }

  const outputPath = await writeGeneratedFileIn(appRoot, outputFile, renderMcpSkillsModule(content), { force: options.force })
  return { outputPath, skillCount: content.skills.length, warnings: content.warnings }
}
