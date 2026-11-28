/**
 * The one reading of the skills an app publishes on its MCP endpoint (RFC 0042 §1.1, §1.2):
 * `resources/skills/<name>/` in the root, and `modules/<module>/resources/skills/<name>/` under the module's name.
 * A skill is a directory holding a regular `SKILL.md` at its top, and every regular file below it is published.
 * No symlink is followed, the skills directory's own included, and no dotfile is read.
 * `guren codegen` renders the result as `.guren/mcp-skills.gen.ts`, the module `mcpPlugin({ skills })` loads.
 */
import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { appDependsOn, FileDiscoveryError, listAppRoots, MCP_SKILLS_DIR, readDirectory, toPosixRelative } from './discovery'
import { MCP_PLUGIN_EXPORT, pluginCallFiles } from './plugin-calls'
import { pathExists, resolveAppRoot, writeGeneratedFileIn, type WriterOptions } from './utils'

export const SKILL_MANIFEST = 'SKILL.md'
export const MCP_SKILLS_MODULE = '.guren/mcp-skills.gen.ts'
/** What an app's `import()` of the generated module names, whatever alias or relative path leads to it. */
const MCP_SKILLS_MODULE_STEM = 'mcp-skills.gen'

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

async function isOwnDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw new FileDiscoveryError(path, error)
  }
}

async function filesBelow(dir: string, prefix: string): Promise<DiscoveredSkillFile[]> {
  const found: DiscoveredSkillFile[] = []
  for (const entry of await readDirectory(dir)) {
    if (entry.name.startsWith('.')) continue
    const file = join(dir, entry.name)
    const key = `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...(await filesBelow(file, key)))
    else if (entry.isFile()) found.push({ key, file })
  }
  return found
}

/**
 * Every skill of the app, the root's first and then each module's by name. A directory with no `SKILL.md`
 * is never descended into, so nothing below it can fail the read; one spelled in another case is named in `warnings`.
 */
export async function discoverMcpSkills(appRoot: string, warnings: string[] = []): Promise<DiscoveredSkill[]> {
  const roots = (await listAppRoots(appRoot)).sort((a, b) => byCodeUnit(a.module ?? '', b.module ?? ''))
  const skills: DiscoveredSkill[] = []
  for (const root of roots) {
    const skillsDir = resolve(root.dir, MCP_SKILLS_DIR)
    if (!(await isOwnDirectory(skillsDir))) continue
    const names = (await readDirectory(skillsDir))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort(byCodeUnit)
    for (const name of names) {
      const dir = join(skillsDir, name)
      const top = await readDirectory(dir)
      if (!top.some((entry) => entry.isFile() && entry.name === SKILL_MANIFEST)) {
        const misnamed = top.find((entry) => entry.isFile() && entry.name.toLowerCase() === SKILL_MANIFEST.toLowerCase())
        if (misnamed) {
          warnings.push(`${toPosixRelative(appRoot, join(dir, misnamed.name))} is not published: a skill's manifest is named ${SKILL_MANIFEST}, in that case.`)
        }
        continue
      }
      const path = root.module === null ? name : `${root.module}/${name}`
      const files = (await filesBelow(dir, path)).sort((a, b) => byCodeUnit(a.key, b.key))
      skills.push({ name, module: root.module, dir, path, files })
    }
  }
  return skills
}

/**
 * Each `SKILL.md` key that sits below another skill's directory, with that skill's own manifest key.
 * The endpoint refuses such a module at boot, where one skill's files would belong to two.
 */
export function nestedSkillManifests(keys: Iterable<string>): Array<{ inner: string; outer: string }> {
  const suffix = `/${SKILL_MANIFEST}`
  const manifests = [...keys].filter((key) => key.endsWith(suffix))
  const skillDirs = new Set(manifests.map((key) => key.slice(0, -suffix.length)))
  const nested: Array<{ inner: string; outer: string }> = []
  for (const inner of manifests) {
    const segments = inner.slice(0, -suffix.length).split('/')
    for (let depth = segments.length - 1; depth > 0; depth -= 1) {
      const parent = segments.slice(0, depth).join('/')
      if (!skillDirs.has(parent)) continue
      nested.push({ inner, outer: `${parent}${suffix}` })
      break
    }
  }
  return nested
}

/** The contents the generated module holds. A path two skills both give is published once, the first one's. */
export async function readMcpSkills(appRoot: string): Promise<McpSkillsContent> {
  const warnings: string[] = []
  const skills = await discoverMcpSkills(appRoot, warnings)
  const text = new Map<string, string>()
  const binary = new Map<string, string>()
  const sources = new Map<string, string>()

  for (const skill of skills) {
    for (const { key, file } of skill.files) {
      const taken = sources.get(key)
      if (taken !== undefined) {
        warnings.push(`${toPosixRelative(appRoot, file)} is not published: ${toPosixRelative(appRoot, taken)} already takes skill://${key}.`)
        continue
      }
      sources.set(key, file)
      const bytes = await readFile(file)
      const decoded = decodeUtf8(bytes)
      if (decoded === undefined) binary.set(key, bytes.toString('base64'))
      else text.set(key, decoded)
    }
  }

  const source = (key: string): string => toPosixRelative(appRoot, sources.get(key)!)
  for (const { inner, outer } of nestedSkillManifests(sources.keys())) {
    warnings.push(
      `${source(inner)} sits inside the skill ${source(outer)}, and the MCP endpoint refuses a nested skill at boot. `
      + 'Move it out, or rename a root skill that carries the name of a module with skills.',
    )
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

/**
 * Whether app source names the generated module. Its `import()` has to resolve on a checkout with no skill
 * and no `.guren/` yet, so such an app gets the module, empty. Read as text: a comment naming it costs one empty file.
 */
async function appImportsSkillsModule(appRoot: string): Promise<boolean> {
  // Every codegen run reaches this in an app with no skill, so the manifest gates the source read.
  if ((await appDependsOn(appRoot, MCP_PLUGIN_EXPORT.specifier)) !== true) return false
  for (const file of await pluginCallFiles(appRoot)) {
    if ((await readFile(file, 'utf8')).includes(MCP_SKILLS_MODULE_STEM)) return true
  }
  return false
}

export interface GenerateMcpSkillsOptions extends WriterOptions {
  appRoot?: string
}

/**
 * Written for an app that has a skill, that imports the module, or that already holds the file, and never
 * removed: with no skill it is written empty, so the `import()` in `mcpPlugin({ skills })` keeps resolving.
 */
export async function generateMcpSkills(
  options: GenerateMcpSkillsOptions = {},
): Promise<{ outputPath: string | null; skillCount: number; warnings: string[] }> {
  const appRoot = resolveAppRoot(options)
  const outputFile = resolve(appRoot, MCP_SKILLS_MODULE)
  const content = await readMcpSkills(appRoot)

  if (content.skills.length === 0 && !(await pathExists(outputFile)) && !(await appImportsSkillsModule(appRoot))) {
    return { outputPath: null, skillCount: 0, warnings: content.warnings }
  }

  const outputPath = await writeGeneratedFileIn(appRoot, outputFile, renderMcpSkillsModule(content), { force: options.force })
  return { outputPath, skillCount: content.skills.length, warnings: content.warnings }
}
